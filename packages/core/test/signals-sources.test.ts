// GTM-agents: the signal and scale sources: news, hiring boards, websets, monitors, lookalikes,
// coverage fill and the intent score. Each writes candidates that still go through promotion, or
// signals that carry a date and a URL. Every company, person and headline is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { seedContact } from "../src/outreach/testing.ts";
import { intentAllowsFirstTouch, intentScore } from "../src/scoring/intent.ts";
import { runIntentScoring } from "../src/scoring/intent.ts";
import { runCoverageFill } from "../src/signals/coverage.ts";
import { runHiringBoards } from "../src/signals/hiring.ts";
import { createSignalJobs } from "../src/signals/jobs.ts";
import { runLookalikes } from "../src/signals/lookalikes.ts";
import { drainMonitorItems, handleMonitorWebhook, type MonitorConfig } from "../src/signals/monitors.ts";
import { fundingSeverity, matchAccount, readsAs, runNewsSignals } from "../src/signals/news.ts";
import { recordSignal } from "../src/signals/record.ts";
import { runWebsets } from "../src/signals/websets.ts";
import { loadSourcingBrain } from "../src/sourcing/brain.ts";
import { promoteStage } from "../src/sourcing/promote.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { acmeConfig } from "./fixtures.ts";
import { defineConfig } from "../src/config/index.ts";
import { fakePeople, fakeVerifier, flagsOf, person, silentLog, stageContext, uploadBrain } from "./sourcing-fakes.ts";
import { NOW, accountCandidate, daysAgo, fakeBoards, fakeNews, fakeSimilar, fakeWebsets, newSignal, resetSignalTables, seedAccount } from "./signals-fakes.ts";

const db = env.DB;
const gate = (cap = 100) => createSpendGate({ db, flags: flagsOf(), job: "signals_test", jobCapCents: cap });

beforeEach(async () => {
  await resetSignalTables(db);
  await uploadBrain(env.KV);
});

describe("funding and leadership news", () => {
  const accounts = [
    { accountKey: "brightloop.example", name: "Brightloop Labs" },
    { accountKey: "acme-funding.example", name: "Acme Funding" },
    { accountKey: "quill.example", name: "Quill" },
  ];

  it("matches a title to exactly one known account, then reads the rest as the category", () => {
    const m = matchAccount("Brightloop Labs raises $20M Series B to fix flaky CI", accounts);
    expect(m?.account.accountKey).toBe("brightloop.example");
    expect(readsAs("funding", m?.rest ?? "")).toBe(true);
    // The account's own name is not evidence of funding.
    const own = matchAccount("Acme Funding launches a podcast", accounts);
    expect(own?.account.accountKey).toBe("acme-funding.example");
    expect(readsAs("funding", own?.rest ?? "")).toBe(false);
    // Two different accounts named: ambiguous, skipped.
    expect(matchAccount("Quill and Brightloop Labs partner", accounts)).toBeNull();
    expect(readsAs("leadership", "appoints Jane Doe as new CTO")).toBe(true);
    expect(readsAs("leadership", "ships a new CTO dashboard")).toBe(false);
  });

  it("scales funding severity with the round, below the auto-draft line", () => {
    expect(fundingSeverity("raises seed round")).toBe(0.6);
    expect(fundingSeverity("raises Series A")).toBe(0.61);
    expect(fundingSeverity("raises Series B")).toBe(0.62);
    expect(fundingSeverity("raises Series F")).toBe(0.64);
  });

  it("records a signal only for a dated hit with a URL at a known account", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    await seedAccount(db, "lowfit.example", "Lowfit Corp", { score: 2 });
    const source = fakeNews((text) =>
      text.includes("funding")
        ? [
            { title: "Brightloop Labs raises $20M Series B", url: "https://news.example/a", publishedAt: daysAgo(5), providerRef: "n1" },
            { title: "Brightloop Labs raises seed round", url: "https://news.example/b", providerRef: "n2" },
            { title: "Brightloop Labs raises Series C", url: "https://news.example/c", publishedAt: daysAgo(45), providerRef: "n3" },
            { title: "Lowfit Corp raises Series A", url: "https://news.example/d", publishedAt: daysAgo(2), providerRef: "n4" },
            { title: "Unknown Startup raises Series A", url: "https://news.example/e", publishedAt: daysAgo(2), providerRef: "n5" },
          ]
        : [{ title: "Brightloop Labs appoints new CTO", url: "https://news.example/f", publishedAt: daysAgo(1), providerRef: "n6" }],
    );
    const stats = await runNewsSignals({ db, source, gate: gate(), now: NOW, log: silentLog });
    expect(stats.searches).toBe(4);
    const { results } = await db.prepare("SELECT type, source_url, severity, evidence, event_date FROM signal_events ORDER BY source_url").all<Record<string, unknown>>();
    expect(results.map((r) => r.source_url)).toEqual(["https://news.example/a", "https://news.example/f"]);
    expect(results[0]).toMatchObject({ type: "funding", severity: 0.62 });
    expect(results[1]).toMatchObject({ type: "news" });
    expect((JSON.parse(String(results[1]?.evidence)) as { category?: string }).category).toBe("leadership");
    expect(source.calls.every((c) => c.since === daysAgo(30))).toBe(true);
  });

  it("stops at the spend cap", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    const stats = await runNewsSignals({ db, source: fakeNews([], 10), gate: createSpendGate({ db, flags: flagsOf({ "budget:job:signals_test:daily_cents": "0" }), job: "signals_test", jobCapCents: 0 }), now: NOW, log: silentLog });
    expect(stats.searches).toBe(0);
    expect(stats.budgetStopped).toBe(true);
  });
});

describe("hiring boards", () => {
  it("keeps role-kind counts, never titles, and signals once per 90 days", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    await seedAccount(db, "dull.example", "Dull Co", { score: 4 });
    const boards = fakeBoards({
      brightloop: { greenhouse: { status: "found", counts: { engineering: 3, sales: 1, other: 2 }, total: 6, latestPostedAt: daysAgo(4), boardUrl: "https://boards.greenhouse.io/brightloop" } },
    });
    const first = await runHiringBoards({ db, source: boards, now: NOW, log: silentLog });
    expect(first).toMatchObject({ accounts: 1, boards: 1, signals: 1 });
    expect(boards.calls.map((c) => c.token)).toEqual(["brightloop", "brightloop", "brightloop"]);
    const { results: roles } = await db.prepare("SELECT role, open_count FROM account_hiring_roles ORDER BY role").all<{ role: string; open_count: number }>();
    expect(roles).toEqual([
      { role: "engineering", open_count: 3 },
      { role: "other", open_count: 2 },
      { role: "sales", open_count: 1 },
    ]);
    const signal = await db.prepare("SELECT type, source, headline, evidence, source_url, event_date FROM signal_events").first<Record<string, string>>();
    expect(signal).toMatchObject({ type: "hiring", source: "hiring_board", source_url: "https://boards.greenhouse.io/brightloop", event_date: daysAgo(4) });
    expect((JSON.parse(signal?.evidence ?? "{}") as { role_counts?: unknown }).role_counts).toEqual({ engineering: 3, sales: 1 });

    // A week later the board is read again but no second signal is written within 90 days.
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    const second = await runHiringBoards({ db, source: boards, now: later, log: silentLog });
    expect(second).toMatchObject({ accounts: 1, signals: 0 });
    expect(boards.calls.slice(3)).toEqual([{ board: "greenhouse", token: "brightloop" }]);
  });

  it("writes no signal without a posting date", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    const boards = fakeBoards({ brightloop: { lever: { status: "found", counts: { engineering: 9 }, total: 9, boardUrl: "https://jobs.lever.co/brightloop" } } });
    expect((await runHiringBoards({ db, source: boards, now: NOW, log: silentLog })).signals).toBe(0);
  });
});

describe("websets", () => {
  it("creates one webset per spec a week, and inserts items qualified only with a clean work address", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    const brain = await loadSourcingBrain(env.KV);
    const source = fakeWebsets([
      { kind: "person", name: "Sam Lee", title: "VP Engineering", accountName: "Brightloop Labs", email: "sam.lee@brightloop.example", evidence: [], providerRef: "w1" },
      { kind: "person", name: "Ira Park", title: "Staff Engineer", accountName: "Brightloop Labs", evidence: [], providerRef: "w2" },
      { kind: "person", name: "Off Domain", title: "CTO", email: "off@elsewhere.example", evidence: [], providerRef: "w3" },
      { kind: "person", name: "No Company", title: "CTO", evidence: [], providerRef: "w4" },
    ]);
    const specs = [{ query: "engineering leaders at software companies with flaky CI", count: 25 }];
    const stats = await runWebsets({ db, source, specs, brain, gate: gate(), now: NOW, maxRows: 200, itemUsd: 0.09, maxReserveUsd: 10, log: silentLog });
    expect(stats).toMatchObject({ created: 1, polled: 1, qualified: 1, inserted: 1, rejected: 2 });
    const { results } = await db.prepare("SELECT source_ref, status, email, qualification_score, query_id, account_key FROM candidates ORDER BY source_ref").all<Record<string, unknown>>();
    expect(results.find((r) => r.source_ref === "webset:w1")).toMatchObject({ status: "qualified", email: "sam.lee@brightloop.example", qualification_score: 0.6 });
    expect(results.find((r) => r.source_ref === "webset:w2")).toMatchObject({ status: "raw", email: null });
    // The address's domain never stands in for the company.
    expect(results.find((r) => r.source_ref === "webset:w3")).toMatchObject({ status: "rejected", email: null, account_key: null });
    expect(results.find((r) => r.source_ref === "webset:w4")).toMatchObject({ status: "rejected" });
    const reasons = await db.prepare("SELECT source_ref, json_extract(attributes, '$.reject_reason') AS reason FROM candidates WHERE status = 'rejected' ORDER BY source_ref").all();
    expect(reasons.results).toEqual([
      { source_ref: "webset:w3", reason: "no_domain" },
      { source_ref: "webset:w4", reason: "no_domain" },
    ]);
    const query = await db.prepare("SELECT is_active, search_type, provider_ref, total_results FROM discovery_queries WHERE id = ?1").bind(results[0]?.query_id).first();
    expect(query).toMatchObject({ is_active: 0, search_type: "webset", provider_ref: "ws_1", total_results: 2 });

    const again = await runWebsets({ db, source, specs, brain, gate: gate(), now: new Date(NOW.getTime() + 86_400_000), maxRows: 200, itemUsd: 0.09, maxReserveUsd: 10, log: silentLog });
    expect(again.created).toBe(0);
    expect(again.duplicates).toBe(4);
  });

  it("rejects a webset item at an account scored below the fit floor", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "lowfit.example", "Lowfit Corp", { score: 2 });
    const source = fakeWebsets([{ kind: "person", name: "Sam Lee", title: "VP Engineering", accountName: "Lowfit Corp", email: "sam@lowfit.example", evidence: [], providerRef: "w1" }]);
    await runWebsets({ db, source, specs: [{ query: "q", count: 5 }], brain, gate: gate(), now: NOW, maxRows: 10, itemUsd: 0.09, maxReserveUsd: 10, log: silentLog });
    expect(await db.prepare("SELECT status, json_extract(attributes, '$.reject_reason') AS reason FROM candidates").first()).toMatchObject({ status: "rejected", reason: "low_fit" });
  });

  it("reserves the worst case before creating, lowering the count to what the cap allows", async () => {
    const brain = await loadSourcingBrain(env.KV);
    const source = fakeWebsets([]);
    const stats = await runWebsets({ db, source, specs: [{ query: "a", count: 100 }, { query: "b", count: 100 }], brain, gate: gate(), now: NOW, maxRows: 10, itemUsd: 0.09, maxReserveUsd: 2, log: silentLog });
    expect(source.created.map((q) => q.limit)).toEqual([22]);
    expect(stats.budgetStopped).toBe(true);
    const cost = await db.prepare("SELECT capability, cost_micro_cents FROM cost_events").first<{ capability: string; cost_micro_cents: number }>();
    expect(cost?.capability).toBe("webset_reserve");
    expect(cost?.cost_micro_cents).toBe(Math.round(22 * 0.09 * 1_000_000));
  });

  it("keeps the poll point when the row cap stops a poll, so paid-for items are read again", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    const items = ["Ada One", "Ben Two", "Cy Three"].map((name, i) => ({ kind: "person" as const, name, title: "VP Engineering", accountName: "Brightloop Labs", evidence: [], providerRef: `w${i}` }));
    const source = fakeWebsets(items);
    await runWebsets({ db, source, specs: [{ query: "q", count: 5 }], brain, gate: gate(), now: NOW, maxRows: 2, itemUsd: 0.09, maxReserveUsd: 10, log: silentLog });
    expect((await db.prepare("SELECT last_run_at FROM discovery_queries WHERE search_type = 'webset'").first<{ last_run_at: string | null }>())?.last_run_at).toBeNull();
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await runWebsets({ db, source, specs: [{ query: "q", count: 5 }], brain, gate: gate(), now: later, maxRows: 10, itemUsd: 0.09, maxReserveUsd: 10, log: silentLog });
    expect(second).toMatchObject({ inserted: 1, duplicates: 2 });
    expect((await db.prepare("SELECT last_run_at FROM discovery_queries WHERE search_type = 'webset'").first<{ last_run_at: string }>())?.last_run_at).toBe(later.toISOString());
  });

  it("a qualified webset row still passes every promotion check", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    const source = fakeWebsets([
      { kind: "person", name: "Sam Lee", title: "VP Engineering", accountName: "Brightloop Labs", email: "sam.lee@brightloop.example", evidence: [], providerRef: "w1" },
      { kind: "person", name: "Office Person", title: "Office Manager", accountName: "Brightloop Labs", email: "office.person@brightloop.example", evidence: [], providerRef: "w2" },
    ]);
    await runWebsets({ db, source, specs: [{ query: "q", count: 5 }], brain, gate: gate(), now: NOW, maxRows: 10, itemUsd: 0.09, maxReserveUsd: 10, log: silentLog });
    // A signal found before the account had contacts is held at the account...
    expect((await recordSignal(db, newSignal("brightloop.example"), NOW)).status).toBe("recorded");
    const ctx = await stageContext(db, env.KV, { now: NOW });
    const stats = await promoteStage(ctx, 10, { policy: "strict", verifier: fakeVerifier("v") });
    expect(stats.promoted).toBe(1);
    expect(stats.rejected).toBe(1);
    const contact = await db.prepare("SELECT id, discovery_query_id FROM contacts WHERE email = 'sam.lee@brightloop.example'").first<{ id: string; discovery_query_id: string }>();
    expect(contact?.discovery_query_id).toMatch(/^webset_/);
    // ...and carried to the contact promoted there.
    const carried = await db.prepare("SELECT type, event_date FROM signal_events WHERE contact_id = ?1").bind(contact?.id).first();
    expect(carried).toMatchObject({ type: "funding", event_date: daysAgo(3) });
  });
});

describe("search monitors", () => {
  const monitors: MonitorConfig[] = [{ key: "ci-pain", provider: "data-exa", secretName: "MONITOR_SECRET_CI_PAIN", description: "companies writing about flaky CI", results: "company_sites" }];
  const deps = (flags: Record<string, string>, verified = true) => ({
    db,
    flags: flagsOf(flags),
    monitors,
    secret: (name: string) => (name === "MONITOR_SECRET_CI_PAIN" ? "s".repeat(48) : undefined),
    verify: async () => verified,
    parse: (body: unknown) => ((body as { results?: Array<{ id: string; url: string; title?: string }> }).results ?? []).map((r) => ({ providerRef: r.id, url: r.url, ...(r.title ? { title: r.title } : {}) })),
    now: NOW,
  });
  const delivery = (results: unknown[]) => new Request("https://agent.example/api/webhooks/search/ci-pain", { method: "POST", body: JSON.stringify({ results }) });

  it("verifies before recording, records nothing while off, and dedupes on result id and URL", async () => {
    const hits = [
      { id: "r1", url: "https://quillstack.example/blog/ci", title: "Quillstack on CI" },
      { id: "r1", url: "https://quillstack.example/blog/ci", title: "duplicate id" },
      { id: "r2", url: "https://quillstack.example/blog/ci" },
      { id: "r3", url: "javascript:alert(1)" },
      { id: "r4", url: "https://tidewater.example/" },
    ];
    expect((await handleMonitorWebhook(delivery(hits), "ci-pain", deps({ "signals:monitors_enabled": "true" }, false))).status).toBe(401);
    expect((await handleMonitorWebhook(delivery(hits), "unknown", deps({ "signals:monitors_enabled": "true" }))).status).toBe(404);
    expect((await handleMonitorWebhook(delivery(hits), "ci-pain", deps({}))).status).toBe(503);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM monitor_items").first<{ n: number }>())?.n).toBe(0);
    const ok = await handleMonitorWebhook(delivery(hits), "ci-pain", deps({ "signals:monitors_enabled": "true" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ stored: 2 });

    const brain = await loadSourcingBrain(env.KV);
    const drained = await drainMonitorItems({ db, monitors, brain, now: NOW, limit: 500, log: silentLog });
    expect(drained).toMatchObject({ processed: 2, inserted: 2 });
    const { results } = await db.prepare("SELECT account_key, status, query_id FROM candidates ORDER BY account_key").all<Record<string, unknown>>();
    expect(results.map((r) => r.account_key)).toEqual(["quillstack.example", "tidewater.example"]);
    expect(results.every((r) => r.status === "raw" && typeof r.query_id === "string")).toBe(true);
    expect((await drainMonitorItems({ db, monitors, brain, now: NOW, limit: 500, log: silentLog })).processed).toBe(0);
  });
});

describe("a monitor of articles", () => {
  it("never turns a publisher into an account", async () => {
    const brain = await loadSourcingBrain(env.KV);
    const monitors: MonitorConfig[] = [{ key: "news", provider: "data-exa", secretName: "MONITOR_SECRET_NEWS", description: "articles", results: "articles" }];
    await db.prepare("INSERT INTO monitor_items (id, provider, monitor_id, url, result_id, payload, created_at) VALUES ('m1', 'data-exa', 'news', 'https://news.example/story', 'r1', '{}', ?1)").bind(NOW.toISOString()).run();
    const drained = await drainMonitorItems({ db, monitors, brain, now: NOW, limit: 10, log: silentLog });
    expect(drained).toMatchObject({ processed: 1, skipped: 1, inserted: 0 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM candidates").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("responder lookalikes", () => {
  it("seeds from accounts that responded and skips labelled, known, recent and low-fit accounts", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", warmth: "contacted" });
    await db
      .prepare("INSERT INTO outreach_sends (id, contact_id, account_key, send_path, sequence_step, channel, provider, recipient_domain, sent_at, positive_reply_at, created_at) VALUES ('s1', ?1, 'brightloop.example', 'cold', 1, 'email', 'test', 'brightloop.example', ?2, ?3, ?2)")
      .bind(id, daysAgo(20), daysAgo(18))
      .run();
    await seedAccount(db, "known.example", "Known Co");
    await db.prepare("INSERT INTO account_fit (account_key, prescore, status, fit_score, created_at, updated_at) VALUES ('lowfit.example', 10, 'scored', 2, ?1, ?1)").bind(daysAgo(5)).run();
    await db.prepare("INSERT INTO candidates (id, source, source_ref, account_key, status, created_at, updated_at) VALUES ('c-recent', 'x', 'x1', 'recent.example', 'rejected', ?1, ?1)").bind(daysAgo(10)).run();
    const similar = fakeSimilar({
      "brightloop.example": ["quillstack.example", "known.example", "lowfit.example", "recent.example", "globex.example", "brightloop.example"].map((d) => accountCandidate(d.split(".")[0] ?? d, d)),
    });
    const stats = await runLookalikes({ db, source: similar, brain, gate: gate(), now: NOW, maxRows: 30, log: silentLog });
    expect(stats).toMatchObject({ seeds: 1, searches: 1, inserted: 1 });
    expect(similar.calls[0]?.excludeDomains).toContain("globex.example");
    const { results } = await db.prepare("SELECT account_key, status, query_id FROM candidates WHERE source = 'fake-similar'").all<Record<string, unknown>>();
    expect(results).toEqual([expect.objectContaining({ account_key: "quillstack.example", status: "raw" })]);
  });
});

describe("coverage fill", () => {
  it("fills up to two people at a fit-7 account with one seat and a recent signal, then cools down for 30 days", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    await seedAccount(db, "quiet.example", "Quiet Co", { score: 9 });
    await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example" });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    const people = fakePeople("fake-people", {
      "brightloop.example": [
        person("Ada", "One", "VP Engineering", "brightloop.example", "ada@brightloop.example"),
        person("Ben", "Two", "Head of Engineering", "brightloop.example", "ben@brightloop.example"),
        person("Cy", "Three", "Staff Engineer", "brightloop.example"),
        person("Dee", "Four", "Principal Engineer", "brightloop.example"),
      ],
    });
    const stats = await runCoverageFill({ db, people, brain, gate: gate(), now: NOW, maxRows: 10, log: silentLog });
    expect(stats).toMatchObject({ eligible: 1, claimed: 1, inserted: 2 });
    const { results } = await db.prepare("SELECT first_name, status, email FROM candidates ORDER BY first_name").all<Record<string, unknown>>();
    expect(results.map((r) => r.first_name)).toEqual(["Ben", "Cy"]);
    expect(results.every((r) => r.status === "raw")).toBe(true);
    const again = await runCoverageFill({ db, people, brain, gate: gate(), now: new Date(NOW.getTime() + 10 * 86_400_000), maxRows: 10, log: silentLog });
    expect(again.claimed).toBe(0);
  });
});

describe("coverage fill on a failed lookup", () => {
  it("gives the claim back, so the account is not locked out for 30 days", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    const failing = { name: "failing-people", searchPeople: async () => Promise.reject(new Error("provider down")), matchPerson: async () => ({ record: null }) };
    const stats = await runCoverageFill({ db, people: failing, brain, gate: gate(), now: NOW, maxRows: 10, log: silentLog });
    expect(stats).toMatchObject({ claimed: 0, errors: 1 });
    expect(await db.prepare("SELECT 1 FROM resource_claims WHERE account_key = 'brightloop.example'").first()).toBeNull();
  });
});

describe("the intent score", () => {
  it("adds fit, title, a fresh signal and the angle, and bands the total", () => {
    const top = intentScore({ fitScore: 9, prescore: null, titleRank: 7, signal: { severity: 0.65, eventDate: daysAgo(3), givesAngle: true }, now: NOW });
    expect(top.components).toEqual({ fit: 27, title: 20, signal: 22.8, angle: 15 });
    expect(top.band).toBe("first_touch");
    const none = intentScore({ fitScore: null, prescore: 50, titleRank: 0, signal: null, now: NOW });
    expect(none).toMatchObject({ score: 12, band: "none" });
  });

  it("filters nothing while shadow, and fails closed when enforced", () => {
    expect(intentAllowsFirstTouch(null, false)).toBe(true);
    expect(intentAllowsFirstTouch(null, true)).toBe(false);
    expect(intentAllowsFirstTouch("{not json", true)).toBe(false);
    expect(intentAllowsFirstTouch(JSON.stringify({ intent: { band: "first_touch" } }), true)).toBe(true);
    expect(intentAllowsFirstTouch(JSON.stringify({ intent: { band: "nurture" } }), true)).toBe(false);
  });

  it("writes the score into cold contacts' attributes", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 9 });
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", title: "VP Engineering", attributes: { team: "platform" } });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    expect(await runIntentScoring({ db, brain, now: NOW, limit: 100 })).toBe(1);
    const row = await db.prepare("SELECT attributes FROM contacts WHERE id = ?1").bind(id).first<{ attributes: string }>();
    const attrs = JSON.parse(row?.attributes ?? "{}") as { team: string; intent: { score: number; band: string } };
    expect(attrs.team).toBe("platform");
    expect(attrs.intent.score).toBeGreaterThan(70);
  });
});

describe("intent scoring rotation", () => {
  it("scores the never-scored and least recently scored contacts first", async () => {
    const brain = await loadSourcingBrain(env.KV);
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 9 });
    const a = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example" });
    const b = await seedContact(db, { first: "Ben", last: "Two", email: "ben@brightloop.example" });
    expect(await runIntentScoring({ db, brain, now: NOW, limit: 1 })).toBe(1);
    expect(await runIntentScoring({ db, brain, now: new Date(NOW.getTime() + 1000), limit: 1 })).toBe(1);
    const at = async (id: string) => (JSON.parse((await db.prepare("SELECT attributes FROM contacts WHERE id = ?1").bind(id).first<{ attributes: string }>())?.attributes ?? "{}") as { intent?: { at: string } }).intent?.at;
    expect([await at(a), await at(b)].filter(Boolean)).toHaveLength(2);
  });
});

describe("the signal jobs", () => {
  it("register with named-day schedules and do nothing while their flags are off", async () => {
    const jobs = createSignalJobs({ adapters: () => ({ news: fakeNews([]), boards: fakeBoards({}), similar: fakeSimilar({}), discovery: fakeWebsets([]), people: fakePeople("p", {}) }) });
    expect(jobs.map((j) => j.name)).toEqual(["signal_websets", "signal_monitor_drain", "signal_news", "signal_hiring_boards", "signal_lookalikes", "signal_coverage_fill", "intent_scoring"]);
    for (const job of jobs) {
      expect(job.flag).toMatch(/^(signals|scoring):/);
      expect(job.ceilings.maxRows).toBeGreaterThan(0);
      const result = await job.run({ env: { DB: db, KV: env.KV }, config: defineConfig(acmeConfig), job: job.name, now: NOW, signal: new AbortController().signal, ceilings: job.ceilings, flags: flagsOf(), log: silentLog });
      expect(result).toEqual({ summary: "flag off" });
    }
  });
});
