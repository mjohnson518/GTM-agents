// GTM-agents: the outcome of one sent reply for scoring the objection answer it used: the contact's
// next message that counts as a reply (countsAsReply) within the window, judged positive by the one
// definition (isPositiveReply, meetings included). Objection curation reads this and defines nothing
// of its own.
import { meetingEvidence, type MeetingRow } from "./meetings.ts";
import { countsAsReply, isPositiveReply, type MeetingEvidence } from "./positive-reply.ts";

export type AnswerOutcome = { state: "positive" } | { state: "not_positive" } | { state: "waiting" };

/**
 * Whether the reply sent at `sentAt` to the contact earned a positive reply by `deadline`. A message
 * that does not count as a reply is skipped; an untriaged human message waits `graceMs` for triage.
 * Throws on a database error.
 */
export async function answerOutcome(db: D1Database, args: { contactId: string; sentAt: string; deadline: string; now: Date; graceMs: number }): Promise<AnswerOutcome> {
  const until = args.deadline < args.now.toISOString() ? args.deadline : args.now.toISOString();
  const meeting = await db
    .prepare("SELECT status, attribution, first_seen_at, before_baseline FROM calendar_meetings WHERE contact_id = ?1 AND first_seen_at > ?2 AND first_seen_at <= ?3 ORDER BY first_seen_at ASC LIMIT 1")
    .bind(args.contactId, args.sentAt, until)
    .first<MeetingRow>();
  const evidence: MeetingEvidence | null = meeting ? meetingEvidence(meeting) : null;
  const { results } = await db
    .prepare("SELECT intent, classification, received_at FROM inbound_emails WHERE contact_id = ?1 AND received_at > ?2 AND received_at <= ?3 ORDER BY received_at ASC LIMIT 20")
    .bind(args.contactId, args.sentAt, until)
    .all<{ intent: string | null; classification: string | null; received_at: string }>();
  const next = results.find((r) => countsAsReply(r));
  if (next) {
    if (next.intent === null && Date.parse(next.received_at) + args.graceMs > args.now.getTime()) return { state: "waiting" };
    return isPositiveReply({ intent: next.intent, classification: next.classification, meeting: evidence, sentAt: args.sentAt }) ? { state: "positive" } : { state: "not_positive" };
  }
  if (isPositiveReply({ intent: null, classification: null, meeting: evidence, sentAt: args.sentAt })) return { state: "positive" };
  return args.deadline <= args.now.toISOString() ? { state: "not_positive" } : { state: "waiting" };
}
