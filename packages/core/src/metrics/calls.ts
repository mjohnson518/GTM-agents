// GTM-agents: what recorded calls produced, counted once (docs/MEETING-NOTES.md). Competitor names
// come from the brain's approved competitors component, so a count is by the brain's own names.
import type { MetricWindow } from "./window.ts";

/** Competitors named on calls recorded in the window, most named first, at most 8. */
export async function competitorMentions(db: D1Database, window: MetricWindow): Promise<Array<{ name: string; count: number }>> {
  const { results } = await db
    .prepare(
      `SELECT c.value AS name, COUNT(*) AS count FROM meetings m, json_each(m.competitors_mentioned) c
        WHERE m.processed_at IS NOT NULL AND m.competitors_mentioned IS NOT NULL AND m.occurred_at >= ?1 AND m.occurred_at < ?2
        GROUP BY c.value ORDER BY count DESC, name LIMIT 8`,
    )
    .bind(window.from, window.to)
    .all<{ name: string; count: number }>();
  return results.map((r) => ({ name: String(r.name), count: Number(r.count) }));
}
