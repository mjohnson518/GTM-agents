// GTM-agents: erasure. One call removes a person's personal data and leaves a tombstone.
//
// A person is a mailbox: erasing jane@acme.example also erases jane+news@acme.example, and the
// reverse. eraseContact finds every contact stored under the mailbox, erases their inbound mail
// (bodies before rows, repeatable), then runs one D1 batch for everything else, all or nothing:
//   1. writes the tombstone (exact and mailbox hashes) that keeps the person from being re-added
//      or emailed;
//   2. deletes rows that hold one of their addresses without a contact link, matching case,
//      surrounding spaces and the "Name <address>" form: candidates and their evidence, drafts and
//      deferred sends, referrals naming them, operator chat messages, timers, notes and held
//      outbox notices that mention them, cached verification results, calendar events that hold
//      one of their address hashes or are linked to their contact (calendar sync; a meeting that
//      belongs to someone else loses only their attendee entry, hash, domain and contact id), and
//      deal handoff briefs about them (linked through their contact's deals, or naming one of
//      their addresses). Before that batch,
//      inbound mail they sent or that names them (in its
//      subject, preview or headers, or as a failed recipient of a delivery report) is deleted,
//      each body from blob storage before its row (the bucket option is required when bodies
//      exist);
//   3. deletes the contact rows. Foreign keys then delete per-contact state (tags, scores, drafts,
//      inbound mail, meetings, feedback and so on) and clear contact_id on the measurement ledgers.
//      A contact the CRM mirror wrote to a CRM loses its link; the CRM record to delete there is
//      kept in crm_erasures and named in a notice held for the operator outbox (docs/CRM.md).
//      Nothing is sent to the CRM.
// Product and billing data go in the same erasure (eraseProductData): the raw payloads of events
// about the person (linked to their contact, or naming their product user id) are deleted from blob
// storage before the batch, like inbound bodies, and the batch clears those rows' payload key and
// user id, deletes feedback filed under their product user id, and reduces their billing customer
// records to a marker (the hash of the customer id) so a later billing event for them is refused.
// The product user id comes from the caller or from the contact's lifecycle row, and the tombstone
// keeps it so a later event naming that user is refused too.
// A person followed to a new employer (signals/employment.ts) is one person at two addresses: a
// champion candidate links the new address to the old contact (candidates.source_contact_id), and
// erasure follows that link both ways, through addresses only (withLineage), so erasing either
// address erases the contacts, candidates and data held under both, and tombstones both.
// eraseByHash does the same when only the address hash is known (the product's user.deleted
// event). Memory text is not linked to a contact; the memory module removes it separately.
import { addressHash, mailboxOf } from "../sending/suppression.ts";
import { sha256Hex } from "../shared/hash.ts";
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
/** A lowercased address column with any +tag removed: its mailbox, in SQL (mailboxOf). */
const mailboxSql = (column: string) =>
  `(CASE WHEN instr(substr(lower(trim(${column})), 1, instr(lower(trim(${column})), '@') - 1), '+') > 0
     THEN substr(lower(trim(${column})), 1, instr(lower(trim(${column})), '+') - 1) || substr(lower(trim(${column})), instr(lower(trim(${column})), '@'))
     ELSE lower(trim(${column})) END)`;

/** Hops followed along champion links (signals/employment.ts) when collecting one person's contacts. */
const LINEAGE_ROUNDS = 5;

interface ErasedContact {
  id: string;
  email: string;
  mailbox_sha256: string;
}

/**
 * The person's contacts and the addresses of the champion candidates linked to them. A champion
 * candidate (source champion_move) names the contact the person was before they moved
 * (source_contact_id) and holds their new address. The link is followed only through addresses,
 * both ways and up to LINEAGE_ROUNDS hops: from a contact to the addresses of its champion
 * candidates and the contacts holding those addresses, and from an address to the champion
 * candidates holding it and the contacts they came from. It never follows a match by name, so a
 * namesake at the new company is never erased in the person's place.
 */
async function withLineage(db: D1Database, start: ErasedContact[], startEmail: string): Promise<{ contacts: ErasedContact[]; candidateEmails: string[] }> {
  const contacts = new Map(start.map((c) => [c.id, c]));
  const emails = new Set([startEmail, ...start.map((c) => c.email)]);
  const candidateEmails = new Set<string>();
  for (let round = 0; round < LINEAGE_ROUNDS; round++) {
    const before = contacts.size + emails.size;
    const { results: links } = await db
      .prepare(
        `SELECT source_contact_id, lower(trim(email)) AS email FROM candidates
          WHERE source = 'champion_move' AND source_contact_id IS NOT NULL AND email IS NOT NULL
            AND (source_contact_id IN (SELECT value FROM json_each(?1)) OR ${mailboxSql("email")} IN (SELECT value FROM json_each(?2)))`,
      )
      // A person is a mailbox: a +tag variant of an address matches it.
      .bind(JSON.stringify([...contacts.keys()]), JSON.stringify([...new Set([...emails].map(mailboxOf))]))
      .all<{ source_contact_id: string; email: string }>();
    const fresh = new Set<string>();
    const sourceIds = new Set<string>();
    for (const link of links) {
      candidateEmails.add(link.email);
      if (!emails.has(link.email)) fresh.add(link.email);
      if (!contacts.has(link.source_contact_id)) sourceIds.add(link.source_contact_id);
    }
    // Contacts at the new addresses (by address or mailbox), and the contacts the links came from.
    const hashes = (await Promise.all([...fresh].map((e) => contactEmailFields(e)))).flatMap((f) => (f ? [f.email_sha256, f.mailbox_sha256] : []));
    const { results: found } = await db
      .prepare(
        `SELECT id, email, mailbox_sha256 FROM contacts
          WHERE id IN (SELECT value FROM json_each(?1)) OR email_sha256 IN (SELECT value FROM json_each(?2)) OR mailbox_sha256 IN (SELECT value FROM json_each(?2))`,
      )
      .bind(JSON.stringify([...sourceIds]), JSON.stringify(hashes))
      .all<ErasedContact>();
    for (const e of fresh) emails.add(e);
    for (const c of found) {
      contacts.set(c.id, c);
      emails.add(c.email);
    }
    if (contacts.size + emails.size === before) break;
  }
  return { contacts: [...contacts.values()], candidateEmails: [...candidateEmails] };
}
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
 * Product and billing data about the person: deletes the event payloads first (throwing on a
 * storage error, or when payloads exist and no bucket was given), then returns the statements for
 * the erasure batch. ?1 is the JSON list of contact ids, ?2 of product user ids, ?3 of address hashes.
 */
async function eraseProductData(db: D1Database, bucket: Pick<R2Bucket, "delete"> | null | undefined, scope: { contactIds: string[]; userIds: string[]; hashes: string[] }): Promise<D1PreparedStatement[]> {
  const ids = JSON.stringify(scope.contactIds);
  const users = JSON.stringify(scope.userIds);
  const hashes = JSON.stringify(scope.hashes);
  // subject_ref holds a product user id, or (for a billing event) the address hash.
  const about = "(contact_id IN (SELECT value FROM json_each(?1)) OR subject_ref IN (SELECT value FROM json_each(?2)) OR subject_ref IN (SELECT value FROM json_each(?3)))";
  const { results } = await db.prepare(`SELECT payload_key FROM events WHERE ${about} AND payload_key IS NOT NULL`).bind(ids, users, hashes).all<{ payload_key: string }>();
  const keys = results.map((r) => r.payload_key).filter((k) => k.startsWith("events/"));
  const { results: billing } = await db
    .prepare(
      `SELECT id, provider, provider_customer_id FROM billing_customers
        WHERE (contact_id IN (SELECT value FROM json_each(?1)) OR email_sha256 IN (SELECT value FROM json_each(?2))) AND provider_customer_id NOT LIKE '${ERASED_CUSTOMER_PREFIX}%'`,
    )
    .bind(ids, hashes)
    .all<{ id: string; provider: string; provider_customer_id: string }>();
  if (keys.length > 0 && !bucket) throw new TypeError("this person has stored event payloads; pass the BUCKET binding as options.bucket so they are erased too");
  for (let i = 0; i < keys.length; i += BLOB_DELETE_CHUNK) await bucket?.delete(keys.slice(i, i + BLOB_DELETE_CHUNK));
  return [
    db.prepare(`UPDATE events SET payload_key = NULL, subject_ref = NULL WHERE ${about}`).bind(ids, users, hashes),
    db.prepare("DELETE FROM feedback_items WHERE product_user_id IN (SELECT value FROM json_each(?1))").bind(users),
    // A billing customer record keeps only a marker: its provider, the hash of its customer id in
    // place of the id, and the address hash the tombstone already holds. Everything else goes, and
    // a later billing event for that customer, with or without an address, is refused by it.
    ...(await Promise.all(
      billing.map(async (b) =>
        db
          .prepare(
            `UPDATE billing_customers SET provider_customer_id = ?2, provider_subscription_id = NULL, contact_id = NULL, plan = NULL,
               status = 'canceled', last_checkout_at = NULL WHERE id = ?1`,
          )
          .bind(b.id, await erasedCustomerMarker(b.provider, b.provider_customer_id)),
      ),
    )),
  ];
}

const ERASED_CUSTOMER_PREFIX = "erased:";

/** What an erased billing customer's id becomes: a hash of the provider and the id, never the id. */
export async function erasedCustomerMarker(provider: string, customerId: string): Promise<string> {
  return `${ERASED_CUSTOMER_PREFIX}${await sha256Hex(`${provider}:${customerId}`)}`;
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
  const { results: direct } = await db
    .prepare("SELECT id, email, mailbox_sha256 FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 OR email_sha256 = ?2")
    .bind(fields.email_sha256, fields.mailbox_sha256)
    .all<ErasedContact>();
  // The same person at another address, through a champion link.
  const lineage = await withLineage(db, direct, fields.email);
  const contacts = lineage.contacts;
  const linkedFields = (await Promise.all(lineage.candidateEmails.map((e) => contactEmailFields(e)))).filter((f): f is NonNullable<typeof f> => f !== null);
  const addresses = JSON.stringify([...new Set([fields.email, ...contacts.map((c) => c.email), ...linkedFields.map((f) => f.email)])]);
  const ids = JSON.stringify(contacts.map((c) => c.id));
  const candidates = `SELECT id FROM candidates WHERE ${addressIn("email")} OR promoted_contact_id IN (SELECT value FROM json_each(?2)) OR source_contact_id IN (SELECT value FROM json_each(?2))`;
  const tombstone = db
    .prepare(
      `INSERT INTO erasure_tombstones (email_sha256, mailbox_sha256, product_user_id, source, erased_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(email_sha256) DO UPDATE SET mailbox_sha256 = COALESCE(erasure_tombstones.mailbox_sha256, excluded.mailbox_sha256),
         product_user_id = COALESCE(erasure_tombstones.product_user_id, excluded.product_user_id)`,
    );
  // Each address's own hash with its own mailbox hash: the person's contacts, then the addresses of
  // champion candidates linked to them.
  const hashes = [
    ...(await Promise.all(contacts.map(async (c) => [await addressHash(c.email), c.mailbox_sha256] as const))),
    ...linkedFields.map((f) => [f.email_sha256, f.mailbox_sha256] as const),
  ];
  const addressHashes = JSON.stringify([...new Set([fields.email_sha256, fields.mailbox_sha256, ...hashes.flatMap(([h, m]) => [h, m])])]);
  // Their product user ids: the caller's, and any their lifecycle rows link.
  const { results: linked } = await db
    .prepare("SELECT product_user_id FROM contact_lifecycle WHERE contact_id IN (SELECT value FROM json_each(?1)) AND product_user_id IS NOT NULL")
    .bind(ids)
    .all<{ product_user_id: string }>();
  const userIds = [...new Set([...(options.productUserId ? [options.productUserId] : []), ...linked.map((r) => r.product_user_id)])];
  const productUserId = userIds[0] ?? null;
  // Inbound mail first, bodies before rows, then event payloads: a storage failure throws before
  // the person's other rows are touched, so the erasure can simply run again.
  await eraseInbound(db, options.bucket, inboundAbout, [addresses, ids, addressHashes]);
  const productData = await eraseProductData(db, options.bucket, { contactIds: contacts.map((c) => c.id), userIds, hashes: JSON.parse(addressHashes) as string[] });
  await db.batch([
    tombstone.bind(fields.email_sha256, fields.mailbox_sha256, productUserId, options.source, now),
    ...hashes.map(([hash, mailbox]) => tombstone.bind(hash, mailbox, productUserId, options.source, now)),
    ...productData,
    db.prepare(`DELETE FROM contact_evidence WHERE candidate_id IN (${candidates})`).bind(addresses, ids),
    db.prepare(`DELETE FROM candidates WHERE id IN (${candidates})`).bind(addresses, ids),
    db.prepare(`DELETE FROM drafts WHERE ${addressIn("recipient_email")}`).bind(addresses),
    db.prepare(`DELETE FROM deferred_sends WHERE ${addressIn("recipient_email")}`).bind(addresses),
    db.prepare(`DELETE FROM referrals WHERE ${addressIn("referee_email")}`).bind(addresses),
    // Operator chat history can quote an address; drop any message that mentions one of them, any
    // timer whose note does (a deleted timer never fires: its queued message finds no row), any
    // saved note that does, and any notice waiting in the operator outbox that does.
    db.prepare("DELETE FROM chat_messages WHERE EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(content), value) > 0)").bind(addresses),
    db.prepare("DELETE FROM operator_timers WHERE EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(note), value) > 0)").bind(addresses),
    db.prepare("DELETE FROM operator_notes WHERE EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(text), value) > 0)").bind(addresses),
    db.prepare("DELETE FROM operator_outbox WHERE text IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(lower(text), value) > 0)").bind(addresses),
    // Notices about a contact name it without its address, and carry its id: those go too.
    db.prepare("DELETE FROM operator_outbox WHERE text IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(?1) WHERE instr(text, '(contact ' || value || ')') > 0)").bind(ids),
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
    // The CRM mirror: the record in the CRM is the operator's to delete. crm_erasures keeps its id
    // for good, and the notice, which the operator_outbox job delivers, names it. Neither holds an
    // address.
    db
      .prepare(
        `INSERT OR IGNORE INTO crm_erasures (sink, external_id, erased_at, created_at)
         SELECT sink, external_id, ?2, ?2 FROM crm_links WHERE local_kind = 'contact' AND local_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids, now),
    db
      .prepare(
        `INSERT INTO operator_outbox (id, kind, text, silent, status, release_at, attempts, created_at, updated_at)
         SELECT 'ob_' || lower(hex(randomblob(8))), 'notice',
                'A person mirrored to the CRM (' || sink || ') was erased here. Their CRM record ' || external_id || ' still holds their data: delete it in the CRM yourself. The mirror will not write to it again.',
                0, 'held', ?2, 0, ?2, ?2
           FROM crm_links WHERE local_kind = 'contact' AND local_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids, now),
    db.prepare("DELETE FROM crm_links WHERE local_kind = 'contact' AND local_id IN (SELECT value FROM json_each(?1))").bind(ids),
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
  // Mail they sent and delivery reports about them are found by the hash too, and so are their
  // billing records; their product user id, when known, finds their event payloads and feedback.
  await eraseInbound(db, options.bucket, inboundAbout, ["[]", "[]", JSON.stringify([emailSha256])]);
  const productData = await eraseProductData(db, options.bucket, { contactIds: [], userIds: options.productUserId ? [options.productUserId] : [], hashes: [emailSha256] });
  await db.batch([
    db
      .prepare(
        `INSERT INTO erasure_tombstones (email_sha256, product_user_id, source, erased_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (email_sha256) DO UPDATE SET product_user_id = COALESCE(erasure_tombstones.product_user_id, excluded.product_user_id)`,
      )
      .bind(emailSha256, options.productUserId ?? null, options.source, now),
    ...productData,
    // A calendar event that holds the hash (an attendee who was never a contact): the attendee comes
    // off a meeting that belongs to a contact, and any other such event is deleted.
    ...pruneCalendarAttendees(db, JSON.stringify([emailSha256]), "event_id IN (SELECT event_id FROM calendar_meetings)"),
    db.prepare("DELETE FROM calendar_events WHERE EXISTS (SELECT 1 FROM json_each(calendar_events.attendee_hashes) h WHERE h.value = ?1)").bind(emailSha256),
  ]);
  return { emailSha256, contactsDeleted: 0 };
}
