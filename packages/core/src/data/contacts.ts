// GTM-agents: contact helpers: email normalization for storage, and forward-only warmth.
//
// A contact is stored with its normalized address and two hashes: email_sha256 (the exact address)
// and mailbox_sha256 (the address without a +tag). Suppression, erasure and the product bridge
// match on the hashes. An address that does not normalize is never stored: skip the contact
// rather than guess.
//
// Warmth climbs cold -> contacted -> warming -> engaged -> hot -> customer and never falls back.
// churned (from customer) and opted_out (from anywhere, churned included) are terminal; a
// database trigger enforces the same, whatever code writes. Every change is a
// compare-and-set on the current value, so two writers racing cannot move a contact backwards or
// out of a terminal state.
import { addressHash, mailboxOf, normalizeAddress } from "../sending/suppression.ts";
import { TERMINAL_WARMTH, WARMTH_LADDER, WARMTH_STATES, type Warmth } from "./enums.ts";

export interface ContactEmailFields {
  email: string;
  email_sha256: string;
  mailbox_sha256: string;
}

/** The stored form of an address, or null when it is not exactly one valid address. */
export async function contactEmailFields(raw: unknown): Promise<ContactEmailFields | null> {
  const email = normalizeAddress(raw);
  if (!email) return null;
  return { email, email_sha256: await addressHash(email), mailbox_sha256: await addressHash(mailboxOf(email)) };
}

const isWarmth = (value: unknown): value is Warmth => typeof value === "string" && (WARMTH_STATES as readonly string[]).includes(value);

/** Whether warmth may move from `from` to `to`. Staying put is not a move. */
export function canAdvanceWarmth(from: Warmth, to: Warmth): boolean {
  if (!isWarmth(from) || !isWarmth(to) || from === to) return false;
  // An opt-out always wins, even for a churned customer.
  if (to === "opted_out") return from !== "opted_out";
  if (TERMINAL_WARMTH.includes(from)) return false;
  if (to === "churned") return from === "customer";
  return WARMTH_LADDER.indexOf(to) > WARMTH_LADDER.indexOf(from);
}

export type WarmthResult =
  | { changed: true; from: Warmth; to: Warmth }
  | { changed: false; reason: "not_found" | "not_forward" | "raced"; current?: Warmth };

/**
 * Move a contact's warmth forward. Reads the current value, refuses a move that is not forward,
 * then writes with a compare-and-set; if another writer changed it in between, retries once with
 * the new value. Throws on a database error, so a caller never believes a write happened when it
 * did not.
 */
export async function advanceWarmth(db: D1Database, contactId: string, to: Warmth, now: Date = new Date()): Promise<WarmthResult> {
  if (!isWarmth(to)) throw new TypeError(`unknown warmth "${String(to)}"`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contactId).first<{ warmth: Warmth }>();
    if (!row) return { changed: false, reason: "not_found" };
    if (!canAdvanceWarmth(row.warmth, to)) return { changed: false, reason: "not_forward", current: row.warmth };
    const result = await db
      .prepare("UPDATE contacts SET warmth = ?3, updated_at = ?4 WHERE id = ?1 AND warmth = ?2")
      .bind(contactId, row.warmth, to, now.toISOString())
      .run();
    if ((result.meta.changes ?? 0) > 0) return { changed: true, from: row.warmth, to };
  }
  return { changed: false, reason: "raced" };
}
