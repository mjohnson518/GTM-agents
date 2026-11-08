// GTM-agents: the fault-tolerant job runner, the default runner of createWorker.
//
// For every scheduled job it:
//   1. checks the system halt (fail closed), the job's flag (fail closed) and, for a job that
//      declares ceilings.maxSpendCents or has a budget:job:<job>:daily_cents cap, the budget gate
//      (fail closed). A job held by any of them is not run, and leaves a "skipped" run row saying
//      why; a hold caused by state that could not be read says "unreadable";
//   2. writes a "running" row, runs the job with its duration ceiling, and finishes the row as
//      "completed" or "failed" with a sanitized error and an error class;
//   3. on failure, pages the operator at most once per job per UTC day, and escalates at most once
//      per job per day when the error looks like configuration, the job failed three times today,
//      or it has failed three days in a row. Each page is claimed in the effects ledger before it is
//      sent and released if sending fails, so a retry can page again.
// Bookkeeping fails open: a run row or page that cannot be written is logged and dropped, and never
// turns a successful job into a failed one. Raw error text is never stored: errors pass through
// sanitizeErrorMessage first.
import { checkBudget, jobCapKey } from "../budget/gate.ts";
import { claimEffect, hasEffect, releaseEffect } from "../events/effects.ts";
import { isFlagOn, withTimeout, type JobOutcome, type JobRunner } from "../jobs/loop.ts";
import type { JobLogger, JobTrigger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { readHalt } from "../security/halt.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { startOfUtcDay, type KvStore } from "../shared/kv.ts";

/** The bindings the runner needs. A deployment's Env satisfies it. */
export interface RunnerEnv {
  DB: D1Database;
  KV?: KvStore;
}

export interface JobRunnerOptions<E> {
  /** The operator channel for failure pages. Without one, failures are recorded but not paged. */
  operator?: (env: E) => OperatorChannel | undefined;
  /** The clock for run timestamps. */
  now?: () => Date;
}

export const ESCALATE_FAILURES_PER_DAY = 3;
export const ESCALATE_STREAK_DAYS = 3;
const FALLBACK_TTL_SECONDS = 2 * 24 * 60 * 60;
/** How long a page may take before its claim is released for a later retry. */
export const NOTIFY_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

export type JobErrorClass = "transient" | "config" | "unknown";

// Word-bounded, so "4290 rows" is not a 429 and "unauthorized_scopes" still reads as auth.
const CONFIG_ERRORS = [
  /\b(?:401|403)\b/,
  /\bunauthori[sz]ed/i,
  /\bforbidden\b/i,
  /\binvalid api key\b/i,
  /\bmissing (?:binding|secret|credentials?)\b/i,
  /\bno such table\b/i,
  /\bis not configured\b/i,
];
const TRANSIENT_ERRORS = [
  /\b(?:429|500|502|503|504)\b/,
  /\btoo many requests\b/i,
  /\bnetwork connection (?:was )?lost\b/i,
  /\btimed? ?out\b/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bfetch failed\b/i,
  /\bD1_ERROR\b/,
  /\bSQLITE_BUSY\b/,
  /\brate limit/i,
  /\bexceeded its \d+ ms ceiling\b/,
];

/** Classify a sanitized error message. Configuration errors win, because a retry will not fix them. */
export function classifyJobError(message: string): JobErrorClass {
  if (CONFIG_ERRORS.some((p) => p.test(message))) return "config";
  if (TRANSIENT_ERRORS.some((p) => p.test(message))) return "transient";
  return "unknown";
}

interface RunRow {
  id: string;
  task: string;
  trigger: JobTrigger;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
  errorClass?: JobErrorClass;
}

async function insertRun(db: D1Database, row: RunRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO execution_runs (id, task_name, trigger, status, started_at, finished_at, duration_ms, summary, error, error_class, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?5)`,
    )
    .bind(row.id, row.task, row.trigger, row.status, row.startedAt, row.finishedAt ?? null, row.durationMs ?? null, row.summary ?? null, row.error ?? null, row.errorClass ?? null)
    .run();
}

/** Finish a run row, inserting it if the "running" insert never landed, so a run never goes unrecorded. */
async function finishRun(db: D1Database, row: RunRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO execution_runs (id, task_name, trigger, status, started_at, finished_at, duration_ms, summary, error, error_class, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?5)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, duration_ms = excluded.duration_ms,
         summary = excluded.summary, error = excluded.error, error_class = excluded.error_class`,
    )
    .bind(row.id, row.task, row.trigger, row.status, row.startedAt, row.finishedAt ?? null, row.durationMs ?? null, row.summary ?? null, row.error ?? null, row.errorClass ?? null)
    .run();
}

/** Failures today, and the number of consecutive days (ending today) with a failure and no success. */
export async function failureStats(db: D1Database, job: string, now: Date): Promise<{ today: number; streak: number }> {
  const day = startOfUtcDay(now);
  const today = await db
    .prepare("SELECT COUNT(*) AS n FROM execution_runs WHERE task_name = ?1 AND status = 'failed' AND started_at >= ?2")
    .bind(job, day)
    .first<{ n: number }>();
  const { results } = await db
    .prepare(
      `SELECT DISTINCT substr(started_at, 1, 10) AS day FROM execution_runs
        WHERE task_name = ?1 AND status = 'failed' AND started_at >= ?2
          AND started_at > COALESCE((SELECT MAX(started_at) FROM execution_runs WHERE task_name = ?1 AND status = 'completed'), '')
        ORDER BY day DESC`,
    )
    .bind(job, new Date(Date.parse(day) - 14 * DAY_MS).toISOString())
    .all<{ day: string }>();
  let streak = 0;
  let cursor = Date.parse(day);
  for (const row of results) {
    if (Date.parse(`${row.day}T00:00:00.000Z`) !== cursor) break;
    streak += 1;
    cursor -= DAY_MS;
  }
  return { today: Number(today?.n ?? 0), streak };
}

const fallbackKey = (eventId: string, effect: string) => `effect-fallback:${eventId}:${effect}`;

/**
 * Claim a page in the effects ledger. If the database cannot be reached (often the reason the job
 * failed), fall back to a KV marker so an outage still pages once a day rather than never or on
 * every run. A marker left by an earlier outage counts as a claim, so recovery does not page
 * twice. False when neither store answers.
 */
export async function claimPage(db: D1Database, kv: KvStore | undefined, eventId: string, effect: string): Promise<boolean> {
  try {
    if (kv && (await kv.get(fallbackKey(eventId, effect))) !== null) return false;
  } catch {
    // An unreadable marker store is not a claim; the ledger decides below.
  }
  try {
    return await claimEffect(db, eventId, effect);
  } catch {
    try {
      if (!kv) return false;
      if ((await kv.get(fallbackKey(eventId, effect))) !== null) return false;
      await kv.put(fallbackKey(eventId, effect), "1", { expirationTtl: FALLBACK_TTL_SECONDS });
      return true;
    } catch {
      return false;
    }
  }
}

export async function releasePage(db: D1Database, kv: KvStore | undefined, eventId: string, effect: string): Promise<void> {
  await releaseEffect(db, eventId, effect);
  try {
    await kv?.delete(fallbackKey(eventId, effect));
  } catch {
    // Bookkeeping: a stale marker only means no retry today.
  }
}

interface FailureNotice {
  db: D1Database;
  kv: KvStore | undefined;
  operator: OperatorChannel | undefined;
  job: string;
  message: string;
  errorClass: JobErrorClass;
  now: Date;
  log: JobLogger;
}

/** Page the operator about a failure, within the once-a-day limits. Never throws. */
export async function notifyJobFailure(n: FailureNotice): Promise<"paged" | "escalated" | "quiet"> {
  if (!n.operator) return "quiet";
  try {
    const eventId = `job:${n.job}:${n.now.toISOString().slice(0, 10)}`;
    const stats = await failureStats(n.db, n.job, n.now).catch(() => null);
    const reasons: string[] = [];
    if (n.errorClass === "config") reasons.push("the error looks like configuration (credentials, permissions or a missing binding), which a retry will not fix");
    if (stats && stats.today >= ESCALATE_FAILURES_PER_DAY) reasons.push(`${stats.today} failures today`);
    if (stats && stats.streak >= ESCALATE_STREAK_DAYS) reasons.push(`failing ${stats.streak} days in a row`);
    const escalate = reasons.length > 0;
    if (!escalate && (await hasEffect(n.db, eventId, "escalation").catch(() => false))) return "quiet";
    const effect = escalate ? "escalation" : "failure_page";
    if (!(await claimPage(n.db, n.kv, eventId, effect))) return "quiet";
    const text = escalate
      ? `Job escalated: ${n.job}\nWhy: ${reasons.join("; ")}.\nLatest error (${n.errorClass}): ${n.message}\nThis is the only escalation for this job today.`
      : `Job failed: ${n.job}\nError (${n.errorClass}): ${n.message}\nThe next scheduled run retries. Further failures of this job today are recorded without another page.`;
    if (!(await notifyWithin(n.operator, text))) {
      await releasePage(n.db, n.kv, eventId, effect);
      return "quiet";
    }
    return escalate ? "escalated" : "paged";
  } catch (error) {
    n.log.warn("failure page could not be sent", { job: n.job, error: sanitizeErrorMessage(error) });
    return "quiet";
  }
}

/**
 * Send one operator message within NOTIFY_TIMEOUT_MS. False when it failed or took too long, so
 * the caller can release its claim and let a later run retry. A message that arrives after the
 * time-out can therefore be followed by a retry; a duplicate page is preferred to none.
 */
export async function notifyWithin(operator: OperatorChannel, text: string, timeoutMs: number = NOTIFY_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([operator.notify({ text }).then(() => true as const), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createJobRunner<E extends RunnerEnv>(options: JobRunnerOptions<E> = {}): JobRunner<E> {
  const clock = options.now ?? (() => new Date());
  return async (job, ctx): Promise<JobOutcome> => {
    const startedMs = Date.now();
    const startedAt = clock();
    const db = ctx.env.DB;
    const kv = ctx.env.KV;
    const trigger = ctx.trigger ?? "cron";
    const id = crypto.randomUUID();
    const elapsed = () => Date.now() - startedMs;
    const bookkeep = async (what: string, write: () => Promise<void>) => {
      try {
        await write();
      } catch (error) {
        ctx.log.warn(`run row could not be ${what}`, { job: job.name, error: sanitizeErrorMessage(error) });
      }
    };
    const skip = async (reason: string): Promise<JobOutcome> => {
      const durationMs = elapsed();
      await bookkeep("written", () =>
        insertRun(db, { id, task: job.name, trigger, status: "skipped", startedAt: startedAt.toISOString(), finishedAt: clock().toISOString(), durationMs, summary: reason }),
      );
      return { job: job.name, status: "skipped", durationMs, summary: reason };
    };

    const halt = await readHalt(kv);
    if (halt.halted) return skip(halt.unreadable ? "halt flag unreadable" : "halted");
    if (job.flag) {
      let value: string | null;
      try {
        value = await ctx.flags.get(job.flag);
      } catch {
        return skip("flag unreadable");
      }
      if (!isFlagOn(value)) return skip("flag off");
    }
    // A job is budget-checked when it declares maxSpendCents or the operator has set a daily cap
    // flag for it. The cap flag is read here so a flag-only cap is enforced too.
    let capFlag: string | null;
    try {
      capFlag = await ctx.flags.get(jobCapKey(job.name));
    } catch {
      return skip("budget: unreadable");
    }
    if (job.ceilings.maxSpendCents !== undefined || (capFlag !== null && capFlag.trim() !== "")) {
      const budget = await checkBudget({
        db,
        flags: ctx.flags,
        now: startedAt,
        job: job.name,
        ...(job.ceilings.maxSpendCents !== undefined ? { jobCapCents: job.ceilings.maxSpendCents } : {}),
      });
      if (!budget.allowed) return skip(`budget: ${budget.reason}`);
    }

    await bookkeep("written", () => insertRun(db, { id, task: job.name, trigger, status: "running", startedAt: startedAt.toISOString() }));

    let outcome: JobOutcome;
    let errorClass: JobErrorClass | undefined;
    try {
      if (ctx.signal.aborted) throw new Error(`job ${job.name} exceeded its ${job.ceilings.maxDurationMs} ms ceiling before it started`);
      const result = await withTimeout(job.run({ ...ctx, trigger, runId: id }), ctx.signal, job.ceilings.maxDurationMs, job.name);
      const summary = result && typeof result.summary === "string" ? result.summary.slice(0, 500) : undefined;
      outcome = { job: job.name, status: "completed", durationMs: elapsed(), ...(summary ? { summary } : {}) };
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      errorClass = classifyJobError(message);
      outcome = { job: job.name, status: "failed", durationMs: elapsed(), error: message };
    }

    await bookkeep("finished", () =>
      finishRun(db, {
        id,
        task: job.name,
        trigger,
        status: outcome.status,
        startedAt: startedAt.toISOString(),
        finishedAt: clock().toISOString(),
        durationMs: outcome.durationMs,
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(errorClass ? { errorClass } : {}),
      }),
    );

    if (outcome.status === "failed") {
      ctx.log.error("job failed", { job: job.name, error: outcome.error, errorClass });
      let operator: OperatorChannel | undefined;
      try {
        operator = options.operator?.(ctx.env);
      } catch {
        operator = undefined;
      }
      await notifyJobFailure({ db, kv, operator, job: job.name, message: outcome.error ?? "unknown error", errorClass: errorClass ?? "unknown", now: clock(), log: ctx.log });
    }
    return outcome;
  };
}
