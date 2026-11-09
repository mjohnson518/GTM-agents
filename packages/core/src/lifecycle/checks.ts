// GTM-agents: the lifecycle's time-based moves and the daily MRR snapshot. No model calls.
//
//   - stalled: a contact still signed_up (no value event yet) 72 hours after signing up;
//   - dormant: an activated or at-the-wall user idle 14 days moves to stalled, and a paying or
//     expanding customer idle 14 days moves to at_risk. Idle means no product activity
//     (last_active_at, which only product events move) and no state change in that time, so a
//     customer known only from billing is never called dormant;
//   - the MRR snapshot: one row per UTC day in mrr_snapshots, from the one MRR definition
//     (metrics/product.ts). A rerun the same day replaces that day's row.
// Each move goes through the lifecycle writer, keyed by what it was measured from, so a rerun moves
// nobody twice.
import { applyLifecycleEvent } from "./apply.ts";
import { LIFECYCLE_LIMITS } from "./flags.ts";
import { currentMrr } from "../metrics/product.ts";

export interface CheckResult {
  stalled: number;
  dormant: number;
  failed: number;
}

/** Run the stalled and dormant checks, at most `limit` contacts each. Throws on a database error in a read. */
export async function runLifecycleChecks(deps: { db: D1Database; now: Date; signal?: AbortSignal }, limit: number = LIFECYCLE_LIMITS.checkRows): Promise<CheckResult> {
  const { db, now } = deps;
  const result: CheckResult = { stalled: 0, dormant: 0, failed: 0 };
  const stalledBefore = new Date(now.getTime() - LIFECYCLE_LIMITS.stalledAfterHours * 3_600_000).toISOString();
  const { results: stalled } = await db
    .prepare(
      `SELECT l.contact_id, l.signed_up_at FROM contact_lifecycle l
        WHERE l.state = 'signed_up' AND l.signed_up_at IS NOT NULL AND l.signed_up_at < ?1
          AND NOT EXISTS (SELECT 1 FROM event_effects e WHERE e.event_id = 'check:stalled:' || l.contact_id || ':' || l.signed_up_at AND e.effect = 'lifecycle:' || l.contact_id)
        ORDER BY l.signed_up_at LIMIT ?2`,
    )
    .bind(stalledBefore, limit)
    .all<{ contact_id: string; signed_up_at: string }>();
  for (const row of stalled) {
    if (deps.signal?.aborted) return result;
    try {
      const r = await applyLifecycleEvent({ db, now }, row.contact_id, { kind: "stalled_check" }, { eventKey: `check:stalled:${row.contact_id}:${row.signed_up_at}`, occurredAt: now.toISOString(), source: "agent" });
      if (r.applied && r.to) result.stalled += 1;
    } catch {
      result.failed += 1;
    }
  }
  const idleBefore = new Date(now.getTime() - LIFECYCLE_LIMITS.dormantAfterDays * 86_400_000).toISOString();
  const { results: dormant } = await db
    .prepare(
      `SELECT l.contact_id, l.last_active_at FROM contact_lifecycle l
        WHERE l.state IN ('activated', 'at_wall', 'paying', 'expanding') AND l.last_active_at IS NOT NULL AND l.last_active_at < ?1 AND l.state_changed_at < ?1
          AND NOT EXISTS (SELECT 1 FROM event_effects e WHERE e.event_id = 'check:dormant:' || l.contact_id || ':' || l.last_active_at AND e.effect = 'lifecycle:' || l.contact_id)
        ORDER BY l.last_active_at LIMIT ?2`,
    )
    .bind(idleBefore, limit)
    .all<{ contact_id: string; last_active_at: string }>();
  for (const row of dormant) {
    if (deps.signal?.aborted) return result;
    try {
      const r = await applyLifecycleEvent({ db, now }, row.contact_id, { kind: "dormant" }, { eventKey: `check:dormant:${row.contact_id}:${row.last_active_at}`, occurredAt: now.toISOString(), source: "agent" });
      if (r.applied && r.to) result.dormant += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** Write today's MRR snapshot (UTC). Returns what it wrote. Throws on a database error. */
export async function snapshotMrr(db: D1Database, now: Date): Promise<{ date: string; mrrCents: number; paying: number }> {
  const mrr = await currentMrr(db);
  const date = now.toISOString().slice(0, 10);
  await db
    .prepare("INSERT INTO mrr_snapshots (date, mrr_cents, paying, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (date) DO UPDATE SET mrr_cents = excluded.mrr_cents, paying = excluded.paying")
    .bind(date, mrr.mrrCents, mrr.paying, now.toISOString())
    .run();
  return { date, mrrCents: mrr.mrrCents, paying: mrr.paying };
}
