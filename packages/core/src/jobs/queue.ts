// GTM-agents: scheduled jobs through a queue, so a busy minute never runs out of time.
//
// With a JOBS_QUEUE binding and the scheduler:queue_enabled flag on, the scheduled handler does not
// run the due jobs itself. Each minute it
// sends one message per due job (the job's name and its scheduled minute) and returns. The queue's
// consumer, with max_batch_size 1, runs each job in its own invocation, with its own 15-minute wall
// time, through the same fault-tolerant runner (halt, flags, budget, overlap guard, run rows, pages).
//
// What holds:
//   - exactly once per (job, minute): before a message's job runs, the consumer claims
//     `job-run:<job>:<minute>` in the effects ledger. A redelivered message, a second trigger in the
//     same minute, or a cron health rerun of the same fire finds the claim and does nothing. A claim
//     that cannot be written (the database is down) fails closed: the job does not run, the message
//     is retried, and after its retries it reaches the dead-letter queue;
//   - never lost silently: a redelivered message whose fire was claimed by an invocation that ended
//     before writing any run row records a failed row for it; the dead-letter consumer records a failed run row for every job whose
//     message it receives (unless the fire was claimed, so it ran or is running), and pages the
//     operator once per UTC day, however many messages arrive;
//   - a backed-up queue never runs a stale fire after a fresher one: a message whose job already has
//     a later fire claimed is recorded as skipped ("superseded"). A fire that merely waited for a
//     consumer still runs, so a busy queue delays a per-minute job but never starves it;
//   - `now` is the real start time, never before the scheduled minute, as on the in-process path.
// When a send to the queue fails, the jobs it did not take run in the scheduled invocation itself,
// each claimed the same way, so a job is neither lost nor run twice if the send half worked.
import { claimEffect } from "../events/effects.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { claimPage, notifyWithin, recordJobRun, releasePage } from "../runtime/job-runner.ts";
import type { KvStore } from "../shared/kv.ts";
import { cronMatches, type CronSchedule } from "./cron.ts";
import { runJobsConcurrently, runOneJob, type ContextFactory, type JobOutcome, type JobRunner } from "./loop.ts";
import { MAX_JOB_DURATION_MS, type JobLogger, type JobRegistry, type RegisteredJob } from "./registry.ts";

/** The flag that sends due jobs to JOBS_QUEUE. Off by default; off, unreadable or unbound, jobs run in the cron invocation. */
export const JOBS_QUEUE_FLAG = "scheduler:queue_enabled";

/** The `kind` every jobs-queue message carries, so a consumer can tell one from any other message. */
export const JOB_MESSAGE_KIND = "gtm.job";

/** One due job on JOBS_QUEUE. */
export interface JobMessage {
  kind: typeof JOB_MESSAGE_KIND;
  /** The job's registered name. */
  job: string;
  /** The scheduled minute, ISO 8601 UTC with zero seconds. */
  minute: string;
}

/** What the scheduled handler needs from the JOBS_QUEUE binding. */
export interface JobQueue {
  sendBatch(messages: Iterable<MessageSendRequest<JobMessage>>): Promise<unknown>;
}

/** Messages per sendBatch call: Cloudflare's limit. */
export const MAX_SEND_BATCH = 100;

/** The effect a fire's run is claimed under. */
export const JOB_RUN_EFFECT = "run";

/** The effects-ledger event id for one job's fire at one minute. */
export const jobRunKey = (job: string, minute: string): string => `job-run:${job}:${minute}`;

/** The minute `at` falls in, as the ISO string messages and claims use. */
export function minuteOf(at: Date): string {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
}

const MINUTE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;

export function isJobMessage(body: unknown): body is JobMessage {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.kind === JOB_MESSAGE_KIND && typeof b.job === "string" && b.job !== "" && typeof b.minute === "string" && MINUTE_ISO.test(b.minute);
}

/** How far ahead firedSince looks before it gives up: the longest a message can be retained on any plan. */
const SUPERSEDE_LOOKAHEAD_MINUTES = 14 * 24 * 60;

/** The first minute after `minute`, up to and including `now`, at which the schedule fires again, or null. */
export function firedSince(cron: CronSchedule, minute: Date, now: Date): Date | null {
  const last = Math.min(Math.floor(now.getTime() / 60_000), Math.floor(minute.getTime() / 60_000) + SUPERSEDE_LOOKAHEAD_MINUTES);
  for (let m = Math.floor(minute.getTime() / 60_000) + 1; m <= last; m++) {
    const at = new Date(m * 60_000);
    if (cronMatches(cron, at)) return at;
  }
  return null;
}

export interface EnqueueResult<E> {
  enqueued: RegisteredJob<E>[];
  /** Jobs whose message could not be sent. */
  failed: RegisteredJob<E>[];
  error?: string;
}

/** Send one message per job, in order, at most MAX_SEND_BATCH per call. Never throws. */
export async function enqueueDueJobs<E>(queue: JobQueue, jobs: readonly RegisteredJob<E>[], at: Date): Promise<EnqueueResult<E>> {
  const minute = minuteOf(at);
  const result: EnqueueResult<E> = { enqueued: [], failed: [] };
  for (let i = 0; i < jobs.length; i += MAX_SEND_BATCH) {
    const chunk = jobs.slice(i, i + MAX_SEND_BATCH);
    try {
      await queue.sendBatch(chunk.map((job) => ({ body: { kind: JOB_MESSAGE_KIND, job: job.name, minute }, contentType: "json" as const })));
      result.enqueued.push(...chunk);
    } catch (error) {
      result.failed.push(...chunk);
      result.error = sanitizeErrorMessage(error);
    }
  }
  return result;
}

export interface ClaimedRunOptions<E> {
  db: D1Database;
  /** The context factory for jobs scheduled at `at`. */
  makeContext: ContextFactory<E>;
  runner: JobRunner<E>;
  track?: (settled: Promise<unknown>) => void;
  log: JobLogger;
  /** Epoch milliseconds by which every job must be able to finish. */
  deadline: number;
}

/**
 * Run jobs in this invocation, each only if this call wins its (job, minute) claim: the fallback when
 * the queue would not take their messages. A claim that cannot be written skips the job (fail closed).
 */
export async function runClaimedJobs<E>(jobs: readonly RegisteredJob<E>[], at: Date, options: ClaimedRunOptions<E>): Promise<JobOutcome[]> {
  const minute = minuteOf(at);
  const claimed: RegisteredJob<E>[] = [];
  for (const job of jobs) {
    try {
      if (await claimEffect(options.db, jobRunKey(job.name, minute), JOB_RUN_EFFECT)) claimed.push(job);
    } catch (error) {
      options.log.error("a due job could not be claimed, so it did not run", { job: job.name, minute, error: sanitizeErrorMessage(error) });
    }
  }
  return runJobsConcurrently(claimed, options.makeContext, options.runner, options.track, { deadline: options.deadline });
}

export interface JobsConsumerOptions<E> {
  registry: JobRegistry<E>;
  runner: JobRunner<E>;
  db: (env: E) => D1Database;
  /** The context factory for one job's fire at `at`. Its `now` must be the real start time. */
  makeContext: (env: E, at: Date) => ContextFactory<E>;
  log: JobLogger;
  /** Called with each job's outcome, for observability. */
  onOutcome?: (outcome: JobOutcome) => void;
  /** Epoch milliseconds now. Defaults to Date.now; tests pass their own. */
  clock?: () => number;
  /** Wall time one consumer invocation plans for. Defaults to MAX_JOB_DURATION_MS. */
  budgetMs?: number;
  /** Seconds before a message whose claim could not be written is delivered again. */
  retryDelaySeconds?: number;
}

/** Seconds before a message whose claim failed is delivered again. */
export const JOB_RETRY_DELAY_SECONDS = 30;

/**
 * The JOBS_QUEUE consumer. With max_batch_size 1 each invocation runs one job; a larger batch runs
 * its jobs one after another, and a message whose job could not finish within the invocation is
 * delivered again unclaimed. Every message is acknowledged once its job's runner has settled.
 */
export function createJobsConsumer<E>(options: JobsConsumerOptions<E>): (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void> {
  const clock = options.clock ?? Date.now;
  const budget = options.budgetMs ?? MAX_JOB_DURATION_MS;
  const retryDelay = options.retryDelaySeconds ?? JOB_RETRY_DELAY_SECONDS;
  return async (batch, env, ctx) => {
    const deadline = clock() + budget;
    let started = 0;
    for (const message of batch.messages) {
      const body = message.body;
      if (!isJobMessage(body)) {
        options.log.warn("a message on the jobs queue is not a job message; dropping it", { queue: batch.queue });
        message.ack();
        continue;
      }
      const job = options.registry.get(body.job);
      if (!job) {
        options.log.warn("a queued job is not registered (removed since it was enqueued?); dropping it", { job: body.job, minute: body.minute });
        message.ack();
        continue;
      }
      // The first job always fits: no ceiling is longer than the budget. Later ones must fit too.
      if (started > 0 && clock() + job.ceilings.maxDurationMs > deadline) {
        message.retry({ delaySeconds: 0 });
        continue;
      }
      const at = new Date(body.minute);
      const key = jobRunKey(job.name, body.minute);
      let claimed: boolean;
      try {
        claimed = await claimEffect(options.db(env), key, JOB_RUN_EFFECT);
      } catch (error) {
        options.log.error("a queued job could not be claimed; retrying the message", { job: job.name, minute: body.minute, attempts: message.attempts, error: sanitizeErrorMessage(error) });
        message.retry({ delaySeconds: retryDelay });
        continue;
      }
      if (!claimed) {
        // A redelivery after the invocation that claimed the fire ended early: if that run left no
        // row at all, record it as failed, so the fire is never lost without a trace.
        if (message.attempts > 1) await recordUnfinished(options.db(env), job, body.minute, new Date(clock()), options.log);
        else options.log.info("this job already ran for its minute; nothing to do", { job: job.name, minute: body.minute });
        message.ack();
        continue;
      }
      started += 1;
      const later = await laterClaim(options.db(env), job.name, body.minute);
      const base = options.makeContext(env, at);
      const factory: ContextFactory<E> = later
        ? (j, signal) => ({ ...base(j, signal), superseded: `superseded: this ${body.minute} fire was delivered after a later one (${later}) was claimed` })
        : base;
      const outcome = await runOneJob(job, factory, options.runner, (settled) => ctx.waitUntil(settled));
      try {
        options.onOutcome?.(outcome);
      } catch {
        // Observability only.
      }
      message.ack();
    }
  };
}

/**
 * The minute of a later fire of this job that has already been claimed, or null. A read error
 * counts as none: the fire runs, and the claim and the overlap guard still hold.
 */
async function laterClaim(db: D1Database, job: string, minute: string): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT event_id FROM event_effects WHERE event_id > ?1 AND event_id < ?2 AND effect = ?3 ORDER BY event_id DESC LIMIT 1")
      .bind(jobRunKey(job, minute), `job-run:${job};`, JOB_RUN_EFFECT)
      .first<{ event_id: string }>();
    return row ? row.event_id.slice(`job-run:${job}:`.length) : null;
  } catch {
    return null;
  }
}

/**
 * Record a failed run row for a claimed fire that left none: no row started between its minute and
 * the job's next fire. Bookkeeping: never throws.
 */
async function recordUnfinished<E>(db: D1Database, job: RegisteredJob<E>, minute: string, now: Date, log: JobLogger): Promise<void> {
  try {
    const start = new Date(minute);
    const next = firedSince(job.cron, start, new Date(start.getTime() + SUPERSEDE_LOOKAHEAD_MINUTES * 60_000));
    const row = await db
      .prepare("SELECT 1 AS hit FROM execution_runs WHERE task_name = ?1 AND started_at >= ?2 AND started_at < ?3 LIMIT 1")
      .bind(job.name, minute, next?.toISOString() ?? "9999-12-31T23:59:59.999Z")
      .first();
    if (row) return;
    await recordJobRun(db, { job: job.name, status: "failed", at: now, error: `the queued run for ${minute} was claimed, but its invocation ended before it recorded a result` });
    log.error("a claimed job left no run row; recorded it as failed", { job: job.name, minute });
  } catch (error) {
    log.warn("a claimed job's run row could not be checked", { job: job.name, minute, error: sanitizeErrorMessage(error) });
  }
}

export interface DeadLetterOptions<E> {
  registry: JobRegistry<E>;
  db: (env: E) => D1Database;
  kv?: (env: E) => KvStore | undefined;
  operator?: (env: E) => OperatorChannel | undefined;
  log: JobLogger;
  now?: () => Date;
}

/** Jobs listed by name in the dead-letter page, at most. */
const DEAD_LETTER_LISTED = 10;

/**
 * The jobs dead-letter consumer. For each message whose fire was never claimed, it claims the fire
 * (so a late copy cannot run it after it was recorded as lost) and records a failed run row; cron
 * health then reruns it if the job is rerunnable. It pages the operator once per UTC day. Every
 * message is acknowledged: a dead-letter queue is never retried.
 */
export function createJobsDeadLetterConsumer<E>(options: DeadLetterOptions<E>): (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void> {
  const now = options.now ?? (() => new Date());
  return async (batch, env) => {
    const db = options.db(env);
    const lost: string[] = [];
    for (const message of batch.messages) {
      const body = message.body;
      if (!isJobMessage(body) || !options.registry.get(body.job)) {
        message.ack();
        continue;
      }
      let claimed: boolean | null;
      try {
        claimed = await claimEffect(db, jobRunKey(body.job, body.minute), JOB_RUN_EFFECT);
      } catch {
        claimed = null;
      }
      // Claimed before: the job ran, or is running, and has its own run row.
      if (claimed === false) {
        message.ack();
        continue;
      }
      lost.push(`${body.job} at ${body.minute}`);
      try {
        await recordJobRun(db, { job: body.job, status: "failed", at: now(), error: `the queued run for ${body.minute} was dead-lettered after its retries and did not run` });
      } catch (error) {
        options.log.warn("a dead-lettered job's run row could not be written", { job: body.job, minute: body.minute, error: sanitizeErrorMessage(error) });
      }
      message.ack();
    }
    if (lost.length === 0) return;
    options.log.error("scheduled jobs were dead-lettered and did not run", { queue: batch.queue, jobs: lost.slice(0, DEAD_LETTER_LISTED), count: lost.length });
    let operator: OperatorChannel | undefined;
    try {
      operator = options.operator?.(env);
    } catch {
      operator = undefined;
    }
    if (!operator) return;
    let kv: KvStore | undefined;
    try {
      kv = options.kv?.(env);
    } catch {
      kv = undefined;
    }
    const eventId = `jobs-dlq:${now().toISOString().slice(0, 10)}`;
    try {
      if (!(await claimPage(db, kv, eventId, "page"))) return;
      const text = [
        `Scheduled jobs did not run: ${lost.length} queued run(s) reached the dead-letter queue (${lost.slice(0, DEAD_LETTER_LISTED).join(", ")}${lost.length > DEAD_LETTER_LISTED ? ", ..." : ""}).`,
        "Their claims could not be written, which usually means the database was unreachable. Each has a failed run row; cron health reruns the rerunnable ones.",
        "This is the only dead-letter page today.",
      ].join("\n");
      if (!(await notifyWithin(operator, text))) await releasePage(db, kv, eventId, "page");
    } catch (error) {
      options.log.warn("the dead-letter page could not be sent", { error: sanitizeErrorMessage(error) });
    }
  };
}

