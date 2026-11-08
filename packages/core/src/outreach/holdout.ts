// GTM-agents: the holdout: a no-send control group for measuring lift.
//
// Each batch draws its holdout from the contacts it would otherwise write to, so the held group is
// matched to the treated one: every picked contact is held independently with probability
// outreach:holdout_rate (default 5%, at most 20%), using a seeded generator whose seed is recorded
// with the campaign, so the draw can be reproduced. A held contact is claimed like a sent one, is
// recorded in outreach_holdout, gets no draft, and is kept out of cold selection for HOLDOUT_DAYS.
// heldOutContacts lets any send path refuse a held contact as well.
import { inChunks, placeholders } from "../data/d1.ts";

export const HOLDOUT_DAYS = 90;
const DAY_MS = 86_400_000;

export type Rng = () => number;

/** A seeded uniform generator in [0, 1): FNV-1a of the seed into mulberry32. Pure. */
export function seededRng(seed: string): Rng {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ids to hold out: each independently with probability `rate`. Pure given the generator. */
export function pickHoldout(ids: readonly string[], rate: number, rng: Rng): Set<string> {
  const held = new Set<string>();
  if (!(rate > 0)) return held;
  for (const id of ids) if (rng() < rate) held.add(id);
  return held;
}

/** How many contacts to consider so that about `limit` remain after a `rate` holdout. Pure. */
export function holdoutWindow(limit: number, rate: number): number {
  return rate > 0 && rate < 1 ? Math.ceil(limit / (1 - rate)) : limit;
}

/** Record held contacts, once each. Bookkeeping: returns how many rows were new and never throws. */
export async function recordHoldout(db: D1Database, contactIds: readonly string[], cohort: string, now: Date): Promise<number> {
  let added = 0;
  const at = now.toISOString();
  for (const chunk of inChunks(contactIds, { perValue: 1 })) {
    try {
      const results = await db.batch(chunk.map((id) => db.prepare("INSERT OR IGNORE INTO outreach_holdout (contact_id, cohort, held_at, created_at) VALUES (?1, ?2, ?3, ?3)").bind(id, cohort, at)));
      for (const r of results) added += r.meta.changes ?? 0;
    } catch {
      // A lost holdout row loses one control observation; the contact was still not sent.
    }
  }
  return added;
}

/** The contacts among `contactIds` held out in the last HOLDOUT_DAYS. Throws on a database error. */
export async function heldOutContacts(db: D1Database, contactIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const since = new Date(now.getTime() - HOLDOUT_DAYS * DAY_MS).toISOString();
  const held = new Set<string>();
  for (const chunk of inChunks([...new Set(contactIds)], { perValue: 1, reserved: 1 })) {
    const { results } = await db
      .prepare(`SELECT contact_id FROM outreach_holdout WHERE held_at > ?1 AND contact_id IN (${placeholders(chunk.length, 2)})`)
      .bind(since, ...chunk)
      .all<{ contact_id: string }>();
    for (const r of results) held.add(r.contact_id);
  }
  return held;
}
