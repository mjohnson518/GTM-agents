// GTM-agents: erasure. One call removes a person's personal data and leaves a tombstone.
//
// A person is a mailbox: erasing jane@acme.example also erases jane+news@acme.example, and the
// reverse. eraseContact finds every contact stored under the mailbox, then runs one D1 batch, so it
// is all or nothing:
//   1. writes the tombstone (exact and mailbox hashes) that keeps the person from being re-added
//      or emailed;
//   2. deletes rows that hold one of their addresses without a contact link, matching case,
//      surrounding spaces and the "Name <address>" form: candidates and their evidence, drafts and
//      deferred sends, inbound mail they sent, referrals naming them, cached verification results;
//   3. deletes the contact rows. Foreign keys then delete per-contact state (tags, scores, drafts,
//      inbound mail, meetings, feedback and so on) and clear contact_id on the measurement ledgers.
// eraseByHash does the same when only the address hash is known (the product's user.deleted
// event). Memory text is not linked to a contact; the memory module removes it separately.
import { addressHash } from "../sending/suppression.ts";
import { contactEmailFields } from "./contacts.ts";

export type ErasureSource = "product" | "operator" | "reply" | "reconciliation";

export interface ErasureResult {
  emailSha256: string;
  contactsDeleted: number;
}

interface ErasureOptions {
  source: ErasureSource;
  now?: Date;
  productUserId?: string;
}

// Matches a free-text address column against the JSON list of addresses in ?1.
const addressIn = (column: string) =>
  `(lower(trim(${column})) IN (SELECT value FROM json_each(?1)) OR EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(${column}), '<' || value || '>') > 0))`;

/** Erase everything held about the mailbox of `email`. Throws on invalid input or a database error. */
export async function eraseContact(db: D1Database, email: string, options: ErasureOptions): Promise<ErasureResult> {
  const fields = await contactEmailFields(email);
  if (!fields) throw new TypeError("the address to erase cannot be parsed");
  const now = (options.now ?? new Date()).toISOString();
  const { results: contacts } = await db
    .prepare("SELECT id, email FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 OR email_sha256 = ?2")
    .bind(fields.email_sha256, fields.mailbox_sha256)
    .all<{ id: string; email: string }>();
  const addresses = JSON.stringify([...new Set([fields.email, ...contacts.map((c) => c.email)])]);
  const ids = JSON.stringify(contacts.map((c) => c.id));
  const candidates = `SELECT id FROM candidates WHERE ${addressIn("email")} OR promoted_contact_id IN (SELECT value FROM json_each(?2))`;
  const tombstone = db
    .prepare(
      `INSERT INTO erasure_tombstones (email_sha256, mailbox_sha256, product_user_id, source, erased_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(email_sha256) DO UPDATE SET mailbox_sha256 = COALESCE(erasure_tombstones.mailbox_sha256, excluded.mailbox_sha256)`,
    );
  const hashes = await Promise.all(contacts.map(async (c) => [await addressHash(c.email), c.email] as const));
  await db.batch([
    tombstone.bind(fields.email_sha256, fields.mailbox_sha256, options.productUserId ?? null, options.source, now),
    ...hashes.map(([hash]) => tombstone.bind(hash, fields.mailbox_sha256, options.productUserId ?? null, options.source, now)),
    db.prepare(`DELETE FROM contact_evidence WHERE candidate_id IN (${candidates})`).bind(addresses, ids),
    db.prepare(`DELETE FROM candidates WHERE id IN (${candidates})`).bind(addresses, ids),
    db.prepare(`DELETE FROM drafts WHERE ${addressIn("recipient_email")}`).bind(addresses),
    db.prepare(`DELETE FROM deferred_sends WHERE ${addressIn("recipient_email")}`).bind(addresses),
    db.prepare(`DELETE FROM inbound_emails WHERE ${addressIn("sender_email")}`).bind(addresses),
    db.prepare(`DELETE FROM referrals WHERE ${addressIn("referee_email")}`).bind(addresses),
    db.prepare("DELETE FROM email_verifications WHERE email_sha256 IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([fields.email_sha256, ...hashes.map(([h]) => h)])),
    db.prepare("DELETE FROM contacts WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
  ]);
  return { emailSha256: fields.email_sha256, contactsDeleted: contacts.length };
}

/**
 * Erase by address hash alone. When a contact holds that hash, its address is known and the full
 * erasure runs; otherwise only the tombstone can be written, blocking that exact address.
 */
export async function eraseByHash(db: D1Database, emailSha256: string, options: ErasureOptions): Promise<ErasureResult> {
  if (!/^[0-9a-f]{64}$/.test(emailSha256)) throw new TypeError("an address hash is lowercase hex SHA-256");
  const contact = await db.prepare("SELECT email FROM contacts WHERE email_sha256 = ?1").bind(emailSha256).first<{ email: string }>();
  if (contact) return eraseContact(db, contact.email, options);
  const now = (options.now ?? new Date()).toISOString();
  await db
    .prepare("INSERT OR IGNORE INTO erasure_tombstones (email_sha256, product_user_id, source, erased_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(emailSha256, options.productUserId ?? null, options.source, now)
    .run();
  return { emailSha256, contactsDeleted: 0 };
}
