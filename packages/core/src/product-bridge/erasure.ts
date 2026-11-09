// GTM-agents: a product user's erasure (user.deleted, or a row from the nightly deletions pull).
//
// In order, each step a gate that throws so the whole erasure runs again on a failure:
//   1. the tombstone: the address hash and the product user id, written before anything else, so
//      from this moment every product event, billing event, pull row and sourcing path that names
//      the person is refused;
//   2. suppression of the hash (no address is kept);
//   3. every contact that is the person (linked by the product user id, or holding the hash as its
//      address or its mailbox) moves to deleted through the lifecycle writer, whose side effects
//      stop their sequences and then run the erasure (data/erasure.ts): drafts, inbound mail and its
//      bodies, event payloads, feedback and billing records go, and the contact row with them;
//   4. with no such contact, the hash-only erasure runs (data/erasure.ts, eraseByHash);
//   5. an audit row, with counts only.
// Running it again for the same person changes nothing.
import { eraseByHash, eraseContact, type ErasureSource } from "../data/erasure.ts";
import { writeAudit } from "../events/audit.ts";
import { applyLifecycleEvent } from "../lifecycle/apply.ts";
import { addSuppression } from "../sending/suppression.ts";

export interface ProductErasureDeps {
  db: D1Database;
  bucket: R2Bucket | undefined | null;
  now: Date;
}

export interface ProductErasureInput {
  userId: string | null;
  emailSha256: string;
  erasedAt: string;
  /** What caused it (the event row id, or the pull row), for the lifecycle writer. */
  eventKey: string;
  source: Extract<ErasureSource, "product" | "reconciliation">;
}

/** Write the tombstone, keeping the first product user id seen for the hash. Throws on a database error. */
export async function writeTombstone(db: D1Database, input: { emailSha256: string; userId: string | null; source: ErasureSource; erasedAt: string }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO erasure_tombstones (email_sha256, product_user_id, source, erased_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (email_sha256) DO UPDATE SET product_user_id = COALESCE(erasure_tombstones.product_user_id, excluded.product_user_id)`,
    )
    .bind(input.emailSha256, input.userId, input.source, input.erasedAt)
    .run();
}

/** Erase a product user. Returns how many contacts were erased. Throws when any step fails. */
export async function eraseProductUser(deps: ProductErasureDeps, input: ProductErasureInput): Promise<{ contactsErased: number }> {
  if (!/^[0-9a-f]{64}$/.test(input.emailSha256)) throw new TypeError("an erasure needs a lowercase hex SHA-256 of the address");
  const { db } = deps;
  await writeTombstone(db, { emailSha256: input.emailSha256, userId: input.userId, source: input.source, erasedAt: input.erasedAt });
  await addSuppression(db, { emailSha256: input.emailSha256, reason: "erasure", source: `lifecycle:${input.source}` });

  const { results } = await db
    .prepare(
      `SELECT id FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?1
       UNION SELECT contact_id FROM contact_lifecycle WHERE ?2 IS NOT NULL AND product_user_id = ?2`,
    )
    .bind(input.emailSha256, input.userId)
    .all<{ id: string }>();
  const erasure = { source: input.source, bucket: deps.bucket ?? null, ...(input.userId ? { productUserId: input.userId } : {}) };
  for (const { id } of results) {
    // An earlier iteration's erasure takes every contact on the same mailbox with it.
    if (!(await db.prepare("SELECT 1 AS hit FROM contacts WHERE id = ?1").bind(id).first())) continue;
    const result = await applyLifecycleEvent({ db, now: deps.now }, id, { kind: "user_deleted" }, { eventKey: input.eventKey, occurredAt: input.erasedAt, source: "product", erasure });
    if (result.effectsFailed.length > 0) throw new Error(`the erasure did not finish (${result.effectsFailed.join(", ")})`);
    // A contact the lifecycle did not move (already deleted by this event) is erased directly.
    const left = await db.prepare("SELECT email FROM contacts WHERE id = ?1").bind(id).first<{ email: string }>();
    if (left) throw new Error("a contact survived its erasure");
  }
  // The hash-only path also erases inbound mail and calendar entries found by the hash, and the
  // product user's own event payloads and feedback.
  await eraseByHash(db, input.emailSha256, { now: deps.now, ...erasure });
  await writeAudit(db, { agentId: "lifecycle", action: "product_user_erased", details: { source: input.source, contacts: results.length }, now: deps.now });
  return { contactsErased: results.length };
}

/**
 * Close the race between resolving a person and an erasure arriving meanwhile: when the contact a
 * route just wrote to is now tombstoned (by address, mailbox or product user id), erase it again,
 * so nothing written in that window survives. Returns true when it erased. Throws on a failure,
 * so the route retries.
 */
export async function eraseIfTombstoned(deps: ProductErasureDeps, input: { contactId: string; userId: string | null; source: Extract<ErasureSource, "product" | "reconciliation"> }): Promise<boolean> {
  const { db } = deps;
  const contact = await db.prepare("SELECT email, email_sha256, mailbox_sha256 FROM contacts WHERE id = ?1").bind(input.contactId).first<{ email: string; email_sha256: string; mailbox_sha256: string }>();
  if (!contact) return false;
  const hit = await db
    .prepare("SELECT 1 AS hit FROM erasure_tombstones WHERE email_sha256 IN (?1, ?2) OR mailbox_sha256 IN (?1, ?2) OR (?3 IS NOT NULL AND product_user_id = ?3) LIMIT 1")
    .bind(contact.email_sha256, contact.mailbox_sha256, input.userId)
    .first();
  if (!hit) return false;
  await eraseContact(db, contact.email, { source: input.source, now: deps.now, bucket: deps.bucket ?? null, ...(input.userId ? { productUserId: input.userId } : {}) });
  return true;
}
