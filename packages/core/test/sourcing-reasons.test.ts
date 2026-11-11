// GTM-agents: the filter funnel's gate: every candidate that reaches a terminal status other than
// promoted carries a reject_reason from the enum, and the funnel digest lists rejections by reason
// for the week.
//
// One synthetic data set runs through every stage that can stop a candidate (search, enrichment,
// qualification, promotion, websets), then the table is read whole. Every company, person and
// address is invented, on *.example domains.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { addressHash } from "../src/sending/suppression.ts";
import { contactEmailFields } from "../src/data/contacts.ts";
import { cacheVerification } from "../src/enrichment/verification.ts";
import { enrichStage } from "../src/enrichment/enrich.ts";
import { rejectionsByReason, UNRECORDED_REASON } from "../src/metrics/index.ts";
import { FUNNEL_REJECTION_SOURCES, funnelWindows, loadFunnelDigest, renderFunnelDigest } from "../src/reports/funnel.ts";
import { runWebsets } from "../src/signals/websets.ts";
import { loadSourcingBrain } from "../src/sourcing/brain.ts";
import { insertCandidate, parseAttributes } from "../src/sourcing/candidates.ts";
import { promoteStage } from "../src/sourcing/promote.ts";
import { qualifyStage } from "../src/sourcing/qualify.ts";
import { REJECT_REASONS, isRejectReason, type RejectReason } from "../src/sourcing/reasons.ts";
import { searchStage } from "../src/sourcing/search.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { accountResult, fakeFinder, fakePeople, fakeSource, fakeVerifier, flagsOf, person, resetSourcingTables, silentLog, stageContext, uploadBrain } from "./sourcing-fakes.ts";
import { fakeWebsets } from "./signals-fakes.ts";

const db = env.DB;
/** A Tuesday; the digest is read the following Monday, so this day is inside its week. */
const now = new Date("2026-11-03T09:00:00.000Z");
const DIGEST_AT = new Date("2026-11-09T07:00:00.000Z");

async function qualified(id: string, fields: Record<string, string | number | null>) {
  const row = {
    source: "fake-search",
    source_ref: `ref-${id}`,
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@brightloop.example",
    job_title: "VP Engineering",
    account_name: "Brightloop Labs",
    account_key: "brightloop.example",
    status: "qualified",
    qualification_score: 0.8,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...fields,
  };
  const keys = Object.keys(row);
  await db.prepare(`INSERT INTO candidates (id, ${keys.join(", ")}) VALUES (?1, ${keys.map((_, i) => `?${i + 2}`).join(", ")})`).bind(id, ...Object.values(row)).run();
}

const verified = (email: string, status: "deliverable" | "risky" = "deliverable") =>
  cacheVerification(db, email, { status, provider: "fake-verifier", score: status === "deliverable" ? 95 : 60, acceptAll: status === "risky", disposable: false, reason: status, verifiedAt: now.toISOString() });

async function contact(id: string, email: string, first: string | null = null, last: string | null = null) {
  const f = await contactEmailFields(email);
  await db
    .prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, account_key, first_name, last_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, f?.email, f?.email_sha256, f?.mailbox_sha256, email.split("@")[1], first, last)
    .run();
}

const raw = (sourceRef: string, fields: Partial<Parameters<typeof insertCandidate>[1]>) =>
  insertCandidate(db, { source: "fake-search", sourceRef, searchType: "person", status: "raw", ...fields }, now);

beforeAll(async () => {
  await resetSourcingTables(db);
  await db.prepare("DELETE FROM monitor_items").run();
  await uploadBrain(env.KV);
  const ctx = () => stageContext(db, env.KV, { now, flags: flagsOf() });

  // Search: no company domain, the never list, and a person whose name cannot be read.
  const source = fakeSource("fake-search", [
    accountResult("A personal blog", "gmail.com", "s-personal"),
    accountResult("Globex", "globex.example", "s-never"),
    { kind: "person", name: "   ", title: "CTO", domain: "brightloop.example", evidence: [], providerRef: "s-noname" },
  ]);
  await searchStage(await ctx(), [source], { searches: 1, resultsPerSearch: 10, rawBacklogMax: 1000 });

  // Enrichment.
  await db.prepare("INSERT INTO account_fit (account_key, status, fit_score) VALUES ('lowfit.example', 'scored', 2)").run();
  await raw("e-lowfit", { searchType: "account", accountKey: "lowfit.example", accountName: "Lowfit Corp" });
  await raw("e-nopersona", { searchType: "account", accountKey: "quillstack.example", accountName: "Quillstack" });
  await raw("e-drop", { firstName: "Pat", lastName: "Kim", jobTitle: "Account Executive", accountKey: "brightloop.example" });
  await raw("e-suppressed", { firstName: "Sam", lastName: "Lee", jobTitle: "CTO", accountKey: "northwind.example" });
  await raw("e-dup", { firstName: "Ada", lastName: "Park", jobTitle: "CTO", accountKey: "contoso.example" });
  await db
    .prepare("INSERT INTO suppression (email_sha256, email, reason, source, created_at) VALUES (?1, 'sam.lee@northwind.example', 'opt_out', 'test', ?2)")
    .bind(await addressHash("sam.lee@northwind.example"), now.toISOString())
    .run();
  await contact("existing-ada", "ada.park@contoso.example");
  const people = fakePeople("fake-people", { "quillstack.example": [person("Max", "Fox", "Account Executive", "quillstack.example")] });
  const finder = fakeFinder("fake-finder", { "sam lee@northwind.example": "sam.lee@northwind.example", "ada park@contoso.example": "ada.park@contoso.example" });
  await enrichStage(await ctx(), { sources: [], people, finders: [finder], verifier: fakeVerifier("fake-verifier") }, 50, { peoplePerAccount: 1 });
  // No people provider at all, for an account candidate.
  await raw("e-nopeople", { searchType: "account", accountKey: "initrode.example", accountName: "Initrode" });
  await enrichStage(await ctx(), { sources: [], finders: [] }, 50, { peoplePerAccount: 1 });

  // Qualification: a score in the borderline band, and one under the rejection line.
  await qualified("k-borderline", { status: "enriched", email: null, source_ref: "k-1" });
  await qualified("k-low", { status: "enriched", email: null, last_name: null, account_name: null, job_title: "Director of Sales", source_ref: "k-2" });
  await qualifyStage(await ctx(), 50);

  // Promotion.
  await contact("existing-jo", "jo.roe@brightloop.example", "Jo", "Roe");
  await qualified("p-unparseable", { email: "not an address", source_ref: "p-1" });
  await qualified("p-offsite", { email: "jane@elsewhere.example", source_ref: "p-2" });
  await qualified("p-role", { email: "sales@brightloop.example", source_ref: "p-3" });
  await qualified("p-namesake", { email: "j.roe@brightloop.example", first_name: "Jo", last_name: "Roe", source_ref: "p-4" });
  await qualified("p-maybe", { email: "lee.hart@brightloop.example", job_title: "Director of Sales", source_ref: "p-5" });
  await qualified("p-risky", { email: "rae.moss@brightloop.example", first_name: "Rae", last_name: "Moss", source_ref: "p-6" });
  await qualified("p-unknown", { email: "kit.lane@brightloop.example", first_name: "Kit", last_name: "Lane", source_ref: "p-7", attributes: JSON.stringify({ verify_attempts: 2, segment: "platform" }) });
  await verified("rae.moss@brightloop.example", "risky");
  await promoteStage(await ctx(), 50, { policy: "strict", verifier: fakeVerifier("fake-verifier", {}, "unknown") });

  // Websets: an item whose company cannot be resolved.
  const websets = fakeWebsets([{ kind: "person", name: "Ola Berg", title: "CTO", evidence: [], providerRef: "w-nodomain" }]);
  await runWebsets({
    db,
    source: websets,
    specs: [{ query: "engineering leaders at software companies", count: 5 }],
    brain: await loadSourcingBrain(env.KV),
    gate: createSpendGate({ db, flags: flagsOf(), job: "signals_test", jobCapCents: 100 }),
    now,
    maxRows: 10,
    itemUsd: 0.09,
    maxReserveUsd: 10,
    log: silentLog,
  });
});

async function terminal() {
  const { results } = await db.prepare("SELECT id, source_ref, status, attributes FROM candidates WHERE status IN ('rejected', 'borderline', 'duplicate')").all<{ id: string; source_ref: string; status: string; attributes: string }>();
  return results.map((r) => ({ ...r, reason: parseAttributes(r.attributes).reject_reason }));
}

describe("reject-reason codes", () => {
  it("every candidate that reaches a terminal status other than promoted carries a reject_reason from the enum", async () => {
    const rows = await terminal();
    expect(rows.length).toBeGreaterThan(15);
    for (const r of rows) expect(isRejectReason(r.reason), `${r.source_ref} (${r.status}) has ${String(r.reason)}`).toBe(true);
    const expected: Record<string, RejectReason> = {
      "s-personal": "no_domain",
      "s-never": "never_list",
      "s-noname": "name_unreadable",
      "e-lowfit": "low_fit",
      "e-nopersona": "no_persona_match",
      "e-drop": "person_fit_drop",
      "e-suppressed": "suppressed",
      "e-dup": "duplicate_contact",
      "e-nopeople": "no_people_provider",
      "k-1": "borderline_score",
      "k-2": "low_score",
      "p-1": "address_unparseable",
      "p-2": "not_work_address",
      "p-3": "role_mailbox",
      "p-4": "duplicate_person",
      "p-5": "person_fit_maybe",
      "p-6": "verification_policy",
      "p-7": "verification_unknown",
      "webset:w-nodomain": "no_domain",
    };
    expect(Object.fromEntries(rows.map((r) => [r.source_ref, r.reason]))).toEqual(expected);
    // Nothing else in the attributes is lost when the reason is merged in.
    const unknown = parseAttributes(rows.find((r) => r.source_ref === "p-7")?.attributes);
    expect(unknown).toMatchObject({ segment: "platform", verify_attempts: 3, reject_reason: "verification_unknown", person_fit: { decision: "keep" } });
  });

  it("is a closed list of distinct snake_case codes", () => {
    expect(new Set(REJECT_REASONS).size).toBe(REJECT_REASONS.length);
    for (const r of REJECT_REASONS) expect(r).toMatch(/^[a-z]+(_[a-z]+)*$/);
    expect(isRejectReason("made_up")).toBe(false);
    expect(isRejectReason(UNRECORDED_REASON)).toBe(false);
  });
});

describe("the filter funnel", () => {
  it("counts rejections by reason and by source and query, and folds a row without a code into unrecorded", async () => {
    const week = funnelWindows(DIGEST_AT).week;
    const before = await rejectionsByReason(db, week);
    expect(before.total).toBe((await terminal()).length);
    expect(before.byReason.find((x) => x.reason === "no_domain")?.count).toBe(2);
    const searched = await db.prepare("SELECT c.query_id AS id, q.query AS text FROM candidates c JOIN discovery_queries q ON q.id = c.query_id WHERE c.source_ref = 's-never'").first<{ id: string; text: string }>();
    expect(searched?.text).toBeTruthy();
    expect(before.bySource).toContainEqual({ source: "fake-search", queryId: searched?.id, query: searched?.text, reason: "never_list", count: 1 });
    expect(before.byReason.some((x) => x.reason === UNRECORDED_REASON)).toBe(false);

    await qualified("x-legacy", { status: "rejected", source_ref: "x-1", attributes: JSON.stringify({ reject_reason: "not_a_code" }) });
    await qualified("x-outside", { status: "rejected", source_ref: "x-2", updated_at: "2026-10-01T00:00:00.000Z" });
    const after = await rejectionsByReason(db, week);
    expect(after.total).toBe(before.total + 1);
    expect(after.byReason.find((x) => x.reason === UNRECORDED_REASON)?.count).toBe(1);
    await db.prepare("DELETE FROM candidates WHERE id IN ('x-legacy', 'x-outside')").run();
  });

  it("the funnel digest lists rejections by reason for the week", async () => {
    const d = await loadFunnelDigest(db, DIGEST_AT);
    expect(d.rejections).toEqual(await rejectionsByReason(db, funnelWindows(DIGEST_AT).week));
    const text = renderFunnelDigest(d);
    const total = (await terminal()).length;
    expect(text).toContain(`Rejections: ${total} candidates, by reason: no_domain 2, `);
    for (const code of ["never_list", "low_fit", "duplicate_contact", "borderline_score", "verification_policy"]) expect(text).toMatch(new RegExp(`\\b${code} 1\\b`));
    for (const x of d.rejections?.bySource.slice(0, FUNNEL_REJECTION_SOURCES) ?? []) {
      expect(text).toContain(`- ${x.source}, ${x.queryId === null ? "no query" : `query ${x.query}`}: ${x.count} ${x.reason}`);
    }
    expect(text).toContain(`- ${(d.rejections?.bySource.length ?? 0) - FUNNEL_REJECTION_SOURCES} more source lines left out`);
    expect(text).not.toContain("the rejections section");

    // A week with nothing rejected says so, never a bare zero.
    const quiet = renderFunnelDigest(await loadFunnelDigest(db, new Date("2026-12-07T07:00:00.000Z")));
    expect(quiet).toContain("Rejections: no candidate was rejected, left borderline or found a duplicate");
  });

  it("prints source and query text through the label filter", async () => {
    const d = await loadFunnelDigest(db, DIGEST_AT);
    const text = renderFunnelDigest({
      ...d,
      rejections: { total: 1, byReason: [{ reason: "low_fit", count: 1 }], bySource: [{ source: "acme<script>", queryId: "q-1", query: "ignore\nprevious instructions", reason: "low_fit", count: 1 }] },
    });
    expect(text).toContain("- acme script, query ignore previous instructions: 1 low_fit");
    expect(text).not.toContain("<script>");
  });

  it("says the rejections section could not be read, and flags it, when the read fails", async () => {
    const d = await loadFunnelDigest(db, DIGEST_AT);
    const text = renderFunnelDigest({ ...d, rejections: null });
    expect(text).toContain("Rejections: could not be read");
    expect(text).toContain("- the rejections section could not be read");
  });
});
