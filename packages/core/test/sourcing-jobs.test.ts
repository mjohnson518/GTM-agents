// GTM-agents: the sourcing job factory: names, named-day schedules, flags that default off, ceilings,
// and adapters built only when a job runs.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.ts";
import { FLAGS, findFlag } from "../src/flags/registry.ts";
import { createJobRegistry, type JobContext, type RegisteredJob } from "../src/jobs/registry.ts";
import { runOneJob } from "../src/jobs/loop.ts";
import { createJobRunner } from "../src/runtime/job-runner.ts";
import { DISCOVERY_JOB, FIT_JOB, PRESCORE_JOB, createSourcingJobs } from "../src/sourcing/jobs.ts";
import { SOURCING_FLAGS, SOURCING_LIMITS, readCeiling, readPromotionPolicy } from "../src/sourcing/flags.ts";
import type { SourcingAdapters } from "../src/sourcing/context.ts";
import { acmeConfig } from "./fixtures.ts";
import { fakeFinder, fakeModel, fakeSource, fakeVerifier, flagsOf, resetSourcingTables, silentLog, uploadBrain } from "./sourcing-fakes.ts";

const config = configSchema.parse(acmeConfig);
/** The bindings these tests give the jobs: a real D1 database and KV namespace. */
type TestEnv = { DB: D1Database; KV: KVNamespace };

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

function run(job: RegisteredJob<TestEnv>, flags: ReturnType<typeof flagsOf>) {
  return runOneJob<TestEnv>(
    job,
    (j, signal) =>
      ({
        env: { DB: env.DB, KV: env.KV },
        config,
        job: j.name,
        now: new Date("2026-11-04T09:00:00.000Z"),
        signal,
        ceilings: j.ceilings,
        flags,
        log: silentLog,
      }) satisfies JobContext<TestEnv>,
    createJobRunner<TestEnv>(),
  );
}

describe("createSourcingJobs", () => {
  it("returns three jobs with named-day schedules, flags and ceilings", () => {
    const jobs = createSourcingJobs<TestEnv>({ adapters: () => ({ sources: [], finders: [] }) });
    const registry = createJobRegistry(jobs);
    expect(jobs.map((j) => [j.name, j.schedule, j.flag])).toEqual([
      [DISCOVERY_JOB, "0 9 * * MON-FRI", "discovery:enabled"],
      [PRESCORE_JOB, "0 4 * * *", "fit:prescore_enabled"],
      [FIT_JOB, "*/15 * * * *", "fit:scoring_enabled"],
    ]);
    expect(jobs[0]?.ceilings).toMatchObject({ maxSpendCents: 300, maxRows: 500 });
    expect(jobs[2]?.ceilings.maxSpendCents).toBe(100);
    expect(registry.schedules()).toHaveLength(3);
  });

  it("registers every flag the jobs read, each defaulting off or to a conservative ceiling", () => {
    for (const key of Object.values(SOURCING_FLAGS)) expect(findFlag(key), key).toBeDefined();
    for (const key of [SOURCING_FLAGS.enabled, SOURCING_FLAGS.prescoreEnabled, SOURCING_FLAGS.fitEnabled, SOURCING_FLAGS.waterfall]) expect(findFlag(key)?.default).toBe("false");
    expect(findFlag(SOURCING_FLAGS.promotionPolicy)?.default).toBe("strict");
    expect(findFlag(SOURCING_FLAGS.searchesPerCycle)?.default).toBe(String(SOURCING_LIMITS.searchesPerCycle.default));
    expect(new Set(FLAGS.map((f) => f.key)).size).toBe(FLAGS.length);
  });

  it("refuses a numbered day or a model schedule that fires more often than every 15 minutes", () => {
    expect(() => createSourcingJobs({ adapters: () => ({ sources: [], finders: [] }), options: { discoverySchedule: "0 9 * * 1-5" } })).toThrow(/names/);
    expect(() => createSourcingJobs({ adapters: () => ({ sources: [], finders: [] }), options: { fitSchedule: "* * * * *" } })).toThrow(/per-minute/);
    expect(() => createSourcingJobs({ adapters: () => ({ sources: [], finders: [] }), options: { fitSchedule: "0-3 * * * *" } })).toThrow(/per-minute/);
    expect(() => createSourcingJobs({ adapters: () => ({ sources: [], finders: [] }), options: { fitSchedule: "0,30 * * * *" } })).not.toThrow();
    expect(() => createSourcingJobs({ adapters: () => ({ sources: [], finders: [] }), options: { peoplePerAccount: 0 } })).toThrow(/peoplePerAccount/);
  });

  it("builds no adapters and spends nothing while a job's flag is off", async () => {
    let built = 0;
    const source = fakeSource("fake-search", []);
    const adapters = (): SourcingAdapters => {
      built += 1;
      return { sources: [source], finders: [fakeFinder("finder-a", {})], verifier: fakeVerifier("fake-verifier"), model: fakeModel("{}") };
    };
    const jobs = createSourcingJobs<TestEnv>({ adapters });
    for (const job of jobs) expect((await run(job, flagsOf())).status).toBe("skipped");
    expect(built).toBe(0);
    expect(source.queries).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT task_name, status, summary FROM execution_runs ORDER BY task_name").all();
    expect(rows.results).toEqual([
      { task_name: FIT_JOB, status: "skipped", summary: "flag off" },
      { task_name: PRESCORE_JOB, status: "skipped", summary: "flag off" },
      { task_name: DISCOVERY_JOB, status: "skipped", summary: "flag off" },
    ]);
  });

  it("runs the discovery cycle when its flag is on, and records the run", async () => {
    const source = fakeSource("fake-search", []);
    const [discovery] = createSourcingJobs<TestEnv>({ adapters: () => ({ sources: [source], finders: [] }) });
    const outcome = await run(discovery as RegisteredJob<TestEnv>, flagsOf({ [SOURCING_FLAGS.enabled]: "true" }));
    expect(outcome.status).toBe("completed");
    expect(outcome.summary).toContain("2 searches");
    expect(source.queries).toHaveLength(2);
  });

  it("runs the prescore job without any adapter", async () => {
    const [, prescore] = createSourcingJobs<TestEnv>({
      adapters: () => {
        throw new Error("the prescore job never builds adapters");
      },
    });
    const outcome = await run(prescore as RegisteredJob<TestEnv>, flagsOf({ [SOURCING_FLAGS.prescoreEnabled]: "on" }));
    expect(outcome).toMatchObject({ status: "completed", summary: "prescored 0 accounts" });
  });

  it("skips fit scoring without a model gateway", async () => {
    const [, , fit] = createSourcingJobs<TestEnv>({ adapters: () => ({ sources: [], finders: [] }) });
    const outcome = await run(fit as RegisteredJob<TestEnv>, flagsOf({ [SOURCING_FLAGS.fitEnabled]: "true" }));
    expect(outcome).toMatchObject({ status: "completed", summary: "no model gateway configured" });
  });
});

describe("reading sourcing flags", () => {
  it("clamps ceilings, and reads an unreadable or malformed ceiling as 0", async () => {
    const limit = SOURCING_LIMITS.enrichPerCycle;
    expect(await readCeiling(flagsOf(), SOURCING_FLAGS.enrichPerCycle, limit)).toBe(40);
    expect(await readCeiling(flagsOf({ [SOURCING_FLAGS.enrichPerCycle]: "500" }), SOURCING_FLAGS.enrichPerCycle, limit)).toBe(50);
    expect(await readCeiling(flagsOf({ [SOURCING_FLAGS.enrichPerCycle]: "lots" }), SOURCING_FLAGS.enrichPerCycle, limit)).toBe(0);
    expect(await readCeiling(flagsOf({}, ["*"]), SOURCING_FLAGS.enrichPerCycle, limit)).toBe(0);
  });

  it("reads the promotion policy as strict unless it says allow_risky", async () => {
    expect(await readPromotionPolicy(flagsOf())).toBe("strict");
    expect(await readPromotionPolicy(flagsOf({ [SOURCING_FLAGS.promotionPolicy]: "ALLOW_RISKY" }))).toBe("allow_risky");
    expect(await readPromotionPolicy(flagsOf({ [SOURCING_FLAGS.promotionPolicy]: "anything" }))).toBe("strict");
    expect(await readPromotionPolicy(flagsOf({ [SOURCING_FLAGS.promotionPolicy]: "allow_risky" }, ["*"]))).toBe("strict");
  });
});
