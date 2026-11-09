// GTM-agents: tests for per-minute dispatch: the Worker's one trigger fires every minute, and the jobs
// that run are the ones whose own schedule matches that minute (UTC). Cron health still works out
// each job's expected fire from that job's schedule.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { DUE_JOB_CONCURRENCY, defaultRunner, runDueJobs, runJobsConcurrently } from "../src/jobs/loop.ts";
import { MAX_JOB_DURATION_MS, SCHEDULER_CRON, createJobRegistry, defineJob, type JobContext, type RegisteredJob } from "../src/jobs/registry.ts";
import { checkCronHealth } from "../src/runtime/cron-health.ts";
import { createJobRunner, type RunnerEnv } from "../src/runtime/job-runner.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

const MONDAY_0900 = new Date("2026-11-02T09:00:00Z");
const SATURDAY_0900 = new Date("2026-11-07T09:00:00Z");

function context(job: RegisteredJob, signal: AbortSignal, now: Date): JobContext {
  return { env: {}, config, job: job.name, now, signal, ceilings: job.ceilings, flags: { get: async () => null }, log: quietLog };
}

function recording(ran: string[]) {
  const job = (name: string, schedule: string, fail = false) =>
    defineJob({
      name,
      schedule,
      ceilings: { maxDurationMs: 1000 },
      run: async () => {
        ran.push(name);
        if (fail) throw new Error(`${name} broke`);
      },
    });
  return job;
}

describe("per-minute dispatch", () => {
  it("uses one per-minute trigger", () => {
    expect(SCHEDULER_CRON).toBe("* * * * *");
  });

  it("runs exactly the jobs whose schedule matches Monday 09:00 UTC, in registration order", async () => {
    const ran: string[] = [];
    const job = recording(ran);
    const registry = createJobRegistry([
      job("weekday_nine", "0 9 * * MON-FRI"),
      job("quarter_hourly", "*/15 * * * *"),
      job("weekend_nine", "0 9 * * SAT,SUN"),
      job("half_past_nine", "30 9 * * *"),
      job("first_of_month", "0 9 1 * *"),
      job("afternoon", "0 13 * * MON-THU"),
      job("daily_nine", "0 9 * * *"),
    ]);
    expect(registry.dueAt(MONDAY_0900).map((j) => j.name)).toEqual(["weekday_nine", "quarter_hourly", "daily_nine"]);
    const outcomes = await runDueJobs(registry, MONDAY_0900, (j, signal) => context(j, signal, MONDAY_0900));
    expect(ran.sort()).toEqual(["daily_nine", "quarter_hourly", "weekday_nine"]);
    expect(outcomes.map((o) => [o.job, o.status])).toEqual([
      ["weekday_nine", "completed"],
      ["quarter_hourly", "completed"],
      ["daily_nine", "completed"],
    ]);
  });

  it("ignores seconds in the scheduled time, matching on the minute", () => {
    const ran: string[] = [];
    const registry = createJobRegistry([recording(ran)("daily_nine", "0 9 * * *")]);
    expect(registry.dueAt(new Date("2026-11-02T09:00:42.500Z")).map((j) => j.name)).toEqual(["daily_nine"]);
    expect(registry.dueAt(new Date("2026-11-02T09:01:00Z"))).toEqual([]);
  });

  it("runs nothing, and never builds a job context, in a minute with nothing due", async () => {
    const ran: string[] = [];
    const registry = createJobRegistry([recording(ran)("weekday_nine", "0 9 * * MON-FRI")]);
    let contexts = 0;
    let runs = 0;
    const outcomes = await runDueJobs(
      registry,
      new Date("2026-11-02T09:07:00Z"),
      (j, signal) => {
        contexts++;
        return context(j, signal, MONDAY_0900);
      },
      async (j) => {
        runs++;
        return { job: j.name, status: "completed", durationMs: 0 };
      },
    );
    expect(outcomes).toEqual([]);
    expect(ran).toEqual([]);
    expect(contexts).toBe(0);
    expect(runs).toBe(0);
  });

  it("keeps going after a failing job, through the same runner", async () => {
    const ran: string[] = [];
    const job = recording(ran);
    const registry = createJobRegistry([job("breaks_first", "0 9 * * *", true), job("runs_after", "0 9 * * *"), job("also_runs", "*/30 * * * *")]);
    const outcomes = await runDueJobs(registry, MONDAY_0900, (j, signal) => context(j, signal, MONDAY_0900));
    expect(ran.sort()).toEqual(["also_runs", "breaks_first", "runs_after"]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "completed", "completed"]);
    expect(outcomes[0]?.error).toBe("breaks_first broke");
  });

  it("respects named days: a MON-FRI job runs on Monday and not on Saturday", () => {
    const ran: string[] = [];
    const job = recording(ran);
    const registry = createJobRegistry([job("weekdays", "0 9 * * MON-FRI"), job("weekends", "0 9 * * SAT,SUN")]);
    expect(registry.dueAt(MONDAY_0900).map((j) => j.name)).toEqual(["weekdays"]);
    expect(registry.dueAt(SATURDAY_0900).map((j) => j.name)).toEqual(["weekends"]);
  });
});

describe("running a busy minute", () => {
  it("runs every due job concurrently, longest ceiling first", async () => {
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const job = (name: string, maxDurationMs: number) =>
      defineJob({
        name,
        schedule: "0 9 * * *",
        ceilings: { maxDurationMs },
        run: async () => {
          started.push(name);
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 30));
          running--;
        },
      });
    const registry = createJobRegistry([job("quick_poll", 50_000), job("long_cycle", 600_000), job("medium_sweep", 120_000)]);
    const t0 = Date.now();
    const outcomes = await runDueJobs(registry, MONDAY_0900, (j, signal) => context(j, signal, MONDAY_0900));
    expect(Date.now() - t0).toBeLessThan(80);
    expect(peak).toBe(3);
    expect(started).toEqual(["long_cycle", "medium_sweep", "quick_poll"]);
    expect(outcomes.map((o) => [o.job, o.status])).toEqual([["long_cycle", "completed"], ["medium_sweep", "completed"], ["quick_poll", "completed"]]);
  });

  it("never runs more than the concurrency bound at once", async () => {
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 7 }, (_v, i) =>
      defineJob({ name: `job_${i}`, schedule: "0 9 * * *", ceilings: { maxDurationMs: 1000 }, run: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      } }),
    );
    await runJobsConcurrently(jobs, (j, signal) => context(j, signal, MONDAY_0900), undefined, undefined, { concurrency: 3 });
    expect(peak).toBe(3);
    expect(DUE_JOB_CONCURRENCY).toBeGreaterThan(1);
  });

  it("does not start a job whose ceiling cannot fit, and records it as failed through the runner", async () => {
    const ran: string[] = [];
    const notStarted: string[] = [];
    const registry = createJobRegistry([
      defineJob({ name: "long_cycle", schedule: "0 9 * * *", ceilings: { maxDurationMs: 600_000 }, run: async () => void ran.push("long_cycle") }),
      defineJob({ name: "quick_poll", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1_000 }, run: async () => void ran.push("quick_poll") }),
    ]);
    const outcomes = await runDueJobs(
      registry,
      MONDAY_0900,
      (j, signal) => context(j, signal, MONDAY_0900),
      async (job, ctx) => {
        if (ctx.notStarted) notStarted.push(job.name);
        return defaultRunner(job, ctx);
      },
      undefined,
      { deadline: Date.now() + 60_000 },
    );
    expect(ran).toEqual(["quick_poll"]);
    expect(notStarted).toEqual(["long_cycle"]);
    const late = outcomes.find((o) => o.job === "long_cycle");
    expect(late?.status).toBe("failed");
    expect(late?.error).toContain("was not started");
  });

  it("keeps one job's failure from affecting the others running beside it", async () => {
    const ran: string[] = [];
    const job = recording(ran);
    const registry = createJobRegistry([job("breaks", "0 9 * * *", true), job("fine_one", "0 9 * * *"), job("fine_two", "0 9 * * *")]);
    const outcomes = await runDueJobs(registry, MONDAY_0900, (j, signal) => context(j, signal, MONDAY_0900));
    expect(ran.sort()).toEqual(["breaks", "fine_one", "fine_two"]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "completed", "completed"]);
  });
});

describe("cron health with per-minute dispatch", () => {
  it("works out each critical job's expected fire from that job's own schedule", async () => {
    const job = (name: string, schedule: string) => defineJob({ name, schedule, critical: true, ceilings: { maxDurationMs: 60_000 }, run: async () => {} });
    const registry = createJobRegistry([
      job("sched_weekday_morning", "0 9 * * MON-FRI"),
      job("sched_daily_afternoon", "30 14 * * *"),
      job("sched_saturday_noon", "0 12 * * SAT"),
    ]);
    const findings = await checkCronHealth({ registry, db: env.DB, now: new Date("2026-11-02T16:00:00Z") });
    expect(Object.fromEntries(findings.map((f) => [f.job, [f.status, f.expectedAt]]))).toEqual({
      sched_weekday_morning: ["missed", "2026-11-02T09:00:00.000Z"],
      sched_daily_afternoon: ["missed", "2026-11-02T14:30:00.000Z"],
      sched_saturday_noon: ["missed", "2026-10-31T12:00:00.000Z"],
    });
  });
});

describe("the fault-tolerant runner and per-minute dispatch", () => {
  const kv = () => {
    const m = new Map<string, string>();
    return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
  };
  const runnerContext = (job: RegisteredJob<RunnerEnv>, signal: AbortSignal, extra: Partial<JobContext<RunnerEnv>> = {}): JobContext<RunnerEnv> => {
    const store = kv();
    return { env: { DB: env.DB, KV: store }, config, job: job.name, now: new Date(), signal, ceilings: job.ceilings, flags: { get: (k) => store.get(k) }, log: quietLog, ...extra };
  };
  const latest = (name: string) => env.DB.prepare("SELECT status, summary, error FROM execution_runs WHERE task_name = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(name).first<{ status: string; summary: string | null; error: string | null }>();
  const seedRunning = (name: string, startedAt: Date) =>
    env.DB.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, created_at) VALUES (?1, ?2, 'cron', 'running', ?3, ?3)").bind(crypto.randomUUID(), name, startedAt.toISOString()).run();

  it("records a job it had no time to start as a failed run row with the reason, without running it", async () => {
    let ran = false;
    const job = defineJob<RunnerEnv>({ name: "sched_no_time", schedule: "0 9 * * *", ceilings: { maxDurationMs: 600_000 }, run: async () => void (ran = true) });
    const outcome = await createJobRunner<RunnerEnv>()(job, runnerContext(job, new AbortController().signal, { notStarted: "job sched_no_time was not started: no time left" }));
    expect(ran).toBe(false);
    expect(outcome.status).toBe("failed");
    const row = await latest("sched_no_time");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("was not started");
  });

  it("skips a job whose previous run is still going, and records why", async () => {
    let ran = false;
    const job = defineJob<RunnerEnv>({ name: "sched_overlap", schedule: "* * * * *", ceilings: { maxDurationMs: 600_000 }, run: async () => void (ran = true) });
    await seedRunning("sched_overlap", new Date(Date.now() - 60_000));
    const outcome = await createJobRunner<RunnerEnv>()(job, runnerContext(job, new AbortController().signal));
    expect(ran).toBe(false);
    expect(outcome.status).toBe("skipped");
    expect(outcome.summary).toContain("previous run is still going");
    expect(await latest("sched_overlap")).toMatchObject({ status: "skipped" });
  });

  it("is not blocked by a stale running row older than the job's ceiling", async () => {
    let ran = false;
    const job = defineJob<RunnerEnv>({ name: "sched_stale", schedule: "* * * * *", ceilings: { maxDurationMs: 60_000 }, run: async () => void (ran = true) });
    await seedRunning("sched_stale", new Date(Date.now() - 10 * 60_000));
    const outcome = await createJobRunner<RunnerEnv>()(job, runnerContext(job, new AbortController().signal));
    expect(ran).toBe(true);
    expect(outcome.status).toBe("completed");
  });

  it("refuses a job whose ceiling could never fit in one cron invocation", () => {
    expect(() => defineJob({ name: "too_long", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: MAX_JOB_DURATION_MS + 1 }, run: () => Promise.resolve({}) })).toThrow(/could never start/);
    expect(defineJob({ name: "just_fits", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: MAX_JOB_DURATION_MS }, run: () => Promise.resolve({}) }).name).toBe("just_fits");
  });
});
