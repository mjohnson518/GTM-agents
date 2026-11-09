// GTM-agents: who a product user is, in the agent's contacts (docs/LIFECYCLE.md, docs/EVENT-CONTRACT.md).
//
// Resolution order, most certain first, with erasure checked before anything else:
//   0. tombstones: an erased person (by product user id, or by the hash of their address with or
//      without a +tag) is refused, so nothing brings them back;
//   1. linked: a lifecycle row already carries this product user id;
//   2. ref token: the event carries an attribution token the agent issued, still valid, whose
//      contact is this address (the same mailbox). A token used by anyone else (a forwarded link)
//      still credits its campaign, but never decides who the person is: identity then comes from
//      the steps below. Only while outreach:ref_tokens_enabled is on;
//   3. email: a contact with this address, or another +tag of the same mailbox;
//   4. domain: no such person, but the address's domain is a known account (an accounts row, or a
//      contact keyed to it): a new contact at that account;
//   5. inbound: anyone else: a new contact.
// The account is always the sign-up address's own domain (accountKey), never the org's self-declared
// domain, and a personal mailbox is never an account. A new contact's name is reduced to plain name
// characters, because the host's users type it. An address that does not parse is skipped: no
// contact is created from a guess. Contacts are only ever created here, never updated.
import { contactEmailFields } from "../data/contacts.ts";
import { accountKey } from "../data/keys.ts";
import type { AttributionMethod } from "../lifecycle/apply.ts";
import { addressHash, mailboxOf } from "../sending/suppression.ts";

/** An attribution token is valid this long after it was issued: 60 days on a link, then the 30-day cookie. */
export const REF_TOKEN_TTL_DAYS = 90;

export type Resolution =
  | { kind: "resolved"; contactId: string; method: AttributionMethod | "linked"; created: boolean; campaignId: string | null }
  | { kind: "erased" }
  | { kind: "skipped"; reason: string };

export interface ProductUserInput {
  userId: string;
  /** As received; normalized here. */
  email: string;
  name: string | null;
  ref: string | null;
}

/** A display name reduced to letters, marks, spaces, hyphens, apostrophes and periods, at most 60 characters. */
export function plainName(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M} .'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** First and last name from a display name; both null when nothing usable is left. */
export function splitName(name: string | null | undefined): { first: string | null; last: string | null } {
  const clean = plainName(name);
  if (!clean) return { first: null, last: null };
  const space = clean.indexOf(" ");
  return space < 0 ? { first: clean, last: null } : { first: clean.slice(0, space), last: clean.slice(space + 1) };
}

/** True when this product user id or address was erased. Throws on a database error (a gate fails closed). */
export async function isErased(db: D1Database, who: { userId?: string | null; emailSha256?: string | null; mailboxSha256?: string | null }): Promise<boolean> {
  const hashes = [who.emailSha256, who.mailboxSha256].filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h));
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM erasure_tombstones
        WHERE (?1 IS NOT NULL AND product_user_id = ?1)
           OR email_sha256 IN (SELECT value FROM json_each(?2))
           OR mailbox_sha256 IN (SELECT value FROM json_each(?2))
        LIMIT 1`,
    )
    .bind(who.userId ?? null, JSON.stringify(hashes))
    .first();
  return row !== null;
}

/** Resolve (or create) the contact for a product user. Throws on a database error. */
export async function resolveProductUser(db: D1Database, input: ProductUserInput, options: { now: Date; refTokens: boolean }): Promise<Resolution> {
  const fields = await contactEmailFields(input.email);
  const mailboxHash = fields ? await addressHash(mailboxOf(fields.email)) : null;
  if (await isErased(db, { userId: input.userId, emailSha256: fields?.email_sha256 ?? null, mailboxSha256: mailboxHash })) return { kind: "erased" };

  const linked = await db.prepare("SELECT contact_id FROM contact_lifecycle WHERE product_user_id = ?1").bind(input.userId).first<{ contact_id: string }>();
  if (linked) return { kind: "resolved", contactId: linked.contact_id, method: "linked", created: false, campaignId: null };
  if (!fields || !mailboxHash) return { kind: "skipped", reason: "the address does not parse" };

  let refCampaign: string | null = null;
  if (options.refTokens && input.ref) {
    const since = new Date(options.now.getTime() - REF_TOKEN_TTL_DAYS * 86_400_000).toISOString();
    const token = await db
      .prepare("SELECT r.contact_id, r.campaign_id, c.mailbox_sha256 FROM ref_tokens r JOIN contacts c ON c.id = r.contact_id WHERE r.token = ?1 AND r.created_at > ?2")
      .bind(input.ref, since)
      .first<{ contact_id: string; campaign_id: string | null; mailbox_sha256: string }>();
    if (token) {
      refCampaign = token.campaign_id;
      if (token.mailbox_sha256 === mailboxHash) return { kind: "resolved", contactId: token.contact_id, method: "ref_token", created: false, campaignId: refCampaign };
    }
  }

  const byEmail = await db
    .prepare("SELECT id FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 ORDER BY (email_sha256 = ?1) DESC, created_at LIMIT 1")
    .bind(fields.email_sha256, mailboxHash)
    .first<{ id: string }>();
  if (byEmail) return { kind: "resolved", contactId: byEmail.id, method: "email", created: false, campaignId: refCampaign };

  const account = accountKey(fields.email);
  let method: AttributionMethod = "inbound";
  if (account) {
    const known = await db
      .prepare("SELECT 1 AS hit WHERE EXISTS (SELECT 1 FROM accounts WHERE account_key = ?1) OR EXISTS (SELECT 1 FROM contacts WHERE account_key = ?1)")
      .bind(account)
      .first();
    if (known) method = "domain";
  }
  const { first, last } = splitName(input.name);
  const at = options.now.toISOString();
  await db
    .prepare(
      `INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, source, warmth, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'product', 'cold', ?8, ?8
        WHERE NOT EXISTS (SELECT 1 FROM erasure_tombstones WHERE email_sha256 IN (?5, ?6) OR mailbox_sha256 IN (?5, ?6) OR product_user_id = ?9)
       ON CONFLICT DO NOTHING`,
    )
    .bind(crypto.randomUUID(), first, last, fields.email, fields.email_sha256, fields.mailbox_sha256, account, at, input.userId)
    .run();
  // Read back by address: a concurrent event for the same person may have created the row first.
  // An erasure that landed since the check above leaves no row: the person is erased.
  const stored = await db.prepare("SELECT id, created_at FROM contacts WHERE email_sha256 = ?1").bind(fields.email_sha256).first<{ id: string; created_at: string }>();
  if (!stored) return { kind: "erased" };
  return { kind: "resolved", contactId: stored.id, method, created: stored.created_at === at, campaignId: refCampaign };
}
