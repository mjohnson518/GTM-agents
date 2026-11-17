// GTM-agents: tests for the account and competitor watches, research in prep briefs and the watch
// commands (docs/SIGNALS.md#account-watch). Every company, article, person and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv } from "../src/agents/testing.ts";
import { BRAIN_LOCK_KEY, brainFileKey } from "../src/brain/load.ts";
import { computeLock } from "../src/brain/lock.ts";
import { COMPONENT_SCHEMAS } from "../src/brain/schema.ts";
import { loadContactBrief, renderPrepBrief } from "../src/convert/brief.ts";
import { FLAGS } from "../src/flags/registry.ts";
import type { OperatorChannel } from "../src/ports/operator.ts";
import { seedContact } from "../src/outreach/testing.ts";
import { replyTestConfig } from "../src/replies/testing.ts";
import { proposalNote, runCompetitorWatch } from "../src/signals/competitors.ts";
import { SIGNAL_FLAGS } from "../src/signals/flags.ts";
import { createSignalJobs } from "../src/signals/jobs.ts";
import type { NewsHit } from "../src/signals/ports.ts";
import { watchCommands } from "../src/signals/watch-commands.ts";
import { firstSighting, isoWeek, runAccountWatch, settleSightings, watchedAccounts } from "../src/signals/watch.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { brainFile } from "./fixtures.ts";
import { DAY_MS, NOW, daysAgo, fakeBoards, fakeNews, resetSignalTables, seedAccount } from "./signals-fakes.ts";
import { fakeModel, flagsOf, silentLog } from "./sourcing-fakes.ts";

const db = env.DB;
const MODEL = "test-strategist-model";
const config = replyTestConfig({ models: { roles: { strategist: MODEL }, pricing: { [MODEL]: { inputCentsPerMTok: 1, outputCentsPerMTok: 1 } } } });
const gate = (job = "signal_account_watch", cap = 50, now = NOW) => createSpendGate({ db, flags: flagsOf(), job, jobCapCents: cap, now: () => now });

function operator(): OperatorChannel & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notify(message: { text: string }) {
      sent.push(message.text);
      return Promise.resolve({ messageId: `m${sent.length}` });
    },
  } as unknown as OperatorChannel & { sent: string[] };
}

const hit = (title: string, url: string, publishedAt = daysAgo(2)): NewsHit => ({ title, url, publishedAt, providerRef: url });

async function pin(key: string): Promise<void> {
  await db.prepare("UPDATE accounts SET attributes = json_set(attributes, '$.watch', json('true')) WHERE account_key = ?1").bind(key).run();
}

const COMPETITORS = [
  "## globex-test-insights",
  "- name: Globex Test Insights",
  "- positioning: A broad CI analytics dashboard covering build times and test results.",
  "- differentiators: Acme quarantines flaky tests, while dashboards only report them.",
  "- domain: globex.example",
  "",
  "## initech-ci-analytics",
  "- name: Initech CI Analytics",
  "- positioning: An add-on to a single CI vendor that flags slow and failing tests.",
  "- differentiators: Acme works across CI providers.",
  "",
].join("\n");

async function brainKv(competitors = COMPETITORS) {
  const files = { competitors: brainFile("competitors", competitors) };
  const kv = memoryKv();
  for (const [component, content] of Object.entries(files)) await kv.put(brainFileKey(component as never), content);
  await kv.put(BRAIN_LOCK_KEY, JSON.stringify(await computeLock(Object.entries(files).map(([c, content]) => ({ name: `${c}.md`, content })))));
  return kv;
}

beforeEach(async () => {
  await resetSignalTables(db);
  await db.batch([db.prepare("DELETE FROM event_effects"), db.prepare("DELETE FROM deals"), db.prepare("DELETE FROM learnings_proposals"), db.prepare("DELETE FROM account_facts")]);
});

describe("account watch: the gate", () => {
  it("a new funding article about a watched account appears once in the digest and once as a signal, and never again", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    await pin("brightloop.example");
    const news = fakeNews([
      hit("Brightloop Labs raises $20M Series B to fix flaky tests", "https://news.example/brightloop-series-b"),
      hit("Initech Systems hires a new CFO", "https://news.example/initech-cfo"),
    ]);
    const op = operator();
    const first = await runAccountWatch({ db, source: news, gate: gate(), now: NOW, log: silentLog, operator: op });
    expect(first).toMatchObject({ accounts: 1, searches: 1, items: 1, signals: 1, digest: "sent" });
    expect(news.calls[0]).toMatchObject({ text: "Brightloop Labs", since: new Date(NOW.getTime() - 7 * DAY_MS).toISOString() });
    expect(op.sent).toHaveLength(1);
    expect(op.sent[0]).toContain(`Account watch, ${isoWeek(NOW)}`);
    expect(op.sent[0]).toContain("Brightloop Labs raises $20M Series B to fix flaky tests");
    expect(op.sent[0]).toContain("https://news.example/brightloop-series-b");
    expect(op.sent[0]).not.toContain("Initech");
    const signals = await db.prepare("SELECT type, source, account_key FROM signal_events").all<Record<string, string>>();
    expect(signals.results).toEqual([{ type: "funding", source: "account_watch", account_key: "brightloop.example" }]);

    // The same week again: no second digest. The next week, the same article: listed nowhere, no new signal.
    expect(await runAccountWatch({ db, source: news, gate: gate(), now: NOW, log: silentLog, operator: op })).toMatchObject({ searches: 0, digest: "already_sent" });
    expect(news.calls).toHaveLength(1);
    const nextWeek = new Date(NOW.getTime() + 5 * DAY_MS);
    const later = await runAccountWatch({ db, source: news, gate: gate("signal_account_watch", 50, nextWeek), now: nextWeek, log: silentLog, operator: op });
    expect(later).toMatchObject({ items: 0, signals: 0, digest: "sent" });
    expect(op.sent[1]).toContain("Nothing new this week.");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM signal_events").first<{ n: number }>())?.n).toBe(1);
  });
});

describe("account watch: selection and limits", () => {
  it("covers pinned accounts, then open deals past contacted, then the best fit, at most 10", async () => {
    await seedAccount(db, "fit-one.example", "Fitone Analytics", { score: 9 });
    await seedAccount(db, "deal-one.example", "Dealone Robotics", { score: 2 });
    await seedAccount(db, "pin-one.example", "Pinone Systems");
    await seedAccount(db, "cold-one.example", "Coldone Software", { score: 6 });
    await seedAccount(db, "late-deal.example", "Latedeal Networks");
    await pin("pin-one.example");
    await db.prepare("INSERT INTO deals (id, account_key, name, stage) VALUES ('d1', 'deal-one.example', 'Pilot', 'proposal'), ('d2', 'late-deal.example', 'Intro', 'contacted')").run();
    for (let i = 0; i < 12; i++) await seedAccount(db, `bulk-${i}.example`, `Bulkcompany${i} Inc`, { score: 8 });
    const watched = await watchedAccounts(db);
    expect(watched).toHaveLength(10);
    expect(watched.slice(0, 3).map((a) => [a.accountKey, a.reason])).toEqual([
      ["pin-one.example", "pinned"],
      ["deal-one.example", "deal"],
      ["fit-one.example", "fit"],
    ]);
    expect(watched.map((a) => a.accountKey)).not.toContain("late-deal.example");
    expect(watched.map((a) => a.accountKey)).not.toContain("cold-one.example");
  });

  it("keeps only dated items in the window that name the account", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    await pin("brightloop.example");
    const news = fakeNews([
      hit("Brightloop Labs opens a London office", "https://news.example/a"),
      hit("Brightloop Labs ships v2", "https://news.example/old", daysAgo(9)),
      { title: "Brightloop Labs podcast", url: "https://news.example/undated", providerRef: "u" },
      hit("Contoso buys a startup", "https://news.example/contoso"),
      hit("Brightloop Labs and Brightloop Labs again", "ftp://news.example/bad"),
    ]);
    const r = await runAccountWatch({ db, source: news, gate: gate(), now: NOW, log: silentLog, operator: operator() });
    expect(r.items).toBe(1);
    expect(r.signals).toBe(0);
  });

  it("stops searching when the spend gate refuses", async () => {
    for (let i = 0; i < 3; i++) {
      await seedAccount(db, `acct-${i}.example`, `Accountname${i} Systems`);
      await pin(`acct-${i}.example`);
    }
    const news = fakeNews([], 0.3);
    const r = await runAccountWatch({ db, source: news, gate: gate("signal_account_watch", 50), now: NOW, log: silentLog, operator: operator() });
    expect(r.budgetStopped).toBe(true);
    expect(news.calls.length).toBeLessThan(3);
  });

  it("releases the week's items when the digest cannot be sent, so the next run lists them", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    await pin("brightloop.example");
    const news = fakeNews([hit("Brightloop Labs opens a London office", "https://news.example/london")]);
    const run = (operator: OperatorChannel | undefined) => runAccountWatch({ db, source: news, gate: gate(), now: NOW, log: silentLog, operator });
    expect(await run(undefined)).toMatchObject({ items: 1, digest: "no_channel" });
    const broken = { notify: () => Promise.reject(new Error("channel down")) } as unknown as OperatorChannel;
    expect(await run(broken)).toMatchObject({ items: 1, digest: "failed" });
    const op = operator();
    expect(await run(op)).toMatchObject({ items: 1, digest: "sent" });
    expect(op.sent[0]).toContain("Brightloop Labs opens a London office");
  });

  it("gives claims back unless the digest went, including when a concurrent run sent it first", async () => {
    for (const status of ["already_sent", "failed", "no_channel"] as const) {
      const key = await firstSighting(db, "race.example", `https://news.example/${status}`);
      if (!key) throw new Error("not claimed");
      await settleSightings(db, status, [key]);
      expect(await firstSighting(db, "race.example", `https://news.example/${status}`), status).toBe(key);
    }
    const sent = await firstSighting(db, "race.example", "https://news.example/sent");
    await settleSightings(db, "sent", sent ? [sent] : []);
    expect(await firstSighting(db, "race.example", "https://news.example/sent")).toBeNull();
  });

  it("gives its claims back when the run fails on a database error", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    await pin("brightloop.example");
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop) as unknown;
        return (sql: string) => {
          if (/signal_events/i.test(sql)) throw new Error("database unavailable");
          return target.prepare(sql);
        };
      },
    });
    const news = fakeNews([hit("Brightloop Labs raises $20M Series B", "https://news.example/brightloop-b")]);
    await expect(runAccountWatch({ db: failing, source: news, gate: gate(), now: NOW, log: silentLog, operator: operator() })).rejects.toThrow("database unavailable");
    expect(await firstSighting(db, "brightloop.example", "https://news.example/brightloop-b")).not.toBeNull();
  });

  it("lists at most 5 items an account a week, and claims only those", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    await pin("brightloop.example");
    const news = fakeNews(Array.from({ length: 7 }, (_, i) => hit(`Brightloop Labs story ${i}`, `https://news.example/story-${i}`)));
    const op = operator();
    expect(await runAccountWatch({ db, source: news, gate: gate(), now: NOW, log: silentLog, operator: op })).toMatchObject({ items: 5, digest: "sent" });
    expect(op.sent[0]?.match(/^- /gm)).toHaveLength(5);
    const claims = await db.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE event_id LIKE 'watch:brightloop.example:%'").first<{ n: number }>();
    expect(claims?.n).toBe(5);
  });
});

describe("competitor watch", () => {
  const competitorGate = () => gate("signal_competitor_watch", 100);
  const globexNews = () => fakeNews((text) => (text === "Globex Test Insights" ? [hit("Globex Test Insights adds automatic test retries", "https://news.example/globex-retries")] : [hit("Contoso raises a seed round", "https://news.example/contoso")]));
  const proposalAnswer = JSON.stringify({
    rationale: "Globex now retries failed tests, so the difference is quarantine rather than detection.",
    items: [{ id: "globex-test-insights", fields: { name: "Globex Test Insights", positioning: "A CI analytics dashboard that now retries failed tests automatically.", differentiators: "Acme quarantines flaky tests instead of retrying them, so they stop blocking releases." } }],
  });

  it("a week proposes at most one brain edit, which stays pending until a person approves it", async () => {
    const kv = await brainKv();
    const op = operator();
    const model = fakeModel(proposalAnswer, MODEL);
    const boards = fakeBoards({ globex: { lever: { status: "found", counts: { engineering: 12, sales: 4 }, total: 16 } } });
    const input = { db, kv, news: globexNews(), boards, gate: competitorGate(), now: NOW, log: silentLog, operator: op, proposals: true, model, config };
    const r = await runCompetitorWatch(input);
    expect(r).toMatchObject({ competitors: 2, searches: 2, items: 1, boards: 1, proposal: { status: "made" }, digest: "sent" });
    const proposals = await db.prepare("SELECT kind, status, proposed_by, payload FROM learnings_proposals").all<Record<string, string>>();
    expect(proposals.results).toHaveLength(1);
    expect(proposals.results[0]).toMatchObject({ kind: "brain", status: "pending", proposed_by: "competitor_watch" });
    expect(JSON.parse(proposals.results[0]?.payload ?? "{}")).toMatchObject({ component: "competitors" });
    expect(op.sent[0]).toContain("Globex Test Insights adds automatic test retries");
    expect(op.sent[0]).toContain("16 open roles on lever (engineering 12, sales 4)");
    expect(op.sent[0]).toMatch(/learning-show [a-z0-9]+/);
    // The proposed file keeps the operator's domain; the served brain is unchanged: nothing applied.
    const proposed = JSON.parse(proposals.results[0]?.payload ?? "{}") as { content: string };
    expect(proposed.content).toContain("now retries failed tests automatically");
    expect(proposed.content).toContain("- domain: globex.example");
    expect(await kv.get(brainFileKey("competitors"))).toContain("A broad CI analytics dashboard");
    // A rerun the same week whose digest has gone searches nothing. Even past that (the digest's claim
    // removed), a new article makes no second call and no second proposal.
    const again = await runCompetitorWatch({ ...input, gate: competitorGate() });
    expect(again).toMatchObject({ searches: 0, items: 0, digest: "already_sent" });
    await db.prepare("DELETE FROM event_effects WHERE event_id LIKE 'report:competitor_watch:%'").run();
    const fresh = fakeNews((text) => (text === "Globex Test Insights" ? [hit("Globex Test Insights launches a flaky test report", "https://news.example/globex-report")] : []));
    const rerun = await runCompetitorWatch({ ...input, news: fresh, gate: competitorGate() });
    expect(rerun.items).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM learnings_proposals").first<{ n: number }>())?.n).toBe(1);
  });

  it("refuses an edit with a link, a figure the brain lacks, or more than three changes, and makes no call without news", async () => {
    const bad = [
      { positioning: "See https://globex.example/pricing for the new plans." },
      { positioning: "Globex now charges 49 dollars a seat." },
    ];
    for (const [n, fields] of bad.entries()) {
      await db.prepare("DELETE FROM event_effects").run();
      const answer = JSON.stringify({ rationale: "x", items: [{ id: "globex-test-insights", fields: { name: "Globex Test Insights", differentiators: "Acme quarantines flaky tests.", ...fields } }] });
      const r = await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model: fakeModel(answer, MODEL), config });
      expect(r.proposal.status, `${n}: ${JSON.stringify(fields)}`).toBe("refused");
    }
    const tooMany = JSON.stringify({ rationale: "x", items: Array.from({ length: 4 }, (_, i) => ({ id: `new-${i}`, fields: { name: `New ${i}`, positioning: "A rival.", differentiators: "Acme is different." } })) });
    await db.prepare("DELETE FROM event_effects").run();
    const many = await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model: fakeModel(tooMany, MODEL), config });
    expect(many.proposal.status).toBe("refused");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM learnings_proposals").first<{ n: number }>())?.n).toBe(0);

    await db.prepare("DELETE FROM event_effects").run();
    const quiet = fakeModel(proposalAnswer, MODEL);
    const none = await runCompetitorWatch({ db, kv: await brainKv(), news: fakeNews([]), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model: quiet, config });
    expect(none.proposal.status).toBe("none");
    expect(quiet.requests).toHaveLength(0);
  });

  it("a returned item changes only the fields it names, and a note with a link is not shown", async () => {
    const answer = JSON.stringify({ rationale: "See https://globex.example/blog for details.", items: [{ id: "globex-test-insights", fields: { positioning: "A CI analytics dashboard that now retries failed tests." } }] });
    const r = await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model: fakeModel(answer, MODEL), config });
    expect(r.proposal.status).toBe("made");
    const row = await db.prepare("SELECT rationale, payload FROM learnings_proposals").first<{ rationale: string; payload: string }>();
    const content = (JSON.parse(row?.payload ?? "{}") as { content: string }).content;
    expect(content).toContain("- name: Globex Test Insights");
    expect(content).toContain("now retries failed tests");
    expect(content).toContain("- differentiators: Acme quarantines flaky tests, while dashboards only report them.");
    expect(content).toContain("- domain: globex.example");
    expect(row?.rationale).toBe(`Competitor watch ${isoWeek(NOW)}.`);
  });

  it("shows the model's note only without a link, a host of any kind or a dash", () => {
    expect(proposalNote("Globex now retries failed tests.")).toBe("Globex now retries failed tests.");
    for (const note of ["Confirm at globex-login.ru today.", "See acme.click/x now.", "Read https://news.example/a first.", "Globex DASH now retries."]) expect(proposalNote(note.replace("DASH", String.fromCharCode(0x2014))), note).toBe("");
  });

  it("gives the week's slot back when no call could be made", async () => {
    const unpriced = replyTestConfig({ models: { roles: { strategist: MODEL }, pricing: {} } });
    const model = fakeModel(proposalAnswer, MODEL);
    const first = await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model, config: unpriced });
    expect(first.proposal.status).toBe("refused");
    expect(model.requests).toHaveLength(0);
    await db.prepare("DELETE FROM event_effects WHERE event_id NOT LIKE 'competitor_proposal:%'").run();
    const second = await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model, config });
    expect(second.proposal.status).toBe("made");
    expect(model.requests).toHaveLength(1);
  });

  it("releases the week's news when the digest cannot be sent, so the next run lists it", async () => {
    const kv = await brainKv();
    const run = (op: OperatorChannel | undefined) => runCompetitorWatch({ db, kv, news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: op, proposals: false, config });
    expect(await run(undefined)).toMatchObject({ items: 1, digest: "no_channel" });
    const op = operator();
    expect(await run(op)).toMatchObject({ items: 1, digest: "sent" });
    expect(op.sent[0]).toContain("Globex Test Insights adds automatic test retries");
  });

  it("names this week's pending proposal again in a digest re-sent after a failed one", async () => {
    const kv = await brainKv();
    const model = fakeModel(proposalAnswer, MODEL);
    const run = (op: OperatorChannel | undefined) => runCompetitorWatch({ db, kv, news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: op, proposals: true, model, config });
    const first = await run(undefined);
    expect(first).toMatchObject({ digest: "no_channel", proposal: { status: "made" } });
    const id = first.proposal.status === "made" ? first.proposal.id : "";
    const op = operator();
    expect(await run(op)).toMatchObject({ digest: "sent", proposal: { status: "waiting", id } });
    expect(op.sent[0]).toContain(`learning-show ${id}`);
    expect(model.requests).toHaveLength(1);
    // Next run the same week, its digest released again and no news left: the proposal is still named.
    await db.prepare("DELETE FROM event_effects WHERE event_id LIKE 'report:competitor_watch:%'").run();
    const quiet = await runCompetitorWatch({ db, kv, news: fakeNews([]), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model, config });
    expect(quiet.proposal).toEqual({ status: "waiting", id });
  });

  it("never names another week's proposal as this week's", async () => {
    const kv = await brainKv();
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, 'competitor_proposal', ?2)").bind(`competitor_proposal:${isoWeek(NOW)}`, NOW.toISOString()).run();
    await db
      .prepare("INSERT INTO learnings_proposals (id, short_id, kind, section, proposed_text, proposed_digest, rationale, proposed_by, status) VALUES ('lp_old', 'oldweek1', 'brain', 'brain:competitors', 'x', ?1, ?2, 'competitor_watch', 'pending')")
      .bind("a".repeat(64), `Competitor watch ${isoWeek(new Date(NOW.getTime() - 7 * DAY_MS))}. Older.`)
      .run();
    const r = await runCompetitorWatch({ db, kv, news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model: fakeModel(proposalAnswer, MODEL), config });
    expect(r.proposal).toEqual({ status: "none" });
  });

  it("gives its claims back when the run fails on a database error", async () => {
    const kv = await brainKv();
    let claims = 0;
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop) as unknown;
        return (sql: string) => {
          if (/INSERT OR IGNORE INTO event_effects/.test(sql) && ++claims === 2) throw new Error("database unavailable");
          return target.prepare(sql);
        };
      },
    });
    const news = fakeNews((text) => (text === "Globex Test Insights" ? [hit("Globex Test Insights adds retries", "https://news.example/g1"), hit("Globex Test Insights adds reports", "https://news.example/g2")] : []));
    await expect(runCompetitorWatch({ db: failing, kv, news, boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: false, config })).rejects.toThrow("database unavailable");
    expect(await firstSighting(db, "competitor:globex-test-insights", "https://news.example/g1")).not.toBeNull();
  });

  it("does not search a competitor whose name is too generic to match in a title", async () => {
    const generic = ["## data", "- name: Data", "- positioning: A rival.", "- differentiators: Acme is different.", ""].join("\n");
    const news = fakeNews([]);
    const r = await runCompetitorWatch({ db, kv: await brainKv(`${COMPETITORS}\n${generic}`), news, boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: false, config });
    expect(r.competitors).toBe(2);
    expect(news.calls.map((c) => c.text)).toEqual(["Globex Test Insights", "Initech CI Analytics"]);
  });

  it("refuses an answer that tries to set a domain", async () => {
    const answer = JSON.stringify({ rationale: "x", items: [{ id: "initech-ci-analytics", fields: { name: "Initech CI Analytics", positioning: "A rival.", differentiators: "Acme is different.", domain: "attacker.example" } }] });
    const r = await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model: fakeModel(answer, MODEL), config });
    expect(r.proposal).toEqual({ status: "refused", reason: "the answer was not in the expected shape" });
  });

  it("makes no call with proposals off, and skips without competitors in the brain", async () => {
    const model = fakeModel(proposalAnswer, MODEL);
    await runCompetitorWatch({ db, kv: await brainKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: false, model, config });
    expect(model.requests).toHaveLength(0);
    const empty = await runCompetitorWatch({ db, kv: memoryKv(), news: globexNews(), boards: undefined, gate: competitorGate(), now: NOW, log: silentLog, operator: operator(), proposals: true, model, config });
    expect(empty).toMatchObject({ competitors: 0, digest: "not_sent" });
  });

  it("the brain schema accepts an optional lowercase domain on a competitor", () => {
    const base = { name: "Globex", positioning: "A rival.", differentiators: "Acme is different." };
    expect(COMPONENT_SCHEMAS.competitors.safeParse(base).success).toBe(true);
    expect(COMPONENT_SCHEMAS.competitors.safeParse({ ...base, domain: "globex.example" }).success).toBe(true);
    for (const domain of ["https://globex.example", "Globex.Example", "globex", "globex.example/pricing"]) expect(COMPONENT_SCHEMAS.competitors.safeParse({ ...base, domain }).success, domain).toBe(false);
  });
});

describe("research in prep briefs", () => {
  async function withFacts(fetchedAt: string): Promise<string> {
    const contact = await seedContact(db, { first: "Jane", last: "Doe", email: "jane@brightloop.example" });
    const evidence = { headcount_band: { url: "https://brightloop.example/about", provider: "exa", retrieved_at: fetchedAt }, funding_stage: { url: "https://news.example/round", provider: "exa", retrieved_at: fetchedAt } };
    await db
      .prepare("INSERT INTO account_facts (account_key, status, provider, headcount_band, funding_stage, sector, attributes, fetched_at) VALUES ('brightloop.example', 'found', 'exa', '51-200', 'series_b', 'Software', ?1, ?2)")
      .bind(JSON.stringify({ evidence }), fetchedAt)
      .run();
    return contact;
  }

  it("shows fresh research facts with their sources only when asked, and never a field without a source", async () => {
    const contact = await withFacts(daysAgo(10));
    const brief = await loadContactBrief(db, contact);
    if (!brief) throw new Error("no brief");
    expect(renderPrepBrief(brief, null, NOW)).not.toContain("Public context");
    const shown = renderPrepBrief(brief, null, NOW, { research: true });
    expect(shown).toContain("Public context (unverified, from account research");
    expect(shown).toContain("Headcount: 51-200 (source brightloop.example)");
    expect(shown).toContain("Funding stage: series_b (source news.example)");
    expect(shown).not.toContain("Sector");
  });

  it("leaves out research older than 90 days", async () => {
    const contact = await withFacts(daysAgo(120));
    const brief = await loadContactBrief(db, contact);
    if (!brief) throw new Error("no brief");
    expect(renderPrepBrief(brief, null, NOW, { research: true })).not.toContain("Public context");
  });
});

describe("watch commands", () => {
  const run = async (text: string) => {
    const handler = watchCommands().match(text);
    if (!handler) return null;
    return handler({ env: { DB: db } as never, now: NOW, actor: "operator:1", sessionKey: "s" });
  };

  it("pins and unpins an existing account only, idempotently, and lists what the next watch covers", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs");
    expect(await run("watch-add unknown.example")).toMatch(/No account unknown.example/);
    expect(await run("watch-add jane@gmail.com")).toMatch(/not a company domain/);
    expect(await run("watch-add Brightloop.Example")).toMatch(/Pinned brightloop.example/);
    expect(await run("watch-add brightloop.example")).toMatch(/already pinned/);
    expect(await run("watch-list")).toContain("- brightloop.example (pinned)");
    expect(await run("watch-remove brightloop.example")).toMatch(/Unpinned/);
    expect((await watchedAccounts(db)).map((a) => a.accountKey)).toEqual([]);
    expect(await run("watch-addbrightloop.example")).toBeNull();
    expect(await run("watch-list extra")).toBeNull();
  });

  it("warns when a pinned account's name is too generic for the watch to cover", async () => {
    await seedAccount(db, "plainco.example", "Software");
    expect(await run("watch-add plainco.example")).toMatch(/too generic to match/);
    expect((await watchedAccounts(db)).map((a) => a.accountKey)).toEqual([]);
    const listed = await run("watch-list");
    expect(listed).toContain("- plainco.example (its name is too generic to match a news title, so the watch skips it)");
    expect(listed).toContain("The next account watch covers none.");
  });
});

describe("the watch jobs", () => {
  it("register on Mondays behind their flags, do nothing while off, and the flags default off", async () => {
    const jobs = createSignalJobs({ adapters: () => ({ news: fakeNews([]), boards: fakeBoards({}) }) });
    const account = jobs.find((j) => j.name === "signal_account_watch");
    const competitor = jobs.find((j) => j.name === "signal_competitor_watch");
    expect(account).toMatchObject({ schedule: "30 6 * * MON", flag: SIGNAL_FLAGS.accountWatch, ceilings: { maxSpendCents: 50 } });
    expect(competitor).toMatchObject({ schedule: "30 7 * * MON", flag: SIGNAL_FLAGS.competitorWatch, ceilings: { maxSpendCents: 100 } });
    for (const job of [account, competitor]) {
      const result = await job?.run({ env: { DB: db, KV: env.KV }, config, job: job.name, now: NOW, signal: new AbortController().signal, ceilings: job.ceilings, flags: flagsOf({}, ["*"]), log: silentLog });
      expect(result).toEqual({ summary: "flag off" });
    }
    for (const key of [SIGNAL_FLAGS.accountWatch, SIGNAL_FLAGS.competitorWatch, SIGNAL_FLAGS.competitorProposals, "convert:brief_research_enabled"]) expect(FLAGS.find((f) => f.key === key)?.default).toBe("false");
  });
});
