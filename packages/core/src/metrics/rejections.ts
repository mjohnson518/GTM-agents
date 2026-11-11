// GTM-agents: the filter funnel: candidates that stopped short of promotion, by reason and source.
//
// One definition: a rejection is a candidate whose status is rejected, borderline or duplicate and
// whose last change (updated_at) falls in the window. Terminal rows are never updated again, so the
// last change is when the decision was made. The reason is `attributes.reject_reason`
// (sourcing/reasons.ts); a row without a code from the enum (written before codes existed, or by
// hand) counts as UNRECORDED_REASON rather than being dropped, so the totals always match the table.
//
// Two views of the same rows: per reason, and per reason within each source (the candidate's
// `source`) and discovery query (`query_id`, with the query's text when the query row still exists).
import { isRejectReason, type RejectReason } from "../sourcing/reasons.ts";
import { n, sqlList } from "./sql.ts";
import type { MetricWindow } from "./window.ts";

/** The reason a row without a known code is counted under. */
export const UNRECORDED_REASON = "unrecorded";

export type RejectionReason = RejectReason | typeof UNRECORDED_REASON;

/** The terminal statuses other than promoted. */
export const REJECTION_STATUSES = ["rejected", "borderline", "duplicate"] as const;

export interface ReasonCount {
  reason: RejectionReason;
  count: number;
}

export interface SourceReasonCount {
  source: string;
  queryId: string | null;
  /** The discovery query's text, or null when the candidate has no query or the query is gone. */
  query: string | null;
  reason: RejectionReason;
  count: number;
}

export interface RejectionCounts {
  total: number;
  /** Largest first; ties by reason code. */
  byReason: ReasonCount[];
  /** Largest first; ties by source, query and reason. */
  bySource: SourceReasonCount[];
}

/** Rejections in `window`, by reason and by source and query. Throws on a read error. */
export async function rejectionsByReason(db: D1Database, window: MetricWindow): Promise<RejectionCounts> {
  const { results } = await db
    .prepare(
      `SELECT c.source AS source, c.query_id AS query_id, q.query AS query,
              CASE WHEN json_valid(c.attributes) THEN json_extract(c.attributes, '$.reject_reason') END AS reason,
              COUNT(*) AS count
         FROM candidates c LEFT JOIN discovery_queries q ON q.id = c.query_id
        WHERE c.status IN (${sqlList(REJECTION_STATUSES)}) AND c.updated_at >= ?1 AND c.updated_at < ?2
        GROUP BY c.source, c.query_id, q.query, reason`,
    )
    .bind(window.from, window.to)
    .all<{ source: string; query_id: string | null; query: string | null; reason: unknown; count: number | null }>();

  const bySourceKey = new Map<string, SourceReasonCount>();
  const reasons = new Map<RejectionReason, number>();
  let total = 0;
  for (const row of results) {
    const reason: RejectionReason = isRejectReason(row.reason) ? row.reason : UNRECORDED_REASON;
    const count = n(row.count);
    total += count;
    reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    // Unknown codes fold into one bucket, so two raw values can land on the same key.
    const key = JSON.stringify([row.source, row.query_id, reason]);
    const existing = bySourceKey.get(key);
    if (existing) existing.count += count;
    else bySourceKey.set(key, { source: row.source, queryId: row.query_id, query: row.query, reason, count });
  }
  const byReason = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const bySource = [...bySourceKey.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.source.localeCompare(b.source) ||
      (a.queryId ?? "").localeCompare(b.queryId ?? "") ||
      a.reason.localeCompare(b.reason),
  );
  return { total, byReason, bySource };
}
