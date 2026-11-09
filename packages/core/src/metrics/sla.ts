// GTM-agents: the reply SLA: replies waiting on a person, and how fast they get answered.
//
// "Owed" has one definition, the reply clock's (replies/owed.ts, OWED_SQL): inbound mail still new,
// notified or with a draft waiting, that triage read as needing a person, or that comes from a known
// contact and is not triaged yet. It is chased for the reply clock's window: 14 days by default, or
// the owedWindowDays a deployment passes to createReplyJobs. Every metric that counts owed replies
// (replySla here, and the operator queue's owed count) takes that override as an argument and
// resolves it through owedWindowDays; a caller that passes none counts over the default window.
//   - replySla: owed replies received more than REPLY_SLA_HOURS ago, and the oldest one's age;
//   - replyResponseTimes: replies received in a window that triage read as needing a person and
//     that were answered (their reply draft was sent), with the median hours from the reply arriving
//     to the answer going out.
import { DEFAULT_REPLY_JOB_OPTIONS } from "../replies/jobs.ts";
import { OWED_INTENTS, OWED_SQL } from "../replies/owed.ts";
import { n, sqlList } from "./sql.ts";
import { DAY_MS, HOUR_MS, type MetricWindow } from "./window.ts";

/** A reply owed for longer than this has missed the SLA. The reply clock's last escalation is the same. */
export const REPLY_SLA_HOURS = 4;
/** Owed replies older than this are no longer chased, as the reply clock does by default. */
export const REPLY_SLA_WINDOW_DAYS = DEFAULT_REPLY_JOB_OPTIONS.owedWindowDays;

/**
 * The reply clock's window, in days: a deployment's override (the owedWindowDays it gives
 * createReplyJobs) or, without one, the default. Throws on anything but a whole number of days of at
 * least 1, so a bad value shows as a section that could not be read, never as a different window.
 */
export function owedWindowDays(override?: number): number {
  if (override === undefined) return REPLY_SLA_WINDOW_DAYS;
  if (!Number.isInteger(override) || override < 1) throw new Error("the reply window must be a whole number of days, at least 1");
  return override;
}
/** At most this many answered replies are read for the median. */
const RESPONSE_ROWS_MAX = 2_000;

export interface ReplySla {
  /** Owed replies past the SLA. */
  waiting: number;
  /** Hours the oldest of them has waited, or null when none is waiting. */
  oldestHours: number | null;
}

/**
 * Owed replies waiting more than REPLY_SLA_HOURS at `now`, inside the reply window (the deployment's
 * owedWindowDays, or the default). Throws on a database error or a bad window.
 */
export async function replySla(db: D1Database, now: Date, windowDays?: number): Promise<ReplySla> {
  const since = new Date(now.getTime() - owedWindowDays(windowDays) * DAY_MS).toISOString();
  const before = new Date(now.getTime() - REPLY_SLA_HOURS * HOUR_MS).toISOString();
  const row = await db
    .prepare(`SELECT COUNT(*) AS waiting, MIN(i.received_at) AS oldest FROM inbound_emails i WHERE ${OWED_SQL} AND i.received_at >= ?1 AND i.received_at <= ?2`)
    .bind(since, before)
    .first<{ waiting: number | null; oldest: string | null }>();
  const waiting = n(row?.waiting);
  const oldest = row?.oldest ? Date.parse(row.oldest) : Number.NaN;
  return { waiting, oldestHours: waiting > 0 && Number.isFinite(oldest) ? Math.floor((now.getTime() - oldest) / HOUR_MS) : null };
}

export interface ResponseTimes {
  /** Replies needing a person, received in the window, that were answered. */
  answered: number;
  /** Median hours to answer, to one decimal, or null when none was answered. */
  medianHours: number | null;
}

/** The median of a list, or null when it is empty. Pure. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** How fast replies that needed a person were answered. Throws on a database error. */
export async function replyResponseTimes(db: D1Database, window: MetricWindow): Promise<ResponseTimes> {
  const { results } = await db
    .prepare(
      `SELECT i.received_at, d.sent_at FROM inbound_emails i JOIN drafts d ON d.id = i.draft_id
        WHERE d.kind = 'reply' AND d.status = 'sent' AND d.sent_at IS NOT NULL
          AND i.intent IN (${sqlList(OWED_INTENTS)}) AND i.received_at >= ?1 AND i.received_at < ?2
        ORDER BY i.received_at DESC LIMIT ${RESPONSE_ROWS_MAX}`,
    )
    .bind(window.from, window.to)
    .all<{ received_at: string; sent_at: string }>();
  const hours = results.map((r) => (Date.parse(r.sent_at) - Date.parse(r.received_at)) / HOUR_MS).filter((h) => Number.isFinite(h) && h >= 0);
  const mid = median(hours);
  return { answered: hours.length, medianHours: mid === null ? null : Math.round(mid * 10) / 10 };
}
