// GTM-agents: tests for employment checks and champion moves (docs/SIGNALS.md#employment-checks):
// who is checked and when, what each result writes, the notice, the spend gate, the job's flags,
// and that a champion candidate still goes through the ordinary discovery checks. Every company,
// person, address and profile URL is invented. That a moved contact gets no cold mail and no
// sequence step is proven where those are decided (outreach-picker and sequences-sweep tests).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import type { EmploymentChecker, EmploymentStatus } from "../src/ports/contact.ts";
import type { OperatorChannel } from "../src/ports/operator.ts";
import { seedContact } from "../src/outreach/testing.ts";
import { addSuppression } from "../src/sending/suppression.ts";
import { CHAMPION_SOURCE, EMPLOYMENT_SIGNAL_SOURCE, NEW_ROLE_HEADLINE, runEmploymentChecks, type EmploymentRunInput } from "../src/signals/employment.ts";
import { SIGNAL_FLAGS } from "../src/signals/flags.ts";
import { createSignalJobs } from "../src/signals/jobs.ts";
import { runDiscoveryCycle } from "../src/sourcing/cycle.ts";
import { SOURCING_FLAGS } from "../src/sourcing/flags.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { FLAGS } from "../src/flags/registry.ts";
import { acmeConfig } from "./fixtures.ts";
import { DAY_MS, NOW, daysAgo, resetSignalTables } from "./signals-fakes.ts";
import { fakeVerifier, flagsOf, silentLog, uploadBrain } from "./sourcing-fakes.ts";

const db = env.DB;
const CANARY = "CANARY-9b2e";
const profile = (slug: string) => `https://profiles.example/in/${slug}`;

type Check = { status: EmploymentStatus; roleStartedAt?: string; title?: string } | "throw";
type Find = { email: string; domain: string; companyName?: string } | null;

interface FakeChecker extends EmploymentChecker {
  checks: string[];
  finds: string[];
}

function fakeChecker(checks: Record<string, Check>, finds: Record<string, Find> = {}, usd = 0.06): FakeChecker {
  const checked: string[] = [];
  const found: string[] = [];
  return {
    name: "fake-employment",
    checks: checked,
    finds: found,
    checkEmployment(args) {
      checked.push(args.profileUrl);
      const c = checks[args.profileUrl] ?? { status: "current" };
      if (c === "throw") return Promise.reject(new Error("provider unavailable"));
      return Promise.resolve({ ...c, cost: { provider: "fake-employment", capability: "job_change", usd } });
    },
    findCurrentWorkEmail(args) {
      found.push(args.profileUrl);
      const f = finds[args.profileUrl] ?? null;
      const cost = { provider: "fake-employment", capability: "email_find", usd: f ? 0.02 : 0 };
      return Promise.resolve(f ? { ...f, sources: [], cost } : { email: null, cost });
    },
  };
}

function fakeOperator(): OperatorChannel & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notify(message: { text: string }) {
      sent.push(message.text);
      return Promise.resolve({ messageId: `m${sent.length}` });
    },
  } as unknown as OperatorChannel & { sent: string[] };
}

async function contact(email: string, slug: string | null, warmth = "contacted", extra: Record<string, unknown> = {}): Promise<string> {
  const [first, rest] = email.split("@")[0]?.split(".") ?? ["Jane"];
  return seedContact(db, { first: first ?? "Jane", last: rest ?? "Doe", email, warmth, accountName: "Brightloop Labs", attributes: { ...(slug ? { profile_url: profile(slug) } : {}), ...extra } });
}

function run(checker: EmploymentChecker, options: Partial<EmploymentRunInput> = {}, now: Date = NOW) {
  return runEmploymentChecks({
    db,
    checker,
    gate: createSpendGate({ db, flags: flagsOf(), job: "signal_employment", jobCapCents: 60, now: () => now }),
    now,
    log: silentLog,
    champions: false,
    ...options,
  });
}

const employment = (id: string) => db.prepare("SELECT employment_status, employment_checked_at FROM contacts WHERE id = ?1").bind(id).first<{ employment_status: string | null; employment_checked_at: string | null }>();

beforeEach(async () => {
  await resetSignalTables(db);
  await db.prepare("DELETE FROM event_effects WHERE event_id LIKE 'employment_moved:%'").run();
  await uploadBrain(env.KV);
});

describe("employment checks: who and when", () => {
  it("checks contacts with an https profile and an account, warmest first, and skips the rest without a call", async () => {
    const cold = await contact("cole.cold@brightloop.example", "cole");
    const hot = await contact("hana.hot@brightloop.example", "hana", "hot");
    await contact("nora.none@brightloop.example", null);
    await contact("pat.plain@brightloop.example", null, "contacted", { profile_url: "http://profiles.example/in/pat" });
    await contact("oona.out@brightloop.example", "oona", "opted_out");
    await addSuppression(db, { email: "oona.out@brightloop.example", reason: "opt_out", source: "test" });
    const checker = fakeChecker({});
    const stats = await run(checker, { maxChecks: 1 });
    expect(stats.checked).toBe(1);
    expect(checker.checks).toEqual([profile("hana")]);
    await run(checker);
    expect(checker.checks).toEqual([profile("hana"), profile("cole")]);
    expect((await employment(hot))?.employment_status).toBe("current");
    expect((await employment(cold))?.employment_status).toBe("current");
  });

  it("skips a suppressed contact before any paid call", async () => {
    await contact("sam.supp@brightloop.example", "sam", "engaged");
    await addSuppression(db, { email: "sam.supp@brightloop.example", reason: "opt_out", source: "test" });
    const checker = fakeChecker({});
    const stats = await run(checker);
    expect(checker.checks).toEqual([]);
    expect(stats.checked).toBe(0);
  });

  it("suppressed contacts never hold the head of the queue", async () => {
    for (let i = 0; i < 12; i++) {
      const email = `hb${i}.bounced@brightloop.example`;
      await contact(email, `hb${i}`, "contacted");
      await addSuppression(db, { email, reason: "bounce", source: "test" });
    }
    await contact("cleo.cold@brightloop.example", "cleo", "cold");
    const checker = fakeChecker({});
    await run(checker);
    expect(checker.checks).toEqual([profile("cleo")]);
  });

  it("checks a current contact again after 90 days, and an inconclusive one after 30", async () => {
    const current = await contact("cara.current@brightloop.example", "cara");
    const unclear = await contact("ugo.unclear@brightloop.example", "ugo");
    const checker = fakeChecker({ [profile("ugo")]: { status: "ambiguous" } });
    await run(checker);
    expect((await employment(unclear))?.employment_status).toBe("unknown");
    const after = (days: number) => new Date(NOW.getTime() + days * DAY_MS);
    await run(checker, {}, after(29));
    expect(checker.checks).toHaveLength(2);
    await run(checker, {}, after(31));
    expect(checker.checks.slice(2)).toEqual([profile("ugo")]);
    await run(checker, {}, after(91));
    expect(checker.checks.slice(3)).toContain(profile("cara"));
    expect((await employment(current))?.employment_status).toBe("current");
  });

  it("stops paid checks when the spend gate refuses, leaving the rest due", async () => {
    for (const name of ["ann.a", "ben.b", "cat.c"]) await contact(`${name}@brightloop.example`, name);
    const checker = fakeChecker({}, {}, 0.06);
    const gate = createSpendGate({ db, flags: flagsOf(), job: "signal_employment", jobCapCents: 10, now: () => NOW });
    const stats = await runEmploymentChecks({ db, checker, gate, now: NOW, log: silentLog, champions: false });
    expect(stats.checked).toBe(2);
    expect(gate.stopped).toMatch(/budget/);
    const due = await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE employment_checked_at IS NULL").first<{ n: number }>();
    expect(due?.n).toBe(1);
  });

  it("a provider error stops the run and is reported", async () => {
    await contact("eve.err@brightloop.example", "eve", "hot");
    await contact("fay.fine@brightloop.example", "fay");
    const checker = fakeChecker({ [profile("eve")]: "throw" });
    const stats = await run(checker);
    expect(stats.error).toMatch(/provider unavailable/);
    expect(checker.checks).toEqual([profile("eve")]);
  });
});

describe("employment checks: what a result writes", () => {
  it("a current role begun in the last 90 days is one job_change signal for that contact, with our own headline", async () => {
    const id = await contact("nia.new@brightloop.example", "nia");
    await contact("old.timer@brightloop.example", "old");
    const checker = fakeChecker({
      [profile("nia")]: { status: "current", roleStartedAt: daysAgo(20), title: `${CANARY} Head of Platform` },
      [profile("old")]: { status: "current", roleStartedAt: daysAgo(400) },
    });
    const stats = await run(checker);
    expect(stats.signals).toBe(1);
    const { results } = await db.prepare("SELECT contact_id, type, source, headline, source_url, evidence FROM signal_events").all<Record<string, string>>();
    expect(results).toEqual([
      { contact_id: id, type: "job_change", source: EMPLOYMENT_SIGNAL_SOURCE, headline: NEW_ROLE_HEADLINE, source_url: profile("nia"), evidence: JSON.stringify({ checked_by: "fake-employment" }) },
    ]);
    await run(checker, {}, new Date(NOW.getTime() + 91 * DAY_MS));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM signal_events").first<{ n: number }>())?.n).toBe(1);
  });

  it("a moved contact is marked moved, and you are told about a warming or warmer one, once, in our own words", async () => {
    const warm = await contact("wren.warm@brightloop.example", "wren", "warming");
    const cold = await contact("cody.cold@brightloop.example", "cody", "cold");
    const operator = fakeOperator();
    const checker = fakeChecker({ [profile("wren")]: { status: "moved", title: `${CANARY} CTO` }, [profile("cody")]: { status: "moved" } });
    const stats = await run(checker, { operator });
    expect(stats.moved).toBe(2);
    expect((await employment(warm))?.employment_status).toBe("moved");
    expect((await employment(cold))?.employment_status).toBe("moved");
    expect(operator.sent).toEqual([`wren warm at brightloop.example (contact ${warm}) has moved to another company. No more cold or follow-up mail will go to their address there.`]);
    expect(operator.sent.join(" ")).not.toContain(CANARY);
    // Moved contacts are not checked again.
    await run(checker, { operator }, new Date(NOW.getTime() + 200 * DAY_MS));
    expect(checker.checks).toHaveLength(2);
    expect(operator.sent).toHaveLength(1);
  });

  it("an inconclusive result marks the contact unknown and writes no signal", async () => {
    for (const [slug, status] of [["nw", "never_worked_there"], ["am", "ambiguous"], ["un", "unknown"], ["pn", "profile_not_found"]] as const) {
      const id = await contact(`${slug}.person@brightloop.example`, slug);
      await run(fakeChecker({ [profile(slug)]: { status } }));
      expect((await employment(id))?.employment_status, status).toBe("unknown");
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM signal_events").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("champion moves", () => {
  const moved = (slug: string, title?: string): Record<string, Check> => ({ [profile(slug)]: { status: "moved", ...(title ? { title } : {}) } });
  const champion = () =>
    db.prepare("SELECT source, source_contact_id, status, email, email_source, account_key, job_title, account_name, attributes FROM candidates WHERE source = ?1").bind(CHAMPION_SOURCE).all<Record<string, string>>();

  it("an engaged contact who moved becomes one raw candidate at the new company, linked to the old contact", async () => {
    const id = await contact("erin.engaged@brightloop.example", "erin", "engaged");
    const operator = fakeOperator();
    const checker = fakeChecker(moved("erin", "VP Engineering"), { [profile("erin")]: { email: "erin@initech.example", domain: "initech.example", companyName: `Initech ${CANARY}` } });
    const stats = await run(checker, { operator, champions: true });
    expect(stats.champions).toBe(1);
    const { results } = await champion();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: CHAMPION_SOURCE, source_contact_id: id, status: "raw", email: "erin@initech.example", email_source: "fake-employment", account_key: "initech.example", job_title: "VP Engineering" });
    expect(JSON.parse(results[0]?.attributes ?? "{}")).toEqual({ profile_url: profile("erin"), champion_of: id });
    expect(operator.sent[0]).toMatch(/added as a candidate at their new company/);
    expect(operator.sent.join(" ")).not.toContain(CANARY);
    expect(operator.sent.join(" ")).not.toContain("initech");
  });

  it("follows nobody with the flag off, a warming contact, or an address that is not a clean work address at a new company", async () => {
    await contact("flo.flag@brightloop.example", "flo", "hot");
    const off = fakeChecker(moved("flo"), { [profile("flo")]: { email: "flo@initech.example", domain: "initech.example" } });
    await run(off, { champions: false });
    expect(off.finds).toEqual([]);

    const cases: Array<[string, string, Find]> = [
      ["wes", "warming", { email: "wes@initech.example", domain: "initech.example" }],
      ["gia", "engaged", { email: "gia.home@gmail.com", domain: "gmail.com" }],
      ["sal", "engaged", { email: "sal@brightloop.example", domain: "brightloop.example" }],
      ["dom", "engaged", { email: "dom@umbrella.example", domain: "initech.example" }],
      ["rol", "engaged", { email: "info@initech.example", domain: "initech.example" }],
    ];
    for (const [slug, warmth, find] of cases) {
      await contact(`${slug}.case@brightloop.example`, slug, warmth);
      await run(fakeChecker(moved(slug), { [profile(slug)]: find }), { champions: true });
    }
    expect((await champion()).results).toEqual([]);
  });

  it("never stores a new address that is suppressed", async () => {
    await contact("sue.supp@brightloop.example", "sue", "customer");
    await addSuppression(db, { email: "sue@initech.example", reason: "opt_out", source: "test" });
    await run(fakeChecker(moved("sue"), { [profile("sue")]: { email: "sue@initech.example", domain: "initech.example" } }), { champions: true });
    expect((await champion()).results).toEqual([]);
  });

  it("a champion candidate still has to pass the discovery checks: a never-listed company is rejected", async () => {
    await contact("gus.globex@brightloop.example", "gus", "engaged");
    await run(fakeChecker(moved("gus", "VP Engineering"), { [profile("gus")]: { email: "gus@globex.example", domain: "globex.example" } }), { champions: true });
    expect((await champion()).results).toHaveLength(1);
    await runDiscoveryCycle({
      db,
      kv: env.KV,
      flags: flagsOf({ [SOURCING_FLAGS.enabled]: "true" }),
      adapters: { sources: [], finders: [], verifier: fakeVerifier("fake-verifier") },
      now: NOW,
      job: "discovery_cycle",
      runId: "run-champion",
      log: silentLog,
      jobCapCents: 300,
      peoplePerAccount: 1,
    });
    const row = (await champion()).results[0];
    expect(row?.status).toBe("rejected");
    expect(JSON.parse(row?.attributes ?? "{}")).toMatchObject({ reject_reason: "never_list" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'gus@globex.example'").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("champion moves: a separate, resumable pass", () => {
  const moved = (slug: string, title?: string): Record<string, Check> => ({ [profile(slug)]: { status: "moved", ...(title ? { title } : {}) } });
  const champions = () => db.prepare("SELECT source_contact_id, job_title, status FROM candidates WHERE source = ?1").bind(CHAMPION_SOURCE).all<Record<string, string>>();

  it("follows a move found while the flag was off once the flag is on, and never looks the same person up twice", async () => {
    const id = await contact("lia.later@brightloop.example", "lia", "hot");
    const checker = fakeChecker(moved("lia", "VP Engineering"), { [profile("lia")]: { email: "lia@initech.example", domain: "initech.example" } });
    await run(checker, { champions: false });
    expect(checker.finds).toEqual([]);
    const operator = fakeOperator();
    const stats = await run(checker, { champions: true, operator }, new Date(NOW.getTime() + DAY_MS));
    expect(stats.championLookups).toBe(1);
    expect((await champions()).results).toEqual([{ source_contact_id: id, job_title: "VP Engineering", status: "raw" }]);
    expect(operator.sent[0]).toMatch(new RegExp(`who moved from brightloop.example \\(contact ${id}\\).*added as a candidate`));
    await run(checker, { champions: true }, new Date(NOW.getTime() + 2 * DAY_MS));
    expect(checker.finds).toHaveLength(1);
  });

  it("counts lookups, not candidates, against the per-run limit", async () => {
    for (let i = 0; i < 8; i++) await contact(`ch${i}.champ@brightloop.example`, `ch${i}`, "engaged");
    const checks = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [profile(`ch${i}`), { status: "moved" as const }]));
    const checker = fakeChecker(checks);
    const stats = await run(checker, { champions: true });
    expect(stats.championLookups).toBe(5);
    expect(checker.finds).toHaveLength(5);
  });

  it("a champion who opts out at the earlier address is never promoted at the new one", async () => {
    const promoteChampion = async () =>
      runDiscoveryCycle({
        db,
        kv: env.KV,
        flags: flagsOf({ [SOURCING_FLAGS.enabled]: "true" }),
        adapters: { sources: [], finders: [], verifier: fakeVerifier("fake-verifier") },
        now: NOW,
        job: "discovery_cycle",
        runId: `run-${Math.random()}`,
        log: silentLog,
        jobCapCents: 300,
        peoplePerAccount: 1,
      });
    await contact("ola.stays@brightloop.example", "ola", "engaged");
    const complained = await contact("uma.complained@brightloop.example", "uma", "engaged");
    const optedOut = await contact("vic.optedout@brightloop.example", "vic", "engaged");
    const checker = fakeChecker(
      { ...moved("ola", "VP Engineering"), ...moved("uma", "VP Engineering"), ...moved("vic", "VP Engineering") },
      {
        [profile("ola")]: { email: "ola@initech.example", domain: "initech.example" },
        [profile("uma")]: { email: "uma@initech.example", domain: "initech.example" },
        [profile("vic")]: { email: "vic@initech.example", domain: "initech.example" },
      },
    );
    await run(checker, { champions: true });
    // After the move was found: one is suppressed at the old address, one opts out there.
    await addSuppression(db, { email: "uma.complained@brightloop.example", reason: "complaint", source: "test" });
    await db.prepare("UPDATE contacts SET warmth = 'opted_out' WHERE id = ?1").bind(optedOut).run();
    for (let i = 0; i < 3; i++) await promoteChampion();
    const promoted = await db.prepare("SELECT email FROM contacts WHERE account_key = 'initech.example'").all<{ email: string }>();
    expect(promoted.results.map((r) => r.email)).toEqual(["ola@initech.example"]);
    for (const id of [complained, optedOut]) {
      const rejected = await db.prepare("SELECT status, attributes FROM candidates WHERE source_contact_id = ?1").bind(id).first<{ status: string; attributes: string }>();
      expect(rejected?.status).toBe("rejected");
      expect(JSON.parse(rejected?.attributes ?? "{}")).toMatchObject({ reject_reason: "suppressed" });
    }
    // Deleting an opted-out contact needs its opt-out recorded first.
    await addSuppression(db, { email: "vic.optedout@brightloop.example", reason: "opt_out", source: "test" });
  });
});

describe("the employment job", () => {
  const ctx = (flags: Record<string, string>) => ({
    env: { DB: db, KV: env.KV },
    config: defineConfig(acmeConfig),
    job: "signal_employment",
    now: NOW,
    signal: new AbortController().signal,
    ceilings: { maxDurationMs: 120_000, maxRows: 15, maxSpendCents: 60 },
    flags: flagsOf(flags),
    log: silentLog,
  });
  const job = (checker?: EmploymentChecker) => {
    const found = createSignalJobs({ adapters: () => (checker ? { employment: checker } : {}) }).find((j) => j.name === "signal_employment");
    if (!found) throw new Error("signal_employment is not registered");
    return found;
  };

  it("is registered on weekdays behind its flag, and both flags default off", () => {
    expect(job()).toMatchObject({ schedule: "0 8 * * MON-FRI", flag: SIGNAL_FLAGS.jobChange, ceilings: { maxSpendCents: 60 } });
    for (const key of [SIGNAL_FLAGS.jobChange, SIGNAL_FLAGS.championMoves]) expect(FLAGS.find((f) => f.key === key)?.default).toBe("false");
  });

  it("does nothing with the flag off or unreadable, or without a checker", async () => {
    await contact("jo.job@brightloop.example", "jo", "engaged");
    const checker = fakeChecker({});
    expect(await job(checker).run(ctx({}))).toEqual({ summary: "flag off" });
    expect(await job(checker).run({ ...ctx({}), flags: flagsOf({}, [SIGNAL_FLAGS.jobChange]) })).toEqual({ summary: "flag off" });
    expect(await job().run(ctx({ [SIGNAL_FLAGS.jobChange]: "true" }))).toEqual({ summary: "no employment checker configured" });
    expect(checker.checks).toEqual([]);
  });

  it("follows champions only with signals:champion_moves_enabled, and fails the run on a provider error", async () => {
    await contact("kim.keen@brightloop.example", "kim", "engaged");
    const checker = fakeChecker(moved_("kim"), { [profile("kim")]: { email: "kim@initech.example", domain: "initech.example" } });
    await job(checker).run(ctx({ [SIGNAL_FLAGS.jobChange]: "true" }));
    expect(checker.finds).toEqual([]);
    await contact("lee.late@brightloop.example", "lee", "engaged");
    await job(fakeChecker({ [profile("lee")]: "throw" })).run(ctx({ [SIGNAL_FLAGS.jobChange]: "true" })).then(
      () => expect.fail("the run should fail"),
      (error: unknown) => expect(String(error)).toMatch(/employment checker failed/),
    );
  });
});

function moved_(slug: string): Record<string, Check> {
  return { [profile(slug)]: { status: "moved" } };
}
