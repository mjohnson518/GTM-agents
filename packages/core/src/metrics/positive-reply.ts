// GTM-agents: the one definition of a reply and of a positive reply.
//
// Every report, experiment, promotion check and ledger write that asks "did they reply?" or "was
// it positive?" calls these functions. Nothing else may define either (CLAUDE.md, non-negotiable 6).
//
//   - A reply is a message a person wrote back. Opt-outs, unsubscribes, automatic replies (out of
//     office included), spam and noise never count as replies, whatever their structural
//     classification. A message triage has not read yet counts as a reply when its structural
//     classification says a person wrote it (reply or new_inquiry); it cannot be positive until
//     triage reads it.
//   - A positive reply is a reply whose triage intent is interested, question or referral, OR a
//     meeting that is not cancelled, is attributed to the outreach, and was first seen after the
//     send. "Not a fit" is a reply but never positive.
//
// The meeting half is an input. What counts as a booked, attributed meeting is defined once in
// meetings.ts (meetingEvidence turns a calendar_meetings row into a MeetingEvidence); calendar sync
// credits it to the send ledger (packages/core/src/convert/ledger.ts). A caller that passes no
// meeting gets the intent half only.
//
// Every function here is pure. An intent or classification this module does not know never counts.

/** The intents reply triage can return, in the order the triage prompt lists them. */
export const REPLY_INTENTS = ["interested", "objection", "question", "warm", "referral", "not_a_fit", "opt_out", "auto_reply", "spam", "noise", "unclear"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Intents that make a reply positive. */
export const POSITIVE_INTENTS: readonly ReplyIntent[] = Object.freeze(["interested", "question", "referral"]);

/** Intents that are never a reply at all. */
export const NON_REPLY_INTENTS: readonly ReplyIntent[] = Object.freeze(["opt_out", "auto_reply", "spam", "noise"]);

/** Structural classifications (set when a message is recorded) that are never a reply. */
export const NON_REPLY_CLASSIFICATIONS: readonly string[] = Object.freeze(["auto_reply", "out_of_office", "spam", "bounce", "unsubscribe"]);

/** Structural classifications that say a person wrote the message. */
export const HUMAN_CLASSIFICATIONS: readonly string[] = Object.freeze(["reply", "new_inquiry"]);

export function isReplyIntent(value: unknown): value is ReplyIntent {
  return typeof value === "string" && (REPLY_INTENTS as readonly string[]).includes(value);
}

/** True for interested, question and referral. */
export function isPositiveIntent(intent: unknown): boolean {
  return isReplyIntent(intent) && POSITIVE_INTENTS.includes(intent);
}

export interface ReplySignal {
  /** The triage intent, or null when triage has not read the message. */
  intent?: string | null;
  /** The structural classification recorded with the message, when known. */
  classification?: string | null;
}

/**
 * True when the message counts as a reply. Opt-outs, unsubscribes, automatic replies, spam and
 * noise never do; an untriaged message does when its classification says a person wrote it.
 */
export function countsAsReply(signal: ReplySignal): boolean {
  const classification = signal.classification ?? null;
  if (classification !== null && NON_REPLY_CLASSIFICATIONS.includes(classification)) return false;
  const intent = signal.intent ?? null;
  if (intent === null) return classification !== null && HUMAN_CLASSIFICATIONS.includes(classification);
  if (!isReplyIntent(intent)) return false;
  return !NON_REPLY_INTENTS.includes(intent);
}

/** A booked meeting, as calendar sync and attribution report it (meetings.ts, meetingEvidence). */
export interface MeetingEvidence {
  /** confirmed, tentative or cancelled. */
  status: string;
  /** True when attribution ties the meeting to the outreach. */
  attributed: boolean;
  /** When the meeting was first seen, ISO 8601. */
  firstSeenAt: string;
}

/** True for a meeting that is not cancelled, is attributed, and was first seen after `sentAt`. */
export function meetingCountsAsPositive(meeting: MeetingEvidence | null | undefined, sentAt: string | null | undefined): boolean {
  if (!meeting || !sentAt || meeting.status === "cancelled" || meeting.attributed !== true) return false;
  const seen = Date.parse(meeting.firstSeenAt);
  const sent = Date.parse(sentAt);
  return Number.isFinite(seen) && Number.isFinite(sent) && seen > sent;
}

export interface PositiveReplyInput extends ReplySignal {
  /** A meeting for the same contact, when one is known. */
  meeting?: MeetingEvidence | null;
  /** When the outreach being credited was sent, ISO 8601. Needed for the meeting half. */
  sentAt?: string | null;
}

/** True when the reply is positive: a positive triage intent, or a qualifying meeting. */
export function isPositiveReply(input: PositiveReplyInput): boolean {
  if (countsAsReply(input) && isPositiveIntent(input.intent)) return true;
  return meetingCountsAsPositive(input.meeting, input.sentAt);
}

/**
 * When the reply became positive: the reply's own timestamp when its intent is positive, the
 * meeting's first sighting when only the meeting qualifies, the earlier of the two when both do,
 * and null when neither does. Never the current time.
 */
export function positiveReplyAt(input: PositiveReplyInput & { receivedAt?: string | null }): string | null {
  const times: number[] = [];
  if (input.receivedAt && countsAsReply(input) && isPositiveIntent(input.intent)) {
    const at = Date.parse(input.receivedAt);
    if (Number.isFinite(at)) times.push(at);
  }
  if (input.meeting && meetingCountsAsPositive(input.meeting, input.sentAt)) times.push(Date.parse(input.meeting.firstSeenAt));
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString();
}
