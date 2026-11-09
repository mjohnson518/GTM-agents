// GTM-agents: run-row retention: a daily job that deletes old rows from execution_runs.
//
// The job runner writes a run row for every due job, skipped runs included, so a per-minute job adds
// about 1,440 rows a day even while its flag is off. With ops:retention_enabled on (off by default),
// the run_retention job deletes, once a day:
//   - skipped rows older than 7 days;
//   - completed rows older than 30 days;
//   - failed rows older than 90 days.
// It always keeps the newest row of each job and status, whatever its age: the cron health check
// reads the latest completed, skipped or failed run of a job that fires rarely, the follow-up sweep's
// intake check reads the newest finished inbox_poll row, and a job's failure streak is measured from
// its latest completed run. Running rows are never deleted (the overlap guard and the cron health
// check read them).
//
// It touches no other table: event_effects holds idempotency claims and cost_events holds the budget
// months, and both are the truth for a gate. A deleted run row only leaves cost and audit rows whose
// run_id names a run that is no longer listed.
//
// Bounded: rows are deleted in batches of RETENTION_BATCH_ROWS, at most ceilings.maxRows per run,
// and the pass stops between batches when the job's ceiling aborts it. A backlog (after turning the
// flag on for the first time on an old deployment) drains at that rate, which can take weeks; the
// summary says when rows remain. Migration 0022 indexes (task_name, status, started_at) for it.
//
// The job is not built in: a deployment registers createRetentionJob() in its jobs.
import { isFlagOn } from "../jobs/loop.ts";
import { defineJob, type RegisteredJob } from "../jobs/registry.ts";

export const RUN_RETENTION_JOB = "run_retention";
export const RUN_RETENTION_FLAG = "ops:retention_enabled";
export const DEFAULT_RUN_RETENTION_SCHEDULE = "40 3 * * *";
/** Days a run row of each status is kept. */
export const RUN_RETENTION_DAYS: Readonly<Record<RetainedStatus, number>> = Object.freeze({ skipped: 7, completed: 30, failed: 90 });
/** Rows deleted by one statement. */
export const RETENTION_BATCH_ROWS = 500;
/** Rows deleted by one run, unless the job's maxRows ceiling says otherwise. */
export const RETENTION_MAX_ROWS = 20_000;
export const RETENTION_CEILING_MS = 120_000;
/** Distinct job names considered per status in one run. */
const MAX_TASKS = 500;
const DAY_MS = 86_400_000;

export const RETAINED_STATUSES = ["skipped", "completed", "failed"] as const;
export type RetainedStatus = (typeof RETAINED_STATUSES)[number];

export interface PruneOptions {
  now: Date;
  /** The most rows this pass may delete. */
  maxRows: number;
  /** Rows per statement. Defaults to RETENTION_BATCH_ROWS. */
  batchRows?: number;
  /** Checked between batches: when aborted, the pass stops. */
  signal?: AbortSignal;
}

export interface PruneResult {
  deleted: Record<RetainedStatus, number>;
  total: number;
  /** False when the row ceiling, the signal or the job-name limit stopped the pass with old rows left. */
  complete: boolean;
}

/** Delete run rows past their retention, keeping the newest of each job and status. Throws on a database error. */
export async function pruneRunRows(db: D1Database, options: PruneOptions): Promise<PruneResult> {
  const batch = Math.max(1, Math.min(options.batchRows ?? RETENTION_BATCH_ROWS, RETENTION_BATCH_ROWS));
  const deleted: Record<RetainedStatus, number> = { skipped: 0, completed: 0, failed: 0 };
  let total = 0;
  let complete = true;
  for (const status of RETAINED_STATUSES) {
    const cutoff = new Date(options.now.getTime() - RUN_RETENTION_DAYS[status] * DAY_MS).toISOString();
    // The newest row of each job with this status is the bound nothing at or after is deleted. Only
    // jobs with a deletable row come back, so a job whose one old row is its newest costs nothing.
    const { results } = await db
      .prepare(
        `SELECT task_name, MAX(started_at) AS newest FROM execution_runs
          WHERE status = ?1 GROUP BY task_name HAVING MIN(started_at) < min(MAX(started_at), ?2) ORDER BY task_name LIMIT ${MAX_TASKS + 1}`,
      )
      .bind(status, cutoff)
      .all<{ task_name: string; newest: string }>();
    if (results.length > MAX_TASKS) complete = false;
    for (const { task_name: task, newest } of results.slice(0, MAX_TASKS)) {
      const bound = newest < cutoff ? newest : cutoff;
      for (;;) {
        if (options.signal?.aborted || total >= options.maxRows) return { deleted, total, complete: false };
        const limit = Math.min(batch, options.maxRows - total);
        const result = await db
          .prepare(
            `DELETE FROM execution_runs WHERE id IN (
               SELECT id FROM execution_runs WHERE task_name = ?1 AND status = ?2 AND started_at < ?3 ORDER BY started_at LIMIT ?4)`,
          )
          .bind(task, status, bound, limit)
          .run();
        const changes = Number(result.meta?.changes ?? 0);
        deleted[status] += changes;
        total += changes;
        if (changes < limit) break;
      }
    }
  }
  return { deleted, total, complete };
}

export interface RetentionJobOptions {
  /** When the job runs, as a job schedule. Defaults to 03:40 UTC every day. */
  schedule: string;
  /** Rows one run may delete. Defaults to RETENTION_MAX_ROWS. */
  maxRows: number;
}

/**
 * The run-row retention job, for the job registry. It runs only while ops:retention_enabled is on,
 * and re-reads the flag itself (an unreadable flag deletes nothing), so calling run() directly with
 * the flag off does nothing. Safe to rerun.
 */
export function createRetentionJob<E extends { DB: D1Database }>(options: Partial<RetentionJobOptions> = {}): RegisteredJob<E> {
  return defineJob<E>({
    name: RUN_RETENTION_JOB,
    schedule: options.schedule ?? DEFAULT_RUN_RETENTION_SCHEDULE,
    flag: RUN_RETENTION_FLAG,
    ceilings: { maxDurationMs: RETENTION_CEILING_MS, maxRows: options.maxRows ?? RETENTION_MAX_ROWS },
    rerunnable: true,
    async run(ctx) {
      let on: boolean;
      try {
        on = isFlagOn(await ctx.flags.get(RUN_RETENTION_FLAG));
      } catch {
        on = false;
      }
      if (!on) return { summary: "flag off" };
      const result = await pruneRunRows(ctx.env.DB, { now: ctx.now, maxRows: ctx.ceilings.maxRows ?? RETENTION_MAX_ROWS, signal: ctx.signal });
      const { skipped, completed, failed } = result.deleted;
      const rest = result.complete ? "" : "; older rows remain for the next run";
      return { summary: `deleted ${result.total} run rows (${skipped} skipped, ${completed} completed, ${failed} failed)${rest}`, rows: result.total };
    },
  });
}
