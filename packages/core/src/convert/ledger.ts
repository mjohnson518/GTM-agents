// GTM-agents: crediting a booked meeting to the send that earned it, on the per-send ledger.
//
// The positive-reply definition (metrics/positive-reply.ts) counts a meeting that is booked
// (metrics/meetings.ts) and was first seen after the send. Attribution is first-touch, as for
// replies (metrics/attribution.ts): the meeting is credited to the contact's latest first touch sent
// in the 60 days before the meeting was first seen, and positive_reply_at on that row becomes the
// meeting's first sighting when that is earlier than what it holds.
//
// A meeting that stops counting (cancelled, or unlinked by the operator) has its credit withdrawn,
// but only where it is the credit: when positive_reply_at is exactly that meeting's first sighting,
// it is recomputed from what else is credited to the same send (positive replies, other booked
// meetings), or cleared. A positive reply that came first is never touched. Both are bookkeeping:
// callers catch and log their errors.
import { meetingBookedSql, meetingEvidence, type MeetingRow } from "../metrics/meetings.ts";
import { meetingCountsAsPositive } from "../metrics/positive-reply.ts";
import { ATTRIBUTION_WINDOW_DAYS } from "../metrics/attribution.ts";
import { firstTouchSql, inboundPositiveSql } from "../metrics/sql.ts";

const DAY_MS = 86_400_000;

export interface CreditedSend {
  id: string;
  sent_at: string;
  positive_reply_at: string | null;
  template_id: string | null;
}

/** The first touch a meeting first seen at `at` is credited to, or null. Throws on a database error. */
export async function creditedSend(db: D1Database, contactId: string, at: string): Promise<CreditedSend | null> {
  const seen = Date.parse(at);
  if (!Number.isFinite(seen)) return null;
  return db
    .prepare(
      `SELECT os.id, os.sent_at, os.positive_reply_at, os.template_id FROM outreach_sends os
        WHERE os.contact_id = ?1 AND ${firstTouchSql("os")} AND os.sent_at <= ?2 AND os.sent_at >= ?3
        ORDER BY os.sent_at DESC LIMIT 1`,
    )
    .bind(contactId, new Date(seen).toISOString(), new Date(seen - ATTRIBUTION_WINDOW_DAYS * DAY_MS).toISOString())
    .first<CreditedSend>();
}

/** Credit a booked meeting. Returns the credited send's id, or null. Throws on a database error. */
export async function creditMeeting(db: D1Database, contactId: string, meeting: MeetingRow): Promise<string | null> {
  const send = await creditedSend(db, contactId, meeting.first_seen_at);
  if (!send || !meetingCountsAsPositive(meetingEvidence(meeting), send.sent_at)) return null;
  const at = new Date(Date.parse(meeting.first_seen_at)).toISOString();
  await db
    .prepare("UPDATE outreach_sends SET positive_reply_at = CASE WHEN positive_reply_at IS NULL OR positive_reply_at > ?2 THEN ?2 ELSE positive_reply_at END WHERE id = ?1")
    .bind(send.id, at)
    .run();
  return send.id;
}

/**
 * Withdraw a meeting's credit after it stopped counting. Run it after the meeting row was cancelled
 * or deleted. Returns true when the ledger changed. Throws on a database error.
 */
export async function withdrawMeetingCredit(db: D1Database, contactId: string, meeting: { event_id: string; first_seen_at: string }): Promise<boolean> {
  const send = await creditedSend(db, contactId, meeting.first_seen_at);
  const at = new Date(Date.parse(meeting.first_seen_at)).toISOString();
  if (!send || send.positive_reply_at !== at) return false;
  const until = new Date(Date.parse(send.sent_at) + ATTRIBUTION_WINDOW_DAYS * DAY_MS).toISOString();
  // What else this send is credited with: the same first-touch rule, applied to each candidate time.
  const noNewerFirstTouch = (time: string) =>
    `NOT EXISTS (SELECT 1 FROM outreach_sends nx WHERE nx.contact_id = ?1 AND ${firstTouchSql("nx")} AND nx.sent_at > ?2 AND nx.sent_at <= ${time})`;
  const row = await db
    .prepare(
      `SELECT MIN(t) AS next FROM (
         SELECT i.received_at AS t FROM inbound_emails i
          WHERE i.contact_id = ?1 AND ${inboundPositiveSql("i")} AND i.received_at >= ?2 AND i.received_at <= ?3 AND ${noNewerFirstTouch("i.received_at")}
         UNION ALL
         SELECT m.first_seen_at AS t FROM calendar_meetings m
          WHERE m.contact_id = ?1 AND m.event_id <> ?4 AND ${meetingBookedSql("m")} AND m.first_seen_at > ?2 AND m.first_seen_at <= ?3 AND ${noNewerFirstTouch("m.first_seen_at")})`,
    )
    .bind(contactId, send.sent_at, until, meeting.event_id)
    .first<{ next: string | null }>();
  const result = await db
    .prepare("UPDATE outreach_sends SET positive_reply_at = ?3 WHERE id = ?1 AND positive_reply_at = ?2")
    .bind(send.id, at, row?.next ?? null)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
