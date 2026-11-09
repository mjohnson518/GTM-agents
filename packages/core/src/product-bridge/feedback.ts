// GTM-agents: in-product feedback, filed for the ship loop (feedback_items, source "product").
//
// Feedback text is full taint. It is stored as written (length-capped) and never pasted into a
// prompt, a log line, an audit row or an operator message: whatever reads it later fences it as
// untrusted data. A push carries no feedback id, so the same feedback arriving by push and by the
// nightly pull is recognized by its author's address hash and its text: external_id is the hash of
// both, and feedback_items is unique on (source, external_id).
import { MAX_FEEDBACK_CHARS } from "./envelope.ts";
import { sha256Hex } from "../shared/hash.ts";

export const FEEDBACK_SOURCE = "product";

export interface FeedbackInput {
  text: string;
  /** The author's exact address hash, so the push and the pull agree on the key. */
  authorSha256: string;
  productUserId: string | null;
  contactId: string | null;
  createdAt: string;
}

/** File one item. Returns false for a duplicate or an empty text. Throws on a database error. */
export async function fileFeedback(db: D1Database, input: FeedbackInput): Promise<boolean> {
  const text = input.text.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (text.length === 0) return false;
  const externalId = `fb_${(await sha256Hex(`${input.authorSha256}\n${text}`)).slice(0, 40)}`;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO feedback_items (id, source, external_id, product_user_id, contact_id, text, status, created_at)
       VALUES (?1, ?2, ?3, ?4, (SELECT id FROM contacts WHERE id = ?5), ?6, 'new', ?7)`,
    )
    .bind(crypto.randomUUID(), FEEDBACK_SOURCE, externalId, input.productUserId, input.contactId, text, input.createdAt)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
