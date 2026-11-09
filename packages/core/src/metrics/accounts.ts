// GTM-agents: accounts that responded: the seed set for lookalike sourcing and the "recent reply or
// sign-up" test for coverage fill, built from the one definition of each outcome.
//
// An account responded when, in the window, one of its contacts:
//   - gave a positive reply to outreach (positiveReplySql on the send ledger);
//   - booked a meeting (meetingBookedSql on calendar meetings);
//   - signed up or subscribed (productOutcomeSql on funnel events).
// Nothing here redefines those outcomes; it only groups them by account.
import { meetingBookedSql } from "./meetings.ts";
import { productOutcomeSql } from "./product.ts";
import { positiveReplySql } from "./sql.ts";

/** Account keys that responded since `since`, at most `limit`, most recent first. Throws on a read error. */
export async function respondedAccounts(db: D1Database, since: Date, limit: number): Promise<string[]> {
  const from = since.toISOString();
  const { results } = await db
    .prepare(
      `SELECT account_key, MAX(at) AS at FROM (
         SELECT c.account_key AS account_key, s.positive_reply_at AS at FROM outreach_sends s JOIN contacts c ON c.id = s.contact_id
          WHERE ${positiveReplySql("s")} AND s.positive_reply_at >= ?1
         UNION ALL
         SELECT c.account_key, m.first_seen_at FROM calendar_meetings m JOIN contacts c ON c.id = m.contact_id
          WHERE ${meetingBookedSql("m")} AND m.first_seen_at >= ?1
         UNION ALL
         SELECT c.account_key, f.occurred_at FROM funnel_events f JOIN contacts c ON c.id = f.contact_id
          WHERE (${productOutcomeSql("f", "signed_up")} OR ${productOutcomeSql("f", "subscribed")}) AND f.occurred_at >= ?1
       ) WHERE account_key IS NOT NULL GROUP BY account_key ORDER BY at DESC, account_key LIMIT ?2`,
    )
    .bind(from, limit)
    .all<{ account_key: string }>();
  return results.map((r) => r.account_key);
}
