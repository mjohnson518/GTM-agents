// GTM-agents: the rows reply handling reads and writes: inbound mail, what triage stored about it,
// and the contact it came from.
//
// Triage stores its structured result as JSON in inbound_emails.triage (migration 0018) and the
// intent in inbound_emails.intent. Every quote in it is the sender's own words, checked verbatim
// against the body: untrusted text. It is read back only as data.
import { isReplyIntent, type ReplyIntent } from "../metrics/positive-reply.ts";

export interface InboundRow {
  id: string;
  provider: string;
  provider_message_id: string;
  provider_thread_id: string | null;
  sender_email: string;
  subject: string | null;
  body_preview: string | null;
  body_key: string | null;
  received_at: string;
  classification: string | null;
  intent: string | null;
  triage: string | null;
  contact_id: string | null;
  deal_id: string | null;
  draft_id: string | null;
  provider_draft_id: string | null;
  status: string;
  /** The message's own RFC 5322 Message-ID, recorded by inbox intake, for threading the reply under it. */
  message_id: string | null;
}

/** The inbound_emails columns InboundRow holds, for SELECTs (prefix with an alias as needed). */
export const INBOUND_COLUMNS = [
  "id",
  "provider",
  "provider_message_id",
  "provider_thread_id",
  "sender_email",
  "subject",
  "body_preview",
  "body_key",
  "received_at",
  "classification",
  "intent",
  "triage",
  "contact_id",
  "deal_id",
  "draft_id",
  "provider_draft_id",
  "status",
  "message_id",
] as const;

export const inboundColumns = (alias = ""): string => INBOUND_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(", ");

/** What triage found, as stored. Every text field is verbatim sender text or null. */
export interface StoredTriage {
  intent: ReplyIntent;
  confidence: number;
  quote: string | null;
  problem_quote: string | null;
  timing_quote: string | null;
  proposed_time: string | null;
  meeting_requested: boolean;
  asset_requested: boolean;
  model: string | null;
  at: string;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Parse inbound_emails.triage, or null when it is missing or malformed. */
export function parseStoredTriage(raw: string | null | undefined): StoredTriage | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : NaN;
  if (!isReplyIntent(v.intent) || !(confidence >= 0 && confidence <= 1)) return null;
  return {
    intent: v.intent,
    confidence,
    quote: text(v.quote),
    problem_quote: text(v.problem_quote),
    timing_quote: text(v.timing_quote),
    proposed_time: text(v.proposed_time),
    meeting_requested: v.meeting_requested === true,
    asset_requested: v.asset_requested === true,
    model: text(v.model),
    at: typeof v.at === "string" ? v.at : "",
  };
}

export interface ContactRow {
  id: string;
  email: string;
  first_name: string | null;
  job_title: string | null;
  account_key: string | null;
  account_name: string | null;
  warmth: string;
}

/** The contact behind an inbound row, with its account's name. Throws on a database error. */
export async function loadContact(db: D1Database, contactId: string | null): Promise<ContactRow | null> {
  if (!contactId) return null;
  return db
    .prepare(
      `SELECT c.id, c.email, c.first_name, c.job_title, c.account_key, a.name AS account_name, c.warmth
         FROM contacts c LEFT JOIN accounts a ON a.account_key = c.account_key WHERE c.id = ?1`,
    )
    .bind(contactId)
    .first<ContactRow>();
}

/** The event id every routing effect of one inbound message is claimed under. */
export const replyEventId = (inboundId: string): string => `reply:${inboundId}`;

/** Milliseconds since an ISO timestamp; NaN when it does not parse. */
export function ageMs(iso: string | null | undefined, now: Date): number {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? now.getTime() - at : Number.NaN;
}

export const DAY_MS = 86_400_000;
export const daysAgo = (now: Date, days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
