// GTM-agents: crediting a reply to the send that earned it, on the per-send ledger (outreach_sends).
//
// First-touch attribution: a reply is credited to the contact's latest first touch (sequence step
// 1, cold or sequence path) sent in the 60 days before the reply. On that row:
//   - replied_at is the reply's own received_at, never the time this code runs. Out-of-order
//     replies keep the earliest timestamp;
//   - reply_intent is the intent of the reply that set replied_at;
//   - reply_after_step is the highest step actually sent to the contact between the first touch and
//     the reply, so it can never name a step that did not go out;
//   - positive_reply_at is the reply's received_at when the reply is positive (metrics/), again
//     keeping the earliest.
// Only messages that count as replies (metrics/) are credited: opt-outs, automatic replies, spam
// and noise never are. Crediting is bookkeeping: callers catch and log its errors.
import { ATTRIBUTION_WINDOW_DAYS } from "../metrics/attribution.ts";
import { countsAsReply, isPositiveReply } from "../metrics/positive-reply.ts";

export { ATTRIBUTION_WINDOW_DAYS };

export interface LedgerCredit {
  /** The credited send, or null when nothing was credited. */
  sendId: string | null;
  replyAfterStep: number | null;
  positive: boolean;
}

/** Credit one reply. Throws on a database error. */
export async function creditReply(
  db: D1Database,
  reply: { contactId: string; intent: string; classification: string | null; receivedAt: string },
): Promise<LedgerCredit> {
  const none: LedgerCredit = { sendId: null, replyAfterStep: null, positive: false };
  if (!countsAsReply({ intent: reply.intent, classification: reply.classification })) return none;
  const received = Date.parse(reply.receivedAt);
  if (!Number.isFinite(received)) return none;
  const receivedAt = new Date(received).toISOString();
  const windowStart = new Date(received - ATTRIBUTION_WINDOW_DAYS * 86_400_000).toISOString();
  const first = await db
    .prepare(
      `SELECT id, sent_at FROM outreach_sends
        WHERE contact_id = ?1 AND sequence_step = 1 AND send_path IN ('cold', 'sequence')
          AND sent_at <= ?2 AND sent_at >= ?3
        ORDER BY sent_at DESC LIMIT 1`,
    )
    .bind(reply.contactId, receivedAt, windowStart)
    .first<{ id: string; sent_at: string }>();
  if (!first) return none;
  const deepest = await db
    .prepare(
      `SELECT MAX(sequence_step) AS step FROM outreach_sends
        WHERE contact_id = ?1 AND send_path IN ('cold', 'sequence') AND sequence_step IS NOT NULL AND sent_at >= ?2 AND sent_at <= ?3`,
    )
    .bind(reply.contactId, first.sent_at, receivedAt)
    .first<{ step: number | null }>();
  const step = Number.isInteger(deepest?.step) && (deepest?.step ?? 0) >= 1 ? (deepest?.step as number) : 1;
  const positive = isPositiveReply({ intent: reply.intent, classification: reply.classification });
  await db
    .prepare(
      `UPDATE outreach_sends SET
         reply_intent = CASE WHEN replied_at IS NULL OR replied_at > ?2 THEN ?3 ELSE reply_intent END,
         reply_after_step = CASE WHEN replied_at IS NULL OR replied_at > ?2 THEN ?4 ELSE reply_after_step END,
         replied_at = CASE WHEN replied_at IS NULL OR replied_at > ?2 THEN ?2 ELSE replied_at END,
         positive_reply_at = CASE WHEN ?5 = 1 AND (positive_reply_at IS NULL OR positive_reply_at > ?2) THEN ?2 ELSE positive_reply_at END
       WHERE id = ?1`,
    )
    .bind(first.id, receivedAt, reply.intent, step, positive ? 1 : 0)
    .run();
  return { sendId: first.id, replyAfterStep: step, positive };
}
