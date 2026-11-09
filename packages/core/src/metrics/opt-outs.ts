// GTM-agents: the one definition of the outreach unsubscribe rate.
//
// The counts (optOutCounts) cover outreach, the cold and sequence paths, in a window:
//   - sends: outreach sent in the window (the same count as deliveryCounts);
//   - optOuts: people who opted out in the window after outreach reached them: suppression entries
//     with reason opt_out written in the window (the unsubscribe link, a provider's unsubscribe
//     event, an unsubscribe reply, a triaged opt-out), for a contact with an outreach send at or
//     before that time. Each person counts once.
// Opt-outs count by when they arrived, like bounces in delivery-rates.ts, so a gate reacts to them
// as they come in. Complaints are not opt-outs here: complaintRate counts them.
//
// unsubscribeRate is opt-outs over sends, or null with no sends: no data is not a 0% rate.
import { n, outreachSql } from "./sql.ts";
import type { MetricWindow } from "./window.ts";

export interface OptOutCounts {
  /** Outreach sent in the window. */
  sends: number;
  /** People who opted out in the window after outreach reached them. */
  optOuts: number;
}

/** Outreach sends and opt-outs in the window. Throws on a database error. */
export async function optOutCounts(db: D1Database, window: MetricWindow): Promise<OptOutCounts> {
  const [sends, optOuts] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM outreach_sends os WHERE ${outreachSql("os")} AND os.sent_at >= ?1 AND os.sent_at < ?2`)
      .bind(window.from, window.to)
      .first<{ n: number | null }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT c.id) AS n
           FROM suppression s
           JOIN contacts c ON c.email_sha256 = s.email_sha256
          WHERE s.reason = 'opt_out' AND s.created_at >= ?1 AND s.created_at < ?2
            AND EXISTS (SELECT 1 FROM outreach_sends os WHERE os.contact_id = c.id AND ${outreachSql("os")} AND os.sent_at <= s.created_at)`,
      )
      .bind(window.from, window.to)
      .first<{ n: number | null }>(),
  ]);
  return { sends: n(sends?.n), optOuts: n(optOuts?.n) };
}

/** Opt-outs over sends, or null with no sends. Pure. */
export function unsubscribeRate(c: OptOutCounts): number | null {
  return c.sends > 0 ? c.optOuts / c.sends : null;
}
