// GTM-agents: tests for per-minute dispatch: the Worker's one trigger fires every minute, and the jobs
// that run are the ones whose own schedule matches that minute (UTC). Each job is checked against
// the invocation's wall budget, and given its `now`, when it actually starts; a slot stays taken
// while a job body outlives its ceiling. Cron health still works out each job's expected fire from
// that job's schedule, and gives each rerun its own start time.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import type { Env } from "../src/env.ts";
import { DUE_JOB_CONCURRENCY, defaultRunner, runDueJobs, runJobsConcurrently, type JobOutcome } from "../src/jobs/loop.ts";
import { MAX_JOB_DURATION_MS, SCHEDULER_CRON, createJobRegistry, defineJob, type JobContext, type RegisteredJob } from "../src/jobs/registry.ts";
import { CRON_HEALTH_JOB, checkCronHealth, createCronHealthJob } from "../src/runtime/cron-health.ts";
import { createJobRunner, type RunnerEnv } from "../src/runtime/job-runner.ts";
import { createWorker } from "../src/worker.ts";
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

  it("checks the wall budget when a job actually starts, after it waited for a slot", async () => {
    let clock = 0;
    const ran: string[] = [];
    const notStarted: string[] = [];
    const jobs = [
      // Fits the budget, and takes four minutes of it.
      defineJob({ name: "first_in_line", schedule: "0 9 * * *", ceilings: { maxDurationMs: 300_000 }, run: async () => {
        ran.push("first_in_line");
        clock += 240_000;
      } }),
      // Fits when queued (2 of 5.5 minutes), not when its slot frees up at minute 4.
      defineJob({ name: "waits_for_slot", schedule: "0 9 * * *", ceilings: { maxDurationMs: 120_000 }, run: async () => void ran.push("waits_for_slot") }),
    ];
    const outcomes = await runJobsConcurrently(
      jobs,
      (j, signal) => context(j, signal, new Date(clock)),
      async (job, ctx) => {
        if (ctx.notStarted) notStarted.push(job.name);
        return defaultRunner(job, ctx);
      },
      undefined,
      { concurrency: 1, deadline: 330_000, clock: () => clock },
    );
    expect(ran).toEqual(["first_in_line"]);
    expect(notStarted).toEqual(["waits_for_slot"]);
    expect(outcomes.map((o) => o.status)).toEqual(["completed", "failed"]);
    expect(outcomes[1]?.error).toContain("was not started");
  });

  it("builds each job's context, and so its now, when that job starts", async () => {
    let clock = 0;
    const nows: Record<string, number> = {};
    const job = (name: string, takesMs: number) =>
      defineJob({ name, schedule: "0 9 * * *", ceilings: { maxDurationMs: 60_000 }, run: async (ctx) => {
        nows[name] = ctx.now.getTime();
        clock += takesMs;
      } });
    await runJobsConcurrently([job("slow_one", 30_000), job("quick_one", 0), job("queued_one", 0)], (j, signal) => context(j, signal, new Date(clock)), undefined, undefined, {
      concurrency: 2,
      clock: () => clock,
    });
    expect(nows).toEqual({ slow_one: 0, quick_one: 0, queued_one: 30_000 });
  });

  it("keeps a slot taken while a job body that ignores its signal outlives its ceiling", async () => {
    let bodyEnded = 0;
    let nextStarted = 0;
    const jobs = [
      defineJob({ name: "ignores_signal", schedule: "0 9 * * *", ceilings: { maxDurationMs: 30 }, run: async () => {
        await new Promise((r) => setTimeout(r, 150));
        bodyEnded = Date.now();
      } }),
      defineJob({ name: "next_in_line", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1_000 }, run: async () => void (nextStarted = Date.now()) }),
    ];
    const outcomes = await runJobsConcurrently(jobs, (j, signal) => context(j, signal, MONDAY_0900), undefined, undefined, { concurrency: 1, deadline: Date.now() + 10_000 });
    expect(outcomes[0]).toMatchObject({ status: "failed", error: "job ignores_signal exceeded its 30 ms ceiling" });
    expect(outcomes[1]?.status).toBe("completed");
    expect(bodyEnded).toBeGreaterThan(0);
    expect(nextStarted).toBeGreaterThanOrEqual(bodyEnded);
  });

  it("releases the slot when no job is left to start, so the loop never waits on a lingering body", async () => {
    let release: () => void = () => {};
    const lingering = new Promise<void>((r) => {
      release = r;
    });
    const jobs = [
      defineJob({ name: "lingers", schedule: "0 9 * * *", ceilings: { maxDurationMs: 30 }, run: () => lingering }),
      defineJob({ name: "beside_it", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1_000 }, run: async () => {} }),
    ];
    const t0 = Date.now();
    const outcomes = await runJobsConcurrently(jobs, (j, signal) => context(j, signal, MONDAY_0900), undefined, undefined, { concurrency: 2, deadline: Date.now() + 10_000 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "completed"]);
    release();
  });

  it("stops holding a slot once another slot has taken the last job, well before the deadline", async () => {
    const jobs = [
      defineJob({ name: "never_returns", schedule: "0 9 * * *", ceilings: { maxDurationMs: 30 }, run: () => new Promise<void>(() => {}) }),
      defineJob({ name: "takes_a_while", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1_000 }, run: () => new Promise<void>((r) => setTimeout(r, 100)) }),
      defineJob({ name: "last_in_queue", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1_000 }, run: async () => {} }),
    ];
    const t0 = Date.now();
    // The first slot holds for its stuck job; the second takes the last job at about 100 ms, which
    // frees the first. Without that, the loop would wait for the 10-second deadline.
    const outcomes = await runJobsConcurrently(jobs, (j, signal) => context(j, signal, MONDAY_0900), undefined, undefined, { concurrency: 2, deadline: t0 + 10_000 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "completed", "completed"]);
  });

  it("releases the slot at the deadline when a body never settles, and records what could not start", async () => {
    const ran: string[] = [];
    const jobs = [
      defineJob({ name: "never_settles", schedule: "0 9 * * *", ceilings: { maxDurationMs: 30 }, run: () => new Promise<void>(() => {}) }),
      defineJob({ name: "after_it", schedule: "0 9 * * *", ceilings: { maxDurationMs: 50 }, run: async () => void ran.push("after_it") }),
    ];
    const t0 = Date.now();
    const outcomes = await runJobsConcurrently(jobs, (j, signal) => context(j, signal, MONDAY_0900), undefined, undefined, { concurrency: 1, deadline: t0 + 200 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(ran).toEqual([]);
    expect(outcomes[1]).toMatchObject({ status: "failed" });
    expect(outcomes[1]?.error).toContain("was not started");
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

  it("runs a job anyway when the overlap check cannot read the run rows, and says so", async () => {
    let ran = false;
    const warnings: string[] = [];
    const job = defineJob<RunnerEnv>({ name: "sched_overlap_unreadable", schedule: "* * * * *", ceilings: { maxDurationMs: 60_000 }, run: async () => void (ran = true) });
    await seedRunning("sched_overlap_unreadable", new Date(Date.now() - 1_000));
    // Every other statement works; only the read of a previous running row fails.
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("status = 'running' AND started_at >")) throw new Error("D1_ERROR: run rows unavailable");
        return env.DB.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    } as unknown as D1Database;
    const base = runnerContext(job, new AbortController().signal);
    const outcome = await createJobRunner<RunnerEnv>()(job, { ...base, env: { ...base.env, DB: db }, log: { ...quietLog, warn: (msg) => void warnings.push(msg) } });
    expect(ran).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(warnings).toContain("could not check for a previous run; running anyway");
    expect(await latest("sched_overlap_unreadable")).toMatchObject({ status: "completed" });
  });

  it("refuses a job whose ceiling could never fit in one cron invocation", () => {
    expect(() => defineJob({ name: "too_long", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: MAX_JOB_DURATION_MS + 1 }, run: () => Promise.resolve({}) })).toThrow(/could never start/);
    expect(defineJob({ name: "just_fits", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: MAX_JOB_DURATION_MS }, run: () => Promise.resolve({}) }).name).toBe("just_fits");
  });
});

describe("the scheduled handler", () => {
  const testEnv = env as unknown as Env;
  const fire = async (worker: ReturnType<typeof createWorker>, at: string) => {
    const controller = createScheduledController({ cron: "* * * * *", scheduledTime: new Date(at) });
    const ctx = createExecutionContext();
    await (worker.scheduled as (c: ScheduledController, e: Env, x: ExecutionContext) => Promise<void>)(controller, testEnv, ctx);
    await waitOnExecutionContext(ctx);
  };

  it("logs every failed outcome with its job and error, and nothing for the jobs that completed", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      const worker = createWorker(config, {
        jobs: [
          { name: "breaks_job", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 1_000 }, run: async () => {} },
          { name: "fine_job", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 1_000 }, run: async () => {} },
        ],
        runner: async (job): Promise<JobOutcome> =>
          job.name === "breaks_job" ? { job: job.name, status: "failed", durationMs: 0, error: "breaks_job broke" } : { job: job.name, status: "completed", durationMs: 0 },
      });
      await fire(worker, "2026-11-02T09:00:00Z");
    } finally {
      spy.mockRestore();
    }
    const failed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === "scheduled job failed");
    expect(failed).toEqual([{ level: "error", msg: "scheduled job failed", service: "gtm-agents", cron: "* * * * *", job: "breaks_job", error: "breaks_job broke" }]);
  });

  it("gives each concurrent job its own start time as now: a job that waited for a slot sees a later clock", async () => {
    const nows = new Map<string, number>();
    const waiting = (name: string) => ({ name, schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 1_000 }, run: async (ctx: JobContext<Env>) => {
      nows.set(name, ctx.now.getTime());
      await new Promise((r) => setTimeout(r, 60));
    } });
    const busy = Array.from({ length: DUE_JOB_CONCURRENCY }, (_v, i) => waiting(`busy_${i}`));
    const worker = createWorker(config, {
      jobs: [...busy, waiting("waits_for_slot")],
      runner: async (job, ctx) => {
        await job.run(ctx);
        return { job: job.name, status: "completed", durationMs: 0 };
      },
    });
    await fire(worker, "2026-11-02T09:00:00Z");
    const firstWave = busy.map((j) => nows.get(j.name) ?? Number.NaN);
    expect(firstWave.every(Number.isFinite)).toBe(true);
    expect((nows.get("waits_for_slot") ?? 0) - Math.min(...firstWave)).toBeGreaterThanOrEqual(50);
  });
});

describe("cron health reruns", () => {
  it("give each rerun the time it starts as now, from the check's clock, not the check's own start time", async () => {
    const store = new Map<string, string>();
    const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
    const seen: Date[] = [];
    const name = `sched_rerun_clock_${crypto.randomUUID().slice(0, 8)}`;
    const missed = defineJob<RunnerEnv>({ name, schedule: "0 9 * * *", critical: true, rerunnable: true, ceilings: { maxDurationMs: 1_000 }, run: async (ctx) => void seen.push(ctx.now) });
    let tick = 0;
    const clock = () => new Date(Date.parse("2026-11-04T12:00:00.000Z") + tick++ * 60_000);
    let registry = createJobRegistry<RunnerEnv>([]);
    const health = createCronHealthJob<RunnerEnv>({ schedule: "30 10 * * *", registry: () => registry, runner: createJobRunner<RunnerEnv>(), now: clock });
    registry = createJobRegistry<RunnerEnv>([missed, health]);
    const checkStarted = new Date("2026-11-04T10:30:00.000Z");
    const result = await health.run({
      env: { DB: env.DB, KV: kv },
      config,
      job: CRON_HEALTH_JOB,
      now: checkStarted,
      signal: new AbortController().signal,
      ceilings: health.ceilings,
      flags: { get: (k) => kv.get(k) },
      log: quietLog,
    });
    expect(result?.summary).toBe("1 critical job(s) checked, 1 unhealthy, 0 paged, 1 rerun");
    // The check read the clock at 12:00; the rerun started on the next reading, 12:01.
    expect(seen.map((d) => d.toISOString())).toEqual(["2026-11-04T12:01:00.000Z"]);
  });
});
