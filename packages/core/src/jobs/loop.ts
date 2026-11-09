// GTM-agents: the scheduled-handler loop. Jobs whose schedule matches the minute run concurrently,
// each under its own ceiling; a failure in one job never affects another. The runner is pluggable so the
// fault-tolerant runner (run rows, operator paging, halt checks) can replace the default.
//
// A ceiling is not a hard stop. JavaScript cannot cancel a promise: at the ceiling the job's signal
// aborts and its run is recorded as failed, but a job body that ignores the signal keeps running.
// So a concurrency slot stays taken until the body and the runner actually settle, the invocation's
// deadline passes, or no job is left waiting for a slot, whichever comes first. A body that never settles
// therefore costs the minute one slot, never a second copy of its connections beside the jobs
// after it.
import { HALT_KEY } from "../security/halt.ts";
import type { JobContext, JobRegistry, RegisteredJob } from "./registry.ts";

export interface JobOutcome {
  job: string;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  summary?: string;
  error?: string;
}

export type JobRunner<E = unknown> = (job: RegisteredJob<E>, ctx: JobContext<E>) => Promise<JobOutcome>;

export type ContextFactory<E = unknown> = (job: RegisteredJob<E>, signal: AbortSignal) => JobContext<E>;

const ON_VALUES = new Set(["true", "on", "1", "yes"]);

/** True for the values that turn a boolean flag on: true, on, 1, yes (any case). */
export function isFlagOn(value: string | null): boolean {
  return value !== null && ON_VALUES.has(value.trim().toLowerCase());
}

export const HALT_FLAG = HALT_KEY;

/**
 * The default runner: respects the halt flag, checks the job's flag, enforces the duration
 * ceiling, and turns every error into a failed outcome. Both flag reads fail closed: a halt flag
 * that cannot be read counts as halted, and a job flag that cannot be read keeps the job off.
 */
export async function defaultRunner<E>(job: RegisteredJob<E>, ctx: JobContext<E>): Promise<JobOutcome> {
  const started = Date.now();
  let halted: boolean;
  try {
    halted = (await ctx.flags.get(HALT_KEY)) !== null;
  } catch {
    halted = true;
  }
  if (halted) {
    ctx.log.warn("job skipped: the system is halted or the halt flag could not be read", { job: job.name });
    return { job: job.name, status: "skipped", durationMs: Date.now() - started, summary: "halted" };
  }
  if (job.flag) {
    let value: string | null;
    try {
      value = await ctx.flags.get(job.flag);
    } catch {
      ctx.log.warn("job skipped: its flag could not be read", { job: job.name, flag: job.flag });
      return { job: job.name, status: "skipped", durationMs: Date.now() - started, summary: "flag unreadable" };
    }
    if (!isFlagOn(value)) {
      return { job: job.name, status: "skipped", durationMs: Date.now() - started, summary: "flag off" };
    }
  }
  try {
    if (ctx.notStarted) throw new Error(ctx.notStarted);
    if (ctx.signal.aborted) throw new Error(`job ${job.name} exceeded its ${job.ceilings.maxDurationMs} ms ceiling before it started`);
    const result = await withTimeout(job.run(ctx), ctx.signal, job.ceilings.maxDurationMs, job.name);
    return { job: job.name, status: "completed", durationMs: Date.now() - started, ...(result?.summary ? { summary: result.summary } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error("job failed", { job: job.name, error: message });
    return { job: job.name, status: "failed", durationMs: Date.now() - started, error: message };
  }
}

/** Resolve with `work`, or reject when `signal` aborts (the job's duration ceiling). */
export function withTimeout<T>(work: Promise<T>, signal: AbortSignal, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`job ${name} exceeded its ${ms} ms ceiling`));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Grace period after the ceiling before the loop stops waiting for a runner that never settles. */
const RUNNER_GRACE_MS = 1_000;

interface StartedJob {
  /** The job's outcome: when the runner settles, or the loop gives up on it. */
  outcome: Promise<JobOutcome>;
  /** Settles once the runner and the job's own body (if it was started) have both settled. */
  settled: Promise<void>;
}

const quietly = (work: unknown): Promise<void> => Promise.resolve(work).then(
  () => undefined,
  () => undefined,
);

/**
 * Start one job with its ceiling enforced by the loop itself: the job's signal aborts at the
 * ceiling, and if the runner still has not settled shortly after, the outcome is a failure so the
 * job cannot block the jobs after it. The runner is handed a copy of the job whose run() is
 * watched, so the loop knows when the body itself settles.
 */
function startJob<E>(job: RegisteredJob<E>, makeContext: ContextFactory<E>, runner: JobRunner<E>, track?: (settled: Promise<unknown>) => void): StartedJob {
  const started = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), job.ceilings.maxDurationMs);
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  let body: Promise<void> = Promise.resolve();
  const watched: RegisteredJob<E> = Object.freeze({
    ...job,
    run: (ctx: JobContext<E>) => {
      const work = job.run(ctx);
      body = quietly(work);
      return work;
    },
  });
  const giveUp = new Promise<JobOutcome>((resolve) => {
    giveUpTimer = setTimeout(
      () => resolve({ job: job.name, status: "failed", durationMs: Date.now() - started, error: `job ${job.name} did not finish within its ${job.ceilings.maxDurationMs} ms ceiling` }),
      job.ceilings.maxDurationMs + RUNNER_GRACE_MS,
    );
  });
  const run = Promise.resolve().then(() => runner(watched, makeContext(watched, controller.signal)));
  // The loop may stop waiting before the runner finishes its bookkeeping (a slow failure page).
  // Tracking the runner lets the Worker keep running until it settles.
  track?.(run.catch(() => undefined));
  const outcome = Promise.race([run, giveUp])
    .catch((err: unknown): JobOutcome => ({ job: job.name, status: "failed", durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      clearTimeout(abortTimer);
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
    });
  // The body is read after the runner settles: by then the runner has called run(), or never will.
  const settled = quietly(run).then(() => body);
  return { outcome, settled };
}

/**
 * Run one job with its ceiling enforced by the loop itself: the job's signal aborts at the ceiling,
 * and if the runner still has not settled shortly after, the job is recorded as failed so it
 * cannot block the jobs after it. Always resolves.
 */
export async function runOneJob<E>(
  job: RegisteredJob<E>,
  makeContext: ContextFactory<E>,
  runner: JobRunner<E> = defaultRunner,
  /** Receives the runner's own promise, so a caller can keep the Worker alive until it settles. */
  track?: (settled: Promise<unknown>) => void,
): Promise<JobOutcome> {
  return startJob(job, makeContext, runner, track).outcome;
}

/**
 * Run `jobs` one after another through the same runner. Always resolves; never throws. The loop
 * enforces each job's ceiling itself, so a runner (or a flag read) that never settles cannot
 * block the jobs after it.
 */
export async function runJobsInOrder<E>(
  jobs: readonly RegisteredJob<E>[],
  makeContext: ContextFactory<E>,
  runner: JobRunner<E> = defaultRunner,
  track?: (settled: Promise<unknown>) => void,
): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) outcomes.push(await runOneJob(job, makeContext, runner, track));
  return outcomes;
}

/** How many due jobs run at once. Jobs mostly wait on D1, KV and providers; a small bound keeps one
 * busy minute from opening more connections than an invocation allows (six at a time). */
export const DUE_JOB_CONCURRENCY = 4;

/** Longest ceiling first, registration order among equals, so the jobs that need the most time start first. */
export function inRunOrder<E>(jobs: readonly RegisteredJob<E>[]): RegisteredJob<E>[] {
  return jobs.map((job, i) => ({ job, i })).sort((a, b) => b.job.ceilings.maxDurationMs - a.job.ceilings.maxDurationMs || a.i - b.i).map(({ job }) => job);
}

export interface ConcurrentOptions {
  /** Jobs running at once. Defaults to DUE_JOB_CONCURRENCY. */
  concurrency?: number;
  /**
   * Epoch milliseconds by which every job must be able to finish. A job whose ceiling would end
   * after it, checked when the job actually starts (after waiting for a slot), is not run: it goes
   * through the runner with ctx.notStarted, which records it as failed. It also bounds how long a
   * slot stays taken by a job that outlived its ceiling (its body, or the runner's own bookkeeping);
   * without a deadline, the slot is released as soon as the job's outcome is in.
   */
  deadline?: number;
  /** Epoch milliseconds now, for the deadline checks. Defaults to Date.now; tests pass their own. */
  clock?: () => number;
}

/**
 * Run `jobs` concurrently, at most `concurrency` at a time, each under its own ceiling and through
 * the same runner. One job's failure never affects another. Outcomes come back in input order.
 * Each job's deadline check, and its context (so its `now`), happen when it actually starts. A slot
 * whose job body outlived its ceiling stays taken until the body settles, the deadline passes, or no
 * job is left to start. Always resolves.
 */
export async function runJobsConcurrently<E>(
  jobs: readonly RegisteredJob<E>[],
  makeContext: ContextFactory<E>,
  runner: JobRunner<E> = defaultRunner,
  track?: (settled: Promise<unknown>) => void,
  options: ConcurrentOptions = {},
): Promise<JobOutcome[]> {
  const clock = options.clock ?? Date.now;
  const outcomes: JobOutcome[] = new Array<JobOutcome>(jobs.length);
  let next = 0;
  let markDrained: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    markDrained = resolve;
  });
  const take = (): number | undefined => {
    if (next >= jobs.length) return undefined;
    const index = next++;
    if (next >= jobs.length) markDrained();
    return index;
  };
  const worker = async () => {
    for (let index = take(); index !== undefined; index = take()) {
      const job = jobs[index] as RegisteredJob<E>;
      const late = options.deadline !== undefined && clock() + job.ceilings.maxDurationMs > options.deadline;
      const factory: ContextFactory<E> = late
        ? (j, signal) => ({ ...makeContext(j, signal), notStarted: `job ${j.name} was not started: its ${j.ceilings.maxDurationMs} ms ceiling would run past this invocation's time limit` })
        : makeContext;
      const started = startJob(job, factory, runner, track);
      outcomes[index] = await started.outcome;
      if (next < jobs.length && options.deadline !== undefined) await holdSlot(started.settled, drained, options.deadline - clock());
    }
  };
  const width = Math.max(1, Math.min(options.concurrency ?? DUE_JOB_CONCURRENCY, jobs.length));
  await Promise.all(Array.from({ length: width }, worker));
  return outcomes;
}

/** Wait for a job body to settle, for the last job to be taken, or for `ms`, whichever is first. */
async function holdSlot(settled: Promise<void>, drained: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([settled, drained, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run every job whose schedule fires at the minute of `at` (UTC), concurrently and longest ceiling
 * first: what the Worker's per-minute trigger does. A minute with nothing due resolves to []
 * without calling the runner or the context factory, so it touches no storage.
 */
export async function runDueJobs<E>(
  registry: JobRegistry<E>,
  at: Date,
  makeContext: ContextFactory<E>,
  runner: JobRunner<E> = defaultRunner,
  track?: (settled: Promise<unknown>) => void,
  options: ConcurrentOptions = {},
): Promise<JobOutcome[]> {
  return runJobsConcurrently(inRunOrder(registry.dueAt(at)), makeContext, runner, track, options);
}

/**
 * Run every job registered with exactly the schedule `cron`, sequentially, whatever the time: for
 * running one schedule on demand. The Worker's scheduled handler uses runDueJobs instead.
 */
export async function runScheduledJobs<E>(
  registry: JobRegistry<E>,
  cron: string,
  makeContext: ContextFactory<E>,
  runner: JobRunner<E> = defaultRunner,
  track?: (settled: Promise<unknown>) => void,
): Promise<JobOutcome[]> {
  return runJobsInOrder(registry.forCron(cron), makeContext, runner, track);
}
