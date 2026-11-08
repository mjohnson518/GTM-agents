// GTM-agents: the database side of a send: the exactly-once claim on each message, and the
// bookkeeping writes after it.
//
// Each message's idempotency key is claimed in the effects ledger (event_effects, effect
// "email_send") right before it goes to the provider, so the same message is never sent twice,
// whoever calls the send function and however often. Claims for one provider batch are written in
// one D1 batch, the same INSERT OR IGNORE claimEffect uses: a row inserted is a claim won, and a
// database error propagates so nothing is sent unclaimed.
//
// Bookkeeping after a send is written a batch per kind of write (D1 counts a batch as one query
// against the per-invocation limit, so a 500-message day stays far inside it). A batch is all or
// nothing, so when one fails its statements are retried one by one and only the ones that still
// fail are counted. Bookkeeping never throws: a failed write is reported and dropped.
import { releaseEffect } from "../events/effects.ts";

export const SEND_EFFECT = "email_send";

// D1 binds at most 100 parameters per statement.
const IN_CHUNK = 90;

/** The keys among `keys` that already hold a send claim. Throws on a database error. */
export async function claimedKeys(db: D1Database, keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map((_, k) => `?${k + 2}`).join(", ");
    const { results } = await db
      .prepare(`SELECT event_id FROM event_effects WHERE effect = ?1 AND event_id IN (${placeholders})`)
      .bind(SEND_EFFECT, ...chunk)
      .all<{ event_id: string }>();
    for (const row of results) found.add(row.event_id);
  }
  return found;
}

/** Claim each key; true where this call won the claim. Throws on a database error. */
export async function claimSends(db: D1Database, keys: readonly string[], now: Date): Promise<boolean[]> {
  if (keys.length === 0) return [];
  const statement = db.prepare("INSERT OR IGNORE INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)");
  const results = await db.batch(keys.map((key) => statement.bind(key, SEND_EFFECT, now.toISOString())));
  return results.map((r) => (r.meta.changes ?? 0) > 0);
}

/** Undo a claim for a message the provider definitely did not accept. Never throws. */
export function releaseSend(db: D1Database, key: string): Promise<boolean> {
  return releaseEffect(db, key, SEND_EFFECT);
}

/**
 * Run bookkeeping statements, one batch first and then one by one if the batch fails. Returns, per
 * statement, whether it was written. Never throws.
 */
export async function runWrites(db: D1Database, statements: readonly D1PreparedStatement[]): Promise<boolean[]> {
  if (statements.length === 0) return [];
  try {
    await db.batch([...statements]);
    return statements.map(() => true);
  } catch {
    const written: boolean[] = [];
    for (const statement of statements) {
      try {
        await statement.run();
        written.push(true);
      } catch {
        written.push(false);
      }
    }
    return written;
  }
}
