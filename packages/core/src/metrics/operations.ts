// GTM-agents: the operational metrics: spend, failed jobs, and everything waiting on the operator.
//
//   - spendByJob: the cost ledger (cost_events) in the window, per job, most expensive first. A cost
//     recorded outside any job (the email provider's per-message cost, for example) is shown under
//     its provider, as "provider:<name>";
//   - failedJobs: scheduled, rerun and manual job runs (execution_runs) that failed in the window,
//     per job. Chat turns and delegated runs are not jobs;
//   - operatorQueue: what waits on a person now: drafts pending approval (by kind), approval
//     manifests that can still be released (by kind), owed replies (the reply clock's definition,
//     over its window: the deployment's owedWindowDays or the default, as replySla counts them)
//     and manual touches to make.
import { RELEASE_MAX_AGE_DAYS } from "../outreach/select.ts";
import { OWED_SQL } from "../replies/owed.ts";
import { SEQUENCE_LIMITS } from "../sequences/flags.ts";
import { owedWindowDays } from "./sla.ts";
import { n } from "./sql.ts";
import { DAY_MS, HOUR_MS, type MetricWindow } from "./window.ts";

export const MICRO_CENTS_PER_CENT = 10_000;

export interface JobSpend {
  job: string;
  microCents: number;
}

export interface Spend {
  totalMicroCents: number;
  /** Most expensive first. */
  jobs: JobSpend[];
}

/** Spend per job in the window. Throws on a database error. */
export async function spendByJob(db: D1Database, window: MetricWindow): Promise<Spend> {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(job, 'provider:' || provider) AS job, SUM(cost_micro_cents) AS micro
         FROM cost_events WHERE created_at >= ?1 AND created_at < ?2
        GROUP BY COALESCE(job, 'provider:' || provider)
        ORDER BY micro DESC, job ASC`,
    )
    .bind(window.from, window.to)
    .all<{ job: string; micro: number | null }>();
  const jobs = results.map((r) => ({ job: String(r.job), microCents: n(r.micro) }));
  return { totalMicroCents: jobs.reduce((sum, j) => sum + j.microCents, 0), jobs };
}

export interface JobFailures {
  job: string;
  failures: number;
}

/** Failed job runs in the window, per job, most failures first. Throws on a database error. */
export async function failedJobs(db: D1Database, window: MetricWindow): Promise<JobFailures[]> {
  const { results } = await db
    .prepare(
      `SELECT task_name AS job, COUNT(*) AS failures FROM execution_runs
        WHERE status = 'failed' AND trigger IN ('cron', 'rerun', 'manual') AND started_at >= ?1 AND started_at < ?2
        GROUP BY task_name ORDER BY failures DESC, job ASC`,
    )
    .bind(window.from, window.to)
    .all<{ job: string; failures: number }>();
  return results.map((r) => ({ job: String(r.job), failures: n(r.failures) }));
}

export interface OperatorQueue {
  /** Drafts pending approval, by draft kind, largest first. */
  pendingDrafts: Array<{ kind: string; drafts: number }>;
  /** Cold batch manifests (at most 14 days old) and follow-up manifests (at most 72 hours old) not released yet. */
  manifests: { coldBatches: number; sequences: number };
  /** Replies owed, inside the reply clock's window. */
  owedReplies: number;
  /** Manual touches asked for and not yet done, skipped or expired. */
  manualTouches: number;
}

/**
 * Everything waiting on the operator at `now`. Owed replies are counted over the reply window (the
 * deployment's owedWindowDays, or the default), exactly as replySla reads it. Throws on a database
 * error or a bad window.
 */
export async function operatorQueue(db: D1Database, now: Date, windowDays?: number): Promise<OperatorQueue> {
  const at = now.toISOString();
  const owedSince = new Date(now.getTime() - owedWindowDays(windowDays) * DAY_MS).toISOString();
  const [drafts, manifests, owed, touches] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT kind, COUNT(*) AS drafts FROM drafts WHERE status = 'pending_approval' GROUP BY kind ORDER BY drafts DESC, kind ASC"),
    db
      .prepare(
        `SELECT SUM(CASE WHEN kind = 'cold_batch' AND created_at >= ?1 THEN 1 ELSE 0 END) AS cold,
                SUM(CASE WHEN kind = 'sequence' AND created_at >= ?2 THEN 1 ELSE 0 END) AS sequence
           FROM approval_manifests WHERE released_at IS NULL AND created_at >= ?1`,
      )
      .bind(new Date(now.getTime() - RELEASE_MAX_AGE_DAYS * DAY_MS).toISOString(), new Date(now.getTime() - SEQUENCE_LIMITS.releaseMaxAgeHours * HOUR_MS).toISOString()),
    db.prepare(`SELECT COUNT(*) AS owed FROM inbound_emails i WHERE ${OWED_SQL} AND i.received_at >= ?1`).bind(owedSince),
    db.prepare("SELECT COUNT(*) AS touches FROM manual_touches WHERE status = 'pending' AND expires_at > ?1").bind(at),
  ]);
  const manifestRow = manifests?.results[0];
  return {
    pendingDrafts: (drafts?.results ?? []).map((r) => ({ kind: String(r.kind), drafts: n(r.drafts) })),
    manifests: { coldBatches: n(manifestRow?.cold), sequences: n(manifestRow?.sequence) },
    owedReplies: n(owed?.results[0]?.owed),
    manualTouches: n(touches?.results[0]?.touches),
  };
}
