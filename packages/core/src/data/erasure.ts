// GTM-agents: erasure. One call removes a person's personal data and leaves a tombstone.
//
// A person is a mailbox: erasing jane@acme.example also erases jane+news@acme.example, and the
// reverse. eraseContact finds every contact stored under the mailbox, erases their inbound mail
// (bodies before rows, repeatable), then runs one D1 batch for everything else, all or nothing:
//   1. writes the tombstone (exact and mailbox hashes) that keeps the person from being re-added
//      or emailed;
//   2. deletes rows that hold one of their addresses without a contact link, matching case,
//      surrounding spaces and the "Name <address>" form: candidates and their evidence, drafts and
//      deferred sends, referrals naming them, operator chat messages that mention them, cached
//      verification results, calendar events that hold one of their address hashes or are linked
//      to their contact (calendar sync; a meeting that belongs to someone else loses only their
//      attendee entry, hash, domain and contact id), and deal handoff briefs about them (linked
//      through their contact's deals, or naming one of their addresses). Before that batch,
//      inbound mail they sent or that names them (in its
//      subject, preview or headers, or as a failed recipient of a delivery report) is deleted,
//      each body from blob storage before its row (the bucket option is required when bodies
//      exist);
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
  /**
   * Blob storage holding inbound bodies (the BUCKET binding). The bodies of the inbound mail being
   * erased are deleted before their rows; a deletion that fails throws, so the erasure can simply
   * be run again. Required when the person has inbound mail with a stored body.
   */
  bucket?: Pick<R2Bucket, "delete"> | null;
}

// Matches a free-text address column against the JSON list of addresses in ?1.
const addressIn = (column: string) =>
  `(lower(trim(${column})) IN (SELECT value FROM json_each(?1)) OR EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(${column}), '<' || value || '>') > 0))`;

// Inbound mail about the person: mail they sent (by address, address hash or contact), delivery
// reports about them (by failed-recipient hash), and mail whose subject, preview or headers name
// one of their addresses. ?1 is the JSON list of addresses, ?2 of contact ids, ?3 of address hashes.
const inboundAbout = `SELECT id, body_key FROM inbound_emails WHERE ${addressIn("sender_email")}
  OR contact_id IN (SELECT value FROM json_each(?2))
  OR sender_sha256 IN (SELECT value FROM json_each(?3))
  OR sender_mailbox_sha256 IN (SELECT value FROM json_each(?3))
  OR EXISTS (SELECT 1 FROM json_each(inbound_emails.failed_recipients) f WHERE f.value IN (SELECT value FROM json_each(?3)))
  OR EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(coalesce(subject, '') || ' ' || coalesce(body_preview, '') || ' ' || coalesce(headers, '')), value) > 0)
  LIMIT 500`;

// R2 deletes at most 1,000 keys per call.
const BLOB_DELETE_CHUNK = 1000;
const MAX_INBOUND_PASSES = 20;

/**
 * Delete the inbound rows matching `select` (which returns id and body_key), bodies first. Each
 * pass selects once, deletes exactly those blobs, then exactly those rows, so a row that arrives
 * mid-pass is never deleted without its blob; passes repeat until nothing matches. Throws on a
 * storage error before any row of that pass is deleted, and refuses to delete rows that have a
 * body when no bucket was given, rather than orphan the body.
 */
async function eraseInbound(db: D1Database, bucket: Pick<R2Bucket, "delete"> | null | undefined, select: string, binds: unknown[]): Promise<void> {
  for (let pass = 0; pass < MAX_INBOUND_PASSES; pass++) {
    const { results } = await db.prepare(select).bind(...binds).all<{ id: string; body_key: string | null }>();
    if (results.length === 0) return;
    const keys = results.map((r) => r.body_key).filter((k): k is string => typeof k === "string" && k.length > 0);
    if (keys.length > 0 && !bucket) throw new TypeError("this person has inbound mail with stored bodies; pass the BUCKET binding as options.bucket so they are erased too");
    for (let i = 0; i < keys.length; i += BLOB_DELETE_CHUNK) await bucket?.delete(keys.slice(i, i + BLOB_DELETE_CHUNK));
    await db.prepare("DELETE FROM inbound_emails WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(results.map((r) => r.id))).run();
  }
  throw new Error("inbound mail kept arriving while it was being erased; run the erasure again");
}

/**
 * Take the people whose hashes are in `hashes` (a JSON list) off the calendar events `scope`
 * selects (meetings that belong to someone else): their attendee entries go, and the hash and
 * domain lists are rebuilt from the entries left, so a domain only they shared disappears too.
 * `scope` may use ?2, bound to `scopeParam`.
 */
function pruneCalendarAttendees(db: D1Database, hashes: string, scope: string, scopeParam = "[]"): D1PreparedStatement[] {
  const bind = (statement: D1PreparedStatement) => (scope.includes("?2") ? statement.bind(hashes, scopeParam) : statement.bind(hashes));
  const holds = "EXISTS (SELECT 1 FROM json_each(calendar_events.attendee_hashes) h WHERE h.value IN (SELECT value FROM json_each(?1)))";
  return [
    bind(
      db.prepare(
        `UPDATE calendar_events SET attendees = (SELECT json_group_array(json(e.value)) FROM json_each(calendar_events.attendees) e
            WHERE json_extract(e.value, '$.h') NOT IN (SELECT value FROM json_each(?1)) AND json_extract(e.value, '$.m') NOT IN (SELECT value FROM json_each(?1)))
          WHERE ${scope} AND ${holds}`,
      ),
    ),
    bind(
      db.prepare(
        `UPDATE calendar_events SET
            attendee_hashes = (SELECT json_group_array(v) FROM (SELECT json_extract(e.value, '$.h') AS v FROM json_each(calendar_events.attendees) e
                                 UNION SELECT json_extract(e.value, '$.m') FROM json_each(calendar_events.attendees) e)),
            attendee_domains = (SELECT json_group_array(v) FROM (SELECT DISTINCT json_extract(e.value, '$.d') AS v FROM json_each(calendar_events.attendees) e))
          WHERE ${scope} AND ${holds}`,
      ),
    ),
  ];
}

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
  const addressHashes = JSON.stringify([...new Set([fields.email_sha256, fields.mailbox_sha256, ...hashes.map(([h]) => h)])]);
  // Inbound mail first, bodies before rows: a storage failure throws before the person's other
  // rows are touched, so the erasure can simply run again.
  await eraseInbound(db, options.bucket, inboundAbout, [addresses, ids, addressHashes]);
  await db.batch([
    tombstone.bind(fields.email_sha256, fields.mailbox_sha256, options.productUserId ?? null, options.source, now),
    ...hashes.map(([hash]) => tombstone.bind(hash, fields.mailbox_sha256, options.productUserId ?? null, options.source, now)),
    db.prepare(`DELETE FROM contact_evidence WHERE candidate_id IN (${candidates})`).bind(addresses, ids),
    db.prepare(`DELETE FROM candidates WHERE id IN (${candidates})`).bind(addresses, ids),
    db.prepare(`DELETE FROM drafts WHERE ${addressIn("recipient_email")}`).bind(addresses),
    db.prepare(`DELETE FROM deferred_sends WHERE ${addressIn("recipient_email")}`).bind(addresses),
    db.prepare(`DELETE FROM referrals WHERE ${addressIn("referee_email")}`).bind(addresses),
    // Operator chat history can quote an address; drop any message that mentions one of them.
    db.prepare("DELETE FROM chat_messages WHERE EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(content), value) > 0)").bind(addresses),
    db.prepare("DELETE FROM email_verifications WHERE email_sha256 IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([fields.email_sha256, ...hashes.map(([h]) => h)])),
    // Calendar sync: a meeting that belongs to someone else stays theirs and loses the person's
    // attendee entry and contact id; events linked to their contact or still holding one of their
    // hashes are deleted, and so are the briefs written about them. Deal rows outlive the contact
    // (contact_id is cleared), so their briefs are deleted here, before the contact rows go.
    ...pruneCalendarAttendees(db, addressHashes, "event_id IN (SELECT event_id FROM calendar_meetings WHERE contact_id NOT IN (SELECT value FROM json_each(?2)))", ids),
    db
      .prepare(
        `UPDATE calendar_events SET other_contacts = (SELECT json_group_array(o.value) FROM json_each(calendar_events.other_contacts) o WHERE o.value NOT IN (SELECT value FROM json_each(?1)))
          WHERE EXISTS (SELECT 1 FROM json_each(calendar_events.other_contacts) o WHERE o.value IN (SELECT value FROM json_each(?1)))`,
      )
      .bind(ids),
    db
      .prepare(
        `DELETE FROM calendar_events WHERE event_id IN (SELECT event_id FROM calendar_meetings WHERE contact_id IN (SELECT value FROM json_each(?1)))
           OR EXISTS (SELECT 1 FROM json_each(calendar_events.attendee_hashes) h WHERE h.value IN (SELECT value FROM json_each(?2)))`,
      )
      .bind(ids, addressHashes),
    db
      .prepare(
        `DELETE FROM deal_handoffs WHERE deal_id IN (SELECT id FROM deals WHERE contact_id IN (SELECT value FROM json_each(?1)))
           OR EXISTS (SELECT 1 FROM json_each(?2) WHERE instr(lower(brief_markdown), value) > 0)`,
      )
      .bind(ids, addresses),
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
  // Mail they sent and delivery reports about them are found by the hash too.
  await eraseInbound(db, options.bucket, inboundAbout, ["[]", "[]", JSON.stringify([emailSha256])]);
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO erasure_tombstones (email_sha256, product_user_id, source, erased_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)")
      .bind(emailSha256, options.productUserId ?? null, options.source, now),
    // A calendar event that holds the hash (an attendee who was never a contact): the attendee comes
    // off a meeting that belongs to a contact, and any other such event is deleted.
    ...pruneCalendarAttendees(db, JSON.stringify([emailSha256]), "event_id IN (SELECT event_id FROM calendar_meetings)"),
    db.prepare("DELETE FROM calendar_events WHERE EXISTS (SELECT 1 FROM json_each(calendar_events.attendee_hashes) h WHERE h.value = ?1)").bind(emailSha256),
  ]);
  return { emailSha256, contactsDeleted: 0 };
}
