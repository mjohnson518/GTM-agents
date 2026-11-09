// GTM-agents: the only writer of contact_lifecycle and lifecycle_transitions (docs/LIFECYCLE.md).
//
// applyLifecycleEvent moves one contact by one event, and patches the fields the event carries:
//   - compare-and-set: the state is read, the next state computed (states.ts), and the write lands
//     only if the state is still what was read; a writer that loses the race reads again, up to
//     three times, then throws so the caller retries later;
//   - once per cause: every call names its cause (`eventKey`: a product event id, a billing event,
//     a booked meeting). The write claims (eventKey, "lifecycle:<contact>") in the effects ledger in
//     the same batch, so the same cause routed again never moves the state or rewrites the fields a
//     second time, even when the state has moved on since: it only retries the side effects that
//     did not finish;
//   - set once: product_user_id and the attribution (method, campaign) keep their first value, and
//     so do signup_ref and the first-time timestamps (signed_up_at, activated_at, first_paid_at,
//     churned_at). last_active_at only moves forward; usage counters merge;
//   - the transition row is written in the same batch as the state, so there is never one without
//     the other.
// Then the transition's side effects run (effects.ts), each claimed under the transition's id. They
// are bookkeeping for the state, which is the fact: a failure never rolls the state back. The result
// lists what failed, and the caller decides whether to retry (the event spine does).
import type { LifecycleState } from "../data/enums.ts";
import { LIFECYCLE_STATES } from "../data/enums.ts";
import type { ErasureSource } from "../data/erasure.ts";
import { writeAudit } from "../events/audit.ts";
import { runTransitionEffects, type LifecycleSource, type TransitionEffect, type TransitionRecord } from "./effects.ts";
import { firstTimeColumn, nextState, type LifecycleEvent } from "./states.ts";

export const ATTRIBUTION_METHODS = ["ref_token", "email", "domain", "inbound"] as const;
export type AttributionMethod = (typeof ATTRIBUTION_METHODS)[number];

/** Fields an event may set beside the state. Undefined (and null, except where noted) leaves a field alone. */
export interface LifecyclePatch {
  /** Set once. */
  product_user_id?: string;
  product_org_id?: string | null;
  plan_tier?: string | null;
  subscription_status?: string | null;
  /** Monthly recurring revenue in cents; 0 is written (a cancellation), null leaves it. */
  mrr_cents?: number | null;
  /** Set once, with attributed_campaign_id, the first time a method is recorded. */
  attribution_method?: AttributionMethod | null;
  attributed_campaign_id?: string | null;
  /** Set once. */
  signup_ref?: string | null;
  /** Moves forward only. */
  last_active_at?: string | null;
  /** Merged into the usage JSON (numbers, short strings and booleans only). */
  usage?: Record<string, number | string | boolean>;
}

export interface ApplyContext {
  /** What caused this, unique per cause: the effects-ledger key that makes the call once-only. */
  eventKey: string;
  /** When it happened. A time after `now` is taken as `now`. */
  occurredAt: string;
  source: LifecycleSource;
  patch?: LifecyclePatch;
  /** churned: the cancellation reason, as a CANCEL_REASONS value. */
  reason?: string;
  /** deleted: how the erasure runs. */
  erasure?: { source: ErasureSource; productUserId?: string; bucket?: Pick<R2Bucket, "delete"> | null };
}

export interface LifecycleDeps {
  db: D1Database;
  now: Date;
}

export type ApplyResult =
  | { applied: true; from: LifecycleState | null; to: LifecycleState | null; transitionId: string | null; effectsFailed: TransitionEffect[] }
  | { applied: false; reason: "already_applied" | "nothing_to_do"; from: LifecycleState | null; transitionId: string | null; effectsFailed: TransitionEffect[] };

const isState = (value: unknown): value is LifecycleState => typeof value === "string" && (LIFECYCLE_STATES as readonly string[]).includes(value);
const appliedEffect = (contactId: string) => `lifecycle:${contactId}`;
const MAX_ATTEMPTS = 3;

function hasPatch(patch: LifecyclePatch | undefined): boolean {
  return patch !== undefined && Object.entries(patch).some(([key, value]) => (key === "usage" ? value !== undefined && Object.keys(value as object).length > 0 : value !== undefined && value !== null) || (key === "mrr_cents" && value === 0));
}

function cleanUsage(usage: Record<string, unknown> | undefined): string | null {
  if (!usage) return null;
  const out: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 60);
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** The SET clause and its bindings, numbered from `start`. */
function patchSql(patch: LifecyclePatch, start: number): { sets: string[]; binds: unknown[] } {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const param = (value: unknown) => {
    binds.push(value);
    return `?${start + binds.length - 1}`;
  };
  if (patch.product_user_id) sets.push(`product_user_id = COALESCE(product_user_id, ${param(patch.product_user_id)})`);
  if (patch.product_org_id) sets.push(`product_org_id = ${param(patch.product_org_id)}`);
  if (patch.plan_tier) sets.push(`plan_tier = ${param(patch.plan_tier)}`);
  if (patch.subscription_status) sets.push(`subscription_status = ${param(patch.subscription_status)}`);
  if (typeof patch.mrr_cents === "number" && Number.isInteger(patch.mrr_cents) && patch.mrr_cents >= 0) sets.push(`mrr_cents = ${param(patch.mrr_cents)}`);
  if (patch.attribution_method) {
    // SET expressions read the row as it was, so both columns are written only when no method was recorded yet.
    const method = param(patch.attribution_method);
    const campaign = param(patch.attributed_campaign_id ?? null);
    sets.push(`attributed_campaign_id = CASE WHEN attribution_method IS NULL THEN ${campaign} ELSE attributed_campaign_id END`, `attribution_method = COALESCE(attribution_method, ${method})`);
  }
  if (patch.signup_ref) sets.push(`signup_ref = COALESCE(signup_ref, ${param(patch.signup_ref)})`);
  if (patch.last_active_at) {
    const at = param(patch.last_active_at);
    sets.push(`last_active_at = CASE WHEN last_active_at IS NULL OR last_active_at < ${at} THEN ${at} ELSE last_active_at END`);
  }
  const usage = cleanUsage(patch.usage);
  if (usage) sets.push(`usage = json_patch(usage, ${param(usage)})`);
  return { sets, binds };
}

async function readState(db: D1Database, contactId: string): Promise<LifecycleState | null> {
  const row = await db.prepare("SELECT state FROM contact_lifecycle WHERE contact_id = ?1").bind(contactId).first<{ state: string }>();
  return isState(row?.state) ? row.state : null;
}

async function transitionFor(db: D1Database, contactId: string, eventKey: string): Promise<TransitionRecord | null> {
  const row = await db
    .prepare("SELECT id, from_state, to_state, occurred_at FROM lifecycle_transitions WHERE contact_id = ?1 AND event_id = ?2 ORDER BY created_at LIMIT 1")
    .bind(contactId, eventKey)
    .first<{ id: string; from_state: string | null; to_state: string; occurred_at: string }>();
  if (!row || !isState(row.to_state)) return null;
  return { id: row.id, contactId, from: isState(row.from_state) ? row.from_state : null, to: row.to_state, occurredAt: row.occurred_at };
}

async function alreadyApplied(db: D1Database, contactId: string, eventKey: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS hit FROM event_effects WHERE event_id = ?1 AND effect = ?2").bind(eventKey, appliedEffect(contactId)).first();
  return row !== null;
}

/**
 * Apply `event` (or null for a patch alone) to a contact. Throws on a database error and when the
 * compare-and-set keeps losing; side-effect failures are returned, not thrown.
 */
export async function applyLifecycleEvent(deps: LifecycleDeps, contactId: string, event: LifecycleEvent | null, ctx: ApplyContext): Promise<ApplyResult> {
  const { db } = deps;
  if (typeof ctx.eventKey !== "string" || ctx.eventKey.length === 0) throw new TypeError("a lifecycle event needs an event key");
  const occurredAt = Number.isNaN(Date.parse(ctx.occurredAt)) || Date.parse(ctx.occurredAt) > deps.now.getTime() ? deps.now.toISOString() : new Date(ctx.occurredAt).toISOString();
  const effectDeps = { db, now: deps.now, source: ctx.source, ...(ctx.reason ? { reason: ctx.reason } : {}), ...(ctx.erasure ? { erasure: ctx.erasure } : {}) };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await alreadyApplied(db, contactId, ctx.eventKey)) {
      // The same cause again: nothing moves, but a transition it made finishes its side effects.
      const done = await transitionFor(db, contactId, ctx.eventKey);
      const effectsFailed = done ? await runTransitionEffects(effectDeps, done) : [];
      return { applied: false, reason: "already_applied", from: done?.from ?? null, transitionId: done?.id ?? null, effectsFailed };
    }
    const from = await readState(db, contactId);
    const to = event ? nextState(from, event) : null;
    if (to === null && !hasPatch(ctx.patch)) return { applied: false, reason: "nothing_to_do", from, transitionId: null, effectsFailed: [] };

    const now = deps.now.toISOString();
    const expected = from ?? "sighted";
    // ?1 contact, ?2 expected state, ?3 event key, ?4 claim, ?5 now, then the patch and the state.
    const base: unknown[] = [contactId, expected, ctx.eventKey, appliedEffect(contactId), now];
    const patch = patchSql(ctx.patch ?? {}, base.length + 1);
    const binds = [...base, ...patch.binds];
    const param = (value: unknown) => {
      binds.push(value);
      return `?${binds.length}`;
    };
    const sets = [...patch.sets, "updated_at = ?5"];
    if (to) {
      const at = param(occurredAt);
      sets.push(`state = ${param(to)}`, `state_changed_at = ${at}`);
      const column = firstTimeColumn(to);
      if (column) sets.push(`${column} = COALESCE(${column}, ${at})`);
    }
    const transitionId = crypto.randomUUID();
    const statements = [
      // A contact seen for the first time starts as sighted and moves by the same guarded write.
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, state_changed_at, created_at, updated_at) VALUES (?1, 'sighted', ?2, ?2, ?2) ON CONFLICT (contact_id) DO NOTHING").bind(contactId, now),
      db
        .prepare(
          `UPDATE contact_lifecycle SET ${sets.join(", ")}
            WHERE contact_id = ?1 AND state = ?2
              AND NOT EXISTS (SELECT 1 FROM event_effects WHERE event_id = ?3 AND effect = ?4)`,
        )
        .bind(...binds),
      // The claim lands only if the guarded write did; the transition only if the claim did.
      db.prepare("INSERT OR IGNORE INTO event_effects (event_id, effect, created_at) SELECT ?1, ?2, ?3 WHERE changes() > 0").bind(ctx.eventKey, appliedEffect(contactId), now),
      ...(to
        ? [
            db
              .prepare("INSERT INTO lifecycle_transitions (id, contact_id, from_state, to_state, event_id, occurred_at, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() > 0")
              .bind(transitionId, contactId, from, to, ctx.eventKey, occurredAt, now),
          ]
        : []),
    ];
    const results = await db.batch(statements);
    if ((results[1]?.meta.changes ?? 0) === 0) continue; // raced, or applied meanwhile: read again
    if (!to) return { applied: true, from, to: null, transitionId: null, effectsFailed: [] };
    const effectsFailed = await runTransitionEffects(effectDeps, { id: transitionId, contactId, from, to, occurredAt });
    if (effectsFailed.length > 0) {
      void writeAudit(db, { agentId: "lifecycle", action: "lifecycle_effects_failed", details: { contactId, from, to, effects: effectsFailed }, now: deps.now });
    }
    return { applied: true, from, to, transitionId, effectsFailed };
  }
  throw new Error("the lifecycle state kept changing while it was being written; try again");
}

/** A contact's lifecycle state, or null with no row. Throws on a database error. */
export function lifecycleState(db: D1Database, contactId: string): Promise<LifecycleState | null> {
  return readState(db, contactId);
}

/**
 * What convert calls when a meeting is booked: each contact before sign-up moves to engaged. The
 * key is the booked meeting's (calendar:<code>:<contact id>), so a rerun moves nothing twice.
 * Throws when a write failed or a side effect did not finish, so the caller's claim is released and
 * its next run retries.
 */
export async function recordMeetingBooked(deps: LifecycleDeps, meetings: ReadonlyArray<{ contactId: string; key: string; at: string }>): Promise<void> {
  const failures: string[] = [];
  for (const m of meetings) {
    try {
      const result = await applyLifecycleEvent(deps, m.contactId, { kind: "meeting_booked" }, { eventKey: m.key, occurredAt: m.at, source: "agent" });
      if (result.effectsFailed.length > 0) failures.push(m.contactId);
    } catch {
      failures.push(m.contactId);
    }
  }
  if (failures.length > 0) throw new Error(`the lifecycle could not record ${failures.length} booked ${failures.length === 1 ? "meeting" : "meetings"}`);
}
