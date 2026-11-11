// GTM-agents: account research: runs started and read across job runs, only cited fields stored,
// never-list and low-fit accounts skipped, a monthly claim per account, and spend recorded once.
// Every company, domain and URL here is invented, on *.example domains.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { jobCapKey } from "../src/budget/gate.ts";
import { configSchema } from "../src/config/schema.ts";
import { RESEARCH_EFFECT, researchEffectId, runAccountResearch, type AccountResearchOptions } from "../src/enrichment/research.ts";
import { findFlag } from "../src/flags/registry.ts";
import { runOneJob } from "../src/jobs/loop.ts";
import type { JobContext, RegisteredJob } from "../src/jobs/registry.ts";
import type { CompanyResearchRead, CompanyResearchRecord, CompanyResearchSource } from "../src/ports/discovery.ts";
import { AdapterError, type Cost } from "../src/ports/types.ts";
import { createJobRunner } from "../src/runtime/job-runner.ts";
import { accountProfile, runFitScoring } from "../src/scoring/fit.ts";
import { loadSourcingBrain } from "../src/sourcing/brain.ts";
import { SOURCING_FLAGS } from "../src/sourcing/flags.ts";
import { RESEARCH_JOB, createSourcingJobs } from "../src/sourcing/jobs.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { acmeConfig } from "./fixtures.ts";
import { fakeModel, flagsOf, resetSourcingTables, silentLog, uploadBrain } from "./sourcing-fakes.ts";

type TestEnv = { DB: D1Database; KV: KVNamespace };
const config = configSchema.parse({
  ...acmeConfig,
  models: { roles: { classifier: "test-classifier-model" }, pricing: { "test-classifier-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } },
});
const T0 = new Date("2026-11-04T09:00:00.000Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const on = { [SOURCING_FLAGS.researchEnabled]: "true" };
const cost = (usd: number): Cost => ({ provider: "fake-research", capability: "company_research", usd, units: 1 });

/** A research record as an adapter returns it, citing every kept field. */
function record(domain: string, attributes: Record<string, unknown>, verdict: CompanyResearchRecord["verdict"] = "found"): CompanyResearchRecord {
  return {
    name: domain,
    domain,
    attributes,
    evidence: Object.keys(attributes).map((field) => ({ field: field as CompanyResearchRecord["evidence"][number]["field"], url: `https://${domain}/source/${field}`, provider: "fake-research", retrievedAt: "2026-11-04T09:05:00.000Z" })),
    verdict,
    providerRef: `agent_run_${domain}`,
  };
}

interface FakeResearch extends CompanyResearchSource {
  starts: string[];
  reads: string[];
}

function fakeResearch(read: (runId: string) => CompanyResearchRead | Error = () => ({ status: "pending" }), start?: (domain: string) => Error | undefined): FakeResearch {
  const starts: string[] = [];
  const reads: string[] = [];
  return {
    name: "fake-research",
    starts,
    reads,
    async startCompanyResearch({ domain }) {
      const error = start?.(domain);
      if (error) throw error;
      starts.push(domain);
      return { runId: `agent_run_${domain}`, cost: cost(0.1) };
    },
    startCost: () => cost(0.1),
    async readCompanyResearch(runId) {
      reads.push(runId);
      const out = read(runId);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

async function addAccount(key: string, name: string, prescore: number, fit?: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (account_key, name) VALUES (?1, ?2)").bind(key, name),
    env.DB.prepare("INSERT INTO account_fit (account_key, account_name, prescore, status, fit_score) VALUES (?1, ?2, ?3, ?4, ?5)").bind(key, name, prescore, fit === undefined ? "prescored" : "scored", fit ?? null),
  ]);
}

async function options(source: CompanyResearchSource, extra: Partial<AccountResearchOptions> = {}, flags = flagsOf()): Promise<AccountResearchOptions> {
  return {
    db: env.DB,
    source,
    brain: await loadSourcingBrain(env.KV),
    gate: createSpendGate({ db: env.DB, flags, job: RESEARCH_JOB }),
    now: T0,
    maxRows: 20,
    log: silentLog,
    ...extra,
  };
}

const facts = (key: string) => env.DB.prepare("SELECT * FROM account_facts WHERE account_key = ?1").bind(key).first<Record<string, unknown>>();
const spentMicroCents = async () => Number((await env.DB.prepare("SELECT COALESCE(SUM(cost_micro_cents), 0) AS total FROM cost_events").first<{ total: number }>())?.total ?? 0);

function runJob(job: RegisteredJob<TestEnv>, flags: ReturnType<typeof flagsOf>, now: Date) {
  return runOneJob<TestEnv>(
    job,
    (j, signal) => ({ env: { DB: env.DB, KV: env.KV }, config, job: j.name, now, signal, ceilings: j.ceilings, flags, log: silentLog }) satisfies JobContext<TestEnv>,
    createJobRunner<TestEnv>(),
  );
}

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await env.DB.prepare("DELETE FROM event_effects").run();
  await uploadBrain(env.KV);
});

describe("the account research gate", () => {
  it("stores a researched account as found with a source URL on every field, leaves an ungrounded field null, feeds the fenced fit profile, and pays once a month", async () => {
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    const researched = record("brightloop.example", {
      employee_range: "51-200",
      hq_country: "DE",
      funding_stage: "series_a",
      raised_usd: 12_000_000,
      technologies: ["Kubernetes", "Go"],
      last_round_date: "2026-03-14",
      hiring_functions: ["engineering", "sales"],
    });
    const source = fakeResearch(() => ({ status: "done", record: researched, dropped: ["employees_count"], cost: cost(0.12) }));
    const job = createSourcingJobs<TestEnv>({ adapters: () => ({ sources: [], finders: [], research: source }) }).find((j) => j.name === RESEARCH_JOB) as RegisteredJob<TestEnv>;

    const first = await runJob(job, flagsOf(on), T0);
    expect(first.status).toBe("completed");
    expect(first.summary).toContain("started 1");
    expect(await facts("brightloop.example")).toMatchObject({ status: "pending", provider: "fake-research" });
    expect(await spentMicroCents()).toBe(100_000);

    const second = await runJob(job, flagsOf(on), later(15));
    expect(second.summary).toContain("completed 1 (found 1, not_found 0)");
    expect(second.summary).toContain("dropped 1 fields");
    const row = (await facts("brightloop.example")) as Record<string, unknown>;
    expect(row).toMatchObject({ status: "found", provider: "fake-research", headcount_band: "51-200", hq_country: "DE", funding_stage: "series_a", raised_usd: 12_000_000, employees_count: null, founded_year: null, industry: null });
    expect(JSON.parse(String(row.technologies))).toEqual(["Kubernetes", "Go"]);
    const attributes = JSON.parse(String(row.attributes)) as { evidence: Record<string, { url: string; provider: string; retrieved_at: string }>; dropped: string[]; last_round_date: string; hiring_functions: string[] };
    expect(attributes).toMatchObject({ last_round_date: "2026-03-14", hiring_functions: ["engineering", "sales"], dropped: ["employees_count"] });
    // Every stored field, in a column or in attributes, carries a source URL.
    const stored: Record<string, string> = { headcount_band: "employee_range", employees_count: "employees_count", hq_country: "hq_country", founded_year: "founded_year", sector: "sector", industry: "industry", company_type: "company_type", funding_stage: "funding_stage", raised_usd: "raised_usd", technologies: "technologies" };
    const storedFields = [...Object.entries(stored).filter(([column]) => row[column] !== null).map(([, field]) => field), "last_round_date", "hiring_functions"];
    expect(Object.keys(attributes.evidence).sort()).toEqual(storedFields.sort());
    for (const field of storedFields) expect(attributes.evidence[field]).toEqual({ url: `https://brightloop.example/source/${field}`, provider: "fake-research", retrieved_at: "2026-11-04T09:05:00.000Z" });
    // The reported cost was 0.12 against 0.10 recorded at start: only the difference is added.
    expect(await spentMicroCents()).toBe(120_000);

    const model = fakeModel(JSON.stringify({ score: 8, segment: null, team_size: null, confidence: "high", reasons: ["runs CI"], disqualifier: null }));
    await runFitScoring({ db: env.DB, kv: env.KV, model, models: config.models, gate: createSpendGate({ db: env.DB, flags: flagsOf(), job: "account_fit_scoring" }), role: "classifier", now: later(20), topN: 10, perRun: 1, job: "account_fit_scoring" });
    const content = model.requests[0]?.messages[0]?.content;
    const user = typeof content === "string" ? content : "";
    const fenced = /<tool_output source="account_profile"[\s\S]*<\/tool_output/.exec(user)?.[0] ?? "";
    for (const line of ["raised_usd: 12000000", "technologies: Kubernetes, Go", "last_round_date: 2026-03-14", "hiring_functions: engineering, sales", "headcount_band: 51-200"]) expect(fenced).toContain(line);
    expect(model.requests[0]?.system).not.toContain("Kubernetes");

    // A third run finds nothing to do; with the row gone, the monthly claim still stops a second paid start.
    await runJob(job, flagsOf(on), later(30));
    await env.DB.prepare("DELETE FROM account_facts").run();
    const fourth = await runJob(job, flagsOf(on), later(45));
    expect(fourth.summary).toContain("started 0");
    expect(source.starts).toEqual(["brightloop.example"]);
    expect(await spentMicroCents()).toBe(120_000 + 1500);
  });
});

describe("runAccountResearch", () => {
  it("starts nothing, and claims nothing, when the budget refuses", async () => {
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    const source = fakeResearch();
    const flags = flagsOf({ [jobCapKey(RESEARCH_JOB)]: "0" });
    const result = await runAccountResearch(await options(source, {}, flags));
    expect(result.started).toBe(0);
    expect(result.stopped).toContain("budget");
    expect(source.starts).toHaveLength(0);
    expect(await facts("brightloop.example")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM event_effects").first()).toEqual({ n: 0 });
  });

  it("skips accounts on the never list and accounts below the low fit score, best prescore first", async () => {
    await addAccount("globex.example", "Globex", 99);
    await addAccount("initech.example", "Initech Analytics", 98);
    await addAccount("lowfit.example", "Lowfit", 97, 3);
    await addAccount("northwind.example", "Northwind", 40, 7);
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    const source = fakeResearch();
    const result = await runAccountResearch(await options(source));
    expect(source.starts).toEqual(["brightloop.example", "northwind.example"]);
    expect(result).toMatchObject({ started: 2, skipped: 2 });
  });

  it("stops at the row budget, counting the runs it polled", async () => {
    for (const [i, key] of ["a1.example", "a2.example", "a3.example"].entries()) await addAccount(key, key, 90 - i);
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('p1.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_p1", started_at: T0.toISOString() }), T0.toISOString()).run();
    const source = fakeResearch();
    const result = await runAccountResearch(await options(source, { maxRows: 2 }));
    expect(result).toMatchObject({ polled: 1, started: 1 });
    expect(source.starts).toEqual(["a1.example"]);
  });

  it("fails a run still pending 24 hours after it started", async () => {
    const started = new Date(T0.getTime() - 25 * 3_600_000).toISOString();
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, attempts, attributes, updated_at) VALUES ('brightloop.example', 'pending', 1, ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_old", started_at: started }), started).run();
    const source = fakeResearch(() => ({ status: "pending" }));
    const result = await runAccountResearch(await options(source));
    expect(result).toMatchObject({ polled: 1, failed: 1 });
    expect(source.reads).toEqual(["agent_run_old"]);
    const row = await facts("brightloop.example");
    expect(row).toMatchObject({ status: "failed", attempts: 2 });
    expect(JSON.parse(String(row?.attributes))).toMatchObject({ last_error: "timed_out" });
  });

  it("leaves a run pending under 24 hours, and fails a failed run, recording only a cost above what was recorded", async () => {
    const stamp = later(-60).toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('waiting.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_waiting", started_at: stamp, recorded_usd: 0.1 }), stamp),
      env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('broken.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_broken", started_at: stamp, recorded_usd: 0.1 }), stamp),
      env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('cheap.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_cheap", started_at: stamp, recorded_usd: 0.1 }), stamp),
    ]);
    const source = fakeResearch((id) =>
      id === "agent_run_broken" ? { status: "failed", reason: "server_error", cost: cost(0.15) } : id === "agent_run_cheap" ? { status: "failed", reason: "timeout", cost: cost(0.02) } : { status: "pending" },
    );
    const result = await runAccountResearch(await options(source));
    expect(result).toMatchObject({ polled: 3, failed: 2, completed: 0 });
    expect(await facts("waiting.example")).toMatchObject({ status: "pending" });
    expect(await facts("broken.example")).toMatchObject({ status: "failed", attempts: 1 });
    expect(await spentMicroCents()).toBe(50_000);
  });

  it("stores nothing for a run whose verdict is not found, or that kept no field", async () => {
    const stamp = later(-30).toISOString();
    for (const key of ["gone.example", "empty.example"]) {
      await env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES (?1, 'pending', ?2, ?3)").bind(key, JSON.stringify({ run_id: `agent_run_${key}`, started_at: stamp, recorded_usd: 0.1 }), stamp).run();
    }
    const source = fakeResearch((id) =>
      id === "agent_run_gone.example"
        ? { status: "done", record: record("gone.example", { industry: "Developer tools" }, "not_found"), dropped: [], cost: cost(0.1) }
        : { status: "done", record: record("empty.example", {}), dropped: ["industry", "sector"], cost: cost(0.1) },
    );
    const result = await runAccountResearch(await options(source));
    expect(result).toMatchObject({ completed: 2, notFound: 2, found: 0, dropped: 2 });
    expect(await facts("gone.example")).toMatchObject({ status: "not_found", industry: null });
    const attrs = JSON.parse(String((await facts("gone.example"))?.attributes)) as Record<string, unknown>;
    expect(attrs).toMatchObject({ verdict: "not_found" });
    expect(attrs.evidence).toBeUndefined();
  });

  it("drops a kept field whose source is not an http(s) URL, and cleans provider text before storage", async () => {
    const stamp = later(-30).toISOString();
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('brightloop.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_b", started_at: stamp }), stamp).run();
    const r = record("brightloop.example", { industry: "Developer\u0000 tools   for CI", sector: "Software" });
    r.evidence = r.evidence.map((e) => (e.field === "sector" ? { ...e, url: "javascript:alert(1)" } : e));
    await runAccountResearch(await options(fakeResearch(() => ({ status: "done", record: r, dropped: [], cost: cost(0.1) }))));
    const row = await facts("brightloop.example");
    expect(row).toMatchObject({ status: "found", industry: "Developer tools for CI", sector: null });
    expect((JSON.parse(String(row?.attributes)) as { dropped: string[] }).dropped).toEqual(["sector"]);
  });

  it("retries a failed row after 7 days until it has 3 attempts", async () => {
    const old = later(-30 * 24 * 60).toISOString();
    const recent = later(-2 * 24 * 60).toISOString();
    for (const [key, attempts, at] of [["capped.example", 3, old], ["retry.example", 2, old], ["recent.example", 1, recent]] as const) {
      await addAccount(key, key, 50);
      await env.DB.prepare("INSERT INTO account_facts (account_key, status, attempts, attributes, updated_at) VALUES (?1, 'failed', ?2, '{}', ?3)").bind(key, attempts, at).run();
    }
    const source = fakeResearch();
    await runAccountResearch(await options(source));
    expect(source.starts).toEqual(["retry.example"]);
    expect(await facts("retry.example")).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("refreshes a found row after 180 days, but not before", async () => {
    await addAccount("stale.example", "Stale", 60);
    await addAccount("fresh.example", "Fresh", 70);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, fetched_at, updated_at) VALUES ('stale.example', 'found', '{}', ?1, ?1)").bind(later(-200 * 24 * 60).toISOString()),
      env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, fetched_at, updated_at) VALUES ('fresh.example', 'found', '{}', ?1, ?1)").bind(later(-20 * 24 * 60).toISOString()),
    ]);
    const source = fakeResearch();
    await runAccountResearch(await options(source));
    expect(source.starts).toEqual(["stale.example"]);
  });

  it("on a 429, stops starting and releases only the claim of the start that was refused", async () => {
    await addAccount("first.example", "First", 90);
    await addAccount("busy.example", "Busy", 80);
    await addAccount("third.example", "Third", 70);
    const source = fakeResearch(undefined, (domain) => (domain === "busy.example" ? new AdapterError("slow down", "rate_limited", true) : undefined));
    const result = await runAccountResearch(await options(source));
    expect(result).toMatchObject({ started: 1, stopped: "rate limited" });
    expect(source.starts).toEqual(["first.example"]);
    expect(await facts("busy.example")).toBeNull();
    const claims = await env.DB.prepare("SELECT event_id FROM event_effects WHERE effect = ?1 ORDER BY event_id").bind(RESEARCH_EFFECT).all<{ event_id: string }>();
    expect(claims.results.map((c) => c.event_id)).toEqual([researchEffectId("first.example", T0)]);
  });

  it("keeps the claim after an ambiguous start failure, so a retry this month never pays twice", async () => {
    await addAccount("flaky.example", "Flaky", 90);
    const source = fakeResearch(undefined, () => new AdapterError("timed out", "timeout", true));
    expect(await runAccountResearch(await options(source))).toMatchObject({ started: 0, failed: 1 });
    expect(await facts("flaky.example")).toMatchObject({ status: "failed", attempts: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM event_effects").first()).toEqual({ n: 1 });
    // The provider may have started the run, so its price is recorded as if it had.
    expect(await spentMicroCents()).toBe(100_000);
  });

  it("releases the claim and records nothing when the provider refuses the request for an account", async () => {
    await addAccount("refused.example", "Refused", 90);
    const source = fakeResearch(undefined, () => new AdapterError("bad request", "invalid", false));
    await runAccountResearch(await options(source));
    expect(await spentMicroCents()).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM event_effects").first()).toEqual({ n: 0 });
  });

  it("keeps the recorded cost and the monthly claim when the row cannot be written after a start", async () => {
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!/INSERT INTO account_facts[\s\S]*'pending'/.test(sql)) return statement;
            return { bind: () => ({ run: () => Promise.reject(new Error("D1 write failed")) }) } as unknown as D1PreparedStatement;
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const source = fakeResearch();
    const result = await runAccountResearch(await options(source, { db: failing }));
    expect(result).toMatchObject({ started: 1, unrecorded: 1 });
    expect(await spentMicroCents()).toBe(100_000);
    expect(await facts("brightloop.example")).toBeNull();
    // The claim stays, so the next run does not pay again this month.
    await runAccountResearch(await options(source, { now: later(15) }));
    expect(source.starts).toEqual(["brightloop.example"]);
  });

  it("records only the difference when a completed run reports more than was recorded at start", async () => {
    const stamp = later(-30).toISOString();
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('brightloop.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_b", started_at: stamp, recorded_usd: 0.1 }), stamp).run();
    const source = fakeResearch(() => ({ status: "done", record: record("brightloop.example", { industry: "Developer tools" }), dropped: [], cost: cost(0.135) }));
    await runAccountResearch(await options(source));
    expect(await spentMicroCents()).toBe(35_000);
    // Read again (a rerun), nothing more is recorded: the row is no longer in flight.
    await runAccountResearch(await options(source, { now: later(5) }));
    expect(await spentMicroCents()).toBe(35_000);
  });

  it("fails a run that could not inspect the site, so the retry and the attempts cap apply", async () => {
    const stamp = later(-30).toISOString();
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('brightloop.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_b", started_at: stamp }), stamp).run();
    const source = fakeResearch(() => ({ status: "done", record: record("brightloop.example", { industry: "Developer tools" }, "cannot_verify"), dropped: [], cost: cost(0.1) }));
    expect(await runAccountResearch(await options(source))).toMatchObject({ failed: 1, completed: 0 });
    const row = await facts("brightloop.example");
    expect(row).toMatchObject({ status: "failed", attempts: 1, industry: null });
    expect(JSON.parse(String(row?.attributes))).toMatchObject({ last_error: "cannot_verify" });
  });

  it("keeps a found row's facts visible while it is refreshed, and after the refresh fails", async () => {
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    const old = later(-200 * 24 * 60).toISOString();
    const evidence = { industry: { url: "https://brightloop.example/about", provider: "fake-research", retrieved_at: old } };
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, provider, industry, raised_usd, attributes, fetched_at, updated_at) VALUES ('brightloop.example', 'found', 'fake-research', 'Developer tools', 5000000, ?1, ?2, ?2)")
      .bind(JSON.stringify({ evidence, run_id: "agent_run_first" }), old)
      .run();
    const source = fakeResearch(() => ({ status: "failed", reason: "server_error" }));
    expect(await runAccountResearch(await options(source))).toMatchObject({ started: 1 });
    const during = await facts("brightloop.example");
    expect(during).toMatchObject({ status: "found", industry: "Developer tools" });
    expect(JSON.parse(String(during?.attributes))).toMatchObject({ refresh_run_id: "agent_run_brightloop.example", run_id: "agent_run_first" });
    expect(await accountProfile(env.DB, "brightloop.example")).toContain("industry: Developer tools");

    expect(await runAccountResearch(await options(source, { now: later(15) }))).toMatchObject({ polled: 1, failed: 1 });
    const after = await facts("brightloop.example");
    expect(after).toMatchObject({ status: "found", industry: "Developer tools", raised_usd: 5000000, attempts: 0 });
    const attrs = JSON.parse(String(after?.attributes)) as Record<string, unknown>;
    expect(attrs).toMatchObject({ last_error: "server_error", refresh_attempts: 1, evidence });
    expect(attrs.refresh_run_id).toBeUndefined();
    const profile = await accountProfile(env.DB, "brightloop.example");
    expect(profile).toContain("industry: Developer tools");
    expect(profile).toContain("raised_usd: 5000000");
    // No second paid refresh in the same month.
    await runAccountResearch(await options(source, { now: later(30) }));
    expect(source.starts).toEqual(["brightloop.example"]);
  });

  it("replaces a found row's facts when its refresh comes back found", async () => {
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    const old = later(-200 * 24 * 60).toISOString();
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, industry, attributes, fetched_at, updated_at) VALUES ('brightloop.example', 'found', 'Old industry', ?1, ?2, ?2)").bind(JSON.stringify({ refresh_attempts: 1 }), old).run();
    const source = fakeResearch(() => ({ status: "done", record: record("brightloop.example", { sector: "Software" }), dropped: [], cost: cost(0.1) }));
    await runAccountResearch(await options(source));
    await runAccountResearch(await options(source, { now: later(15) }));
    const row = await facts("brightloop.example");
    expect(row).toMatchObject({ status: "found", sector: "Software", industry: null, fetched_at: later(15).toISOString() });
    const attrs = JSON.parse(String(row?.attributes)) as Record<string, unknown>;
    expect(attrs).toMatchObject({ run_id: "agent_run_brightloop.example" });
    expect(attrs.refresh_run_id).toBeUndefined();
    expect(attrs.refresh_attempts).toBeUndefined();
  });

  it("does not let accounts already paid for this month crowd out the start phase, and retries a failure next month", async () => {
    const now = new Date("2026-11-20T09:00:00.000Z");
    const failedAt = new Date("2026-11-10T09:00:00.000Z").toISOString();
    for (const [i, key] of ["paid1.example", "paid2.example", "lastmonth.example"].entries()) {
      await addAccount(key, key, 90 - i);
      await env.DB.prepare("INSERT INTO account_facts (account_key, status, attempts, attributes, updated_at) VALUES (?1, 'failed', 1, '{}', ?2)").bind(key, failedAt).run();
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO event_effects (event_id, effect) VALUES (?1, ?2)").bind(researchEffectId("paid1.example", now), RESEARCH_EFFECT),
      env.DB.prepare("INSERT INTO event_effects (event_id, effect) VALUES (?1, ?2)").bind(researchEffectId("paid2.example", now), RESEARCH_EFFECT),
      env.DB.prepare("INSERT INTO event_effects (event_id, effect) VALUES (?1, ?2)").bind("research:lastmonth.example:2026-10", RESEARCH_EFFECT),
    ]);
    const source = fakeResearch();
    const result = await runAccountResearch(await options(source, { now, maxRows: 1 }));
    expect(source.starts).toEqual(["lastmonth.example"]);
    expect(result).toMatchObject({ started: 1, alreadyClaimed: 0 });
    // Next month, the failed accounts are tried again.
    const next = await runAccountResearch(await options(source, { now: new Date("2026-12-01T09:00:00.000Z") }));
    expect(next.started).toBe(2);
    expect(source.starts).toEqual(["lastmonth.example", "paid1.example", "paid2.example"]);
  });

  it("fails a run the provider no longer has", async () => {
    const stamp = later(-30).toISOString();
    await env.DB.prepare("INSERT INTO account_facts (account_key, status, attributes, updated_at) VALUES ('brightloop.example', 'pending', ?1, ?2)").bind(JSON.stringify({ run_id: "agent_run_gone", started_at: stamp }), stamp).run();
    await runAccountResearch(await options(fakeResearch(() => new AdapterError("no such run", "not_found", false))));
    expect(await facts("brightloop.example")).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("the account_research job", () => {
  it("is registered off by default, every 15 minutes, with its ceilings", () => {
    const job = createSourcingJobs<TestEnv>({ adapters: () => ({ sources: [], finders: [] }) }).find((j) => j.name === RESEARCH_JOB);
    expect(job).toMatchObject({ schedule: "*/15 * * * *", flag: "enrichment:research_enabled", ceilings: { maxDurationMs: 600_000, maxRows: 20, maxSpendCents: 300 } });
    expect(findFlag("enrichment:research_enabled")?.default).toBe("false");
  });

  it("does nothing, and builds no adapter, while its flag is off or unreadable", async () => {
    await addAccount("brightloop.example", "Brightloop Labs", 80);
    let built = 0;
    const source = fakeResearch();
    const job = createSourcingJobs<TestEnv>({
      adapters: () => {
        built += 1;
        return { sources: [], finders: [], research: source };
      },
    }).find((j) => j.name === RESEARCH_JOB) as RegisteredJob<TestEnv>;
    expect((await runJob(job, flagsOf(), T0)).status).toBe("skipped");
    const unreadable = await job.run({ env: { DB: env.DB, KV: env.KV }, config, job: job.name, now: T0, signal: new AbortController().signal, ceilings: job.ceilings, flags: flagsOf({}, [SOURCING_FLAGS.researchEnabled]), log: silentLog });
    expect(unreadable).toMatchObject({ summary: "flag off" });
    expect(built).toBe(0);
    expect(source.starts).toHaveLength(0);
  });
});
