// GTM-agents: the effects ledger.
//
// Work can run more than once for the same event: a queue retry, a backstop sweep, a job rerun, or
// a handler that failed halfway. State transitions are naturally idempotent, but sending an email,
// paging the operator or bumping a counter is not. Every such effect is claimed first:
//
//   if (await claimEffect(db, eventId, "reply_email")) await send(...);
//
// claimEffect returns true exactly once per (event id, effect) pair, including under concurrency.
// A claim is a gate, so it fails closed: a database error propagates and the effect does not
// happen. releaseEffect undoes a claim whose effect did not happen, so a later run can try again;
// it is bookkeeping, so it never throws.

function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`an effect needs a non-empty ${name}`);
  return value;
}

/** Claim `effect` for `eventId`. True for exactly one caller per pair. Throws on a database error. */
export async function claimEffect(db: D1Database, eventId: string, effect: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)")
    .bind(requireId(eventId, "event id"), requireId(effect, "effect name"), new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Undo a claim whose effect did not happen. Returns false if the release could not be written. */
export async function releaseEffect(db: D1Database, eventId: string, effect: string): Promise<boolean> {
  try {
    await db.prepare("DELETE FROM event_effects WHERE event_id = ?1 AND effect = ?2").bind(eventId, effect).run();
    return true;
  } catch {
    return false;
  }
}

/** True when the effect has been claimed. Throws on a database error. */
export async function hasEffect(db: D1Database, eventId: string, effect: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS hit FROM event_effects WHERE event_id = ?1 AND effect = ?2").bind(eventId, effect).first();
  return row !== null;
}

/**
 * Run `fn` only if this call wins the claim. If `fn` throws, the claim is released so a later run
 * can try again, and the error propagates.
 *
 * Use it for work that is safe to repeat after a failure. A send can fail after the provider has
 * accepted it (a time-out, a dropped response), and releasing the claim then sends twice: claim
 * sends with claimEffect, keep the claim on an ambiguous failure, and pass the event id to the
 * provider as an idempotency key where it supports one.
 */
export async function runOnce<T>(db: D1Database, eventId: string, effect: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!(await claimEffect(db, eventId, effect))) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } catch (error) {
    await releaseEffect(db, eventId, effect);
    throw error;
  }
}
