// GTM-agents: the event spine. Every event from outside (the product, the billing provider) takes
// the same path (docs/ARCHITECTURE.md, docs/LIFECYCLE.md):
//   1. record: the raw payload is written to blob storage first, then the events row is inserted,
//      keyed by source and the provider's event id, with insert-or-ignore. A redelivered event is a
//      duplicate: nothing is written or dispatched again;
//   2. dispatch: the row id goes to EVENTS_QUEUE, or the event is routed inline when no queue is
//      bound. A failed dispatch is repaired by the sweep, never by the sender;
//   3. route: under a lease (routing_started_at; stale after LEASE_MS, so a router that died is
//      retried), by the router registered for the event's source, and only while that router's
//      flags are on (an unreadable flag leaves the event for later). Each lease counts an attempt;
//      after MAX_ROUTE_ATTEMPTS failures the event is parked (left unrouted, never picked up again)
//      and audited. Routers claim their side effects in the effects ledger, so routing again
//      repeats nothing that finished;
//   4. sweep: every 5 minutes, unrouted events older than SWEEP_AFTER_MS are routed again. No model
//      call, ever.
// The database is the truth: blob storage holds the payload the row points to. Each row carries a
// taint level (product feedback is full taint) and, for events about one product user, that user's
// id (subject_ref), so an erasure can find and delete their payloads.
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { TaintLevel } from "../ports/types.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { readSwitch } from "../sending/flags.ts";
import { sha256Hex } from "../shared/hash.ts";
import { writeAudit } from "./audit.ts";

export const LEASE_MS = 10 * 60_000;
export const MAX_ROUTE_ATTEMPTS = 5;
export const SWEEP_AFTER_MS = 5 * 60_000;
/** Every payload the spine writes lives under this prefix; retention and erasure delete nothing else. */
export const EVENT_PAYLOAD_PREFIX = "events/";

export interface RecordInput {
  /** The source, for example "product" or "billing". Lowercase letters and dashes. */
  source: string;
  /** The provider's id for the event: the dedup key. */
  providerId: string;
  type: string;
  occurredAt: string;
  receivedAt: Date;
  /** The payload as received. */
  payload: string;
  taint: TaintLevel;
  /** The product user the event is about, so an erasure can find its payload. */
  subjectRef?: string | null;
  /** Stored with the blob (for example `late`). */
  metadata?: Record<string, string>;
}

export interface RecordResult {
  id: string;
  duplicate: boolean;
}

/** The events row id for a provider's event id. */
export const eventRowId = (source: string, providerId: string): string => `${source}:${providerId}`;

/**
 * Record an event: payload first, then the row. Throws when either cannot be written, so the caller
 * answers with an error rather than a 200 for an event it does not hold.
 */
export async function recordEvent(store: { db: D1Database; bucket: R2Bucket | undefined | null }, input: RecordInput): Promise<RecordResult> {
  if (!/^[a-z][a-z-]{0,30}$/.test(input.source)) throw new TypeError("an event source is lowercase letters and dashes");
  const id = eventRowId(input.source, input.providerId);
  const seen = await store.db.prepare("SELECT 1 AS hit FROM events WHERE id = ?1").bind(id).first();
  if (seen) return { id, duplicate: true };
  if (!store.bucket) throw new Error("the BUCKET binding is missing; events cannot be recorded");
  const key = `${EVENT_PAYLOAD_PREFIX}${input.source}/${await sha256Hex(id)}.json`;
  await store.bucket.put(key, input.payload, { httpMetadata: { contentType: "application/json" }, ...(input.metadata ? { customMetadata: input.metadata } : {}) });
  const received = input.receivedAt.toISOString();
  const result = await store.db
    .prepare(
      `INSERT OR IGNORE INTO events (id, source, type, occurred_at, received_at, subject_ref, payload_key, taint, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?5)`,
    )
    .bind(id, input.source, input.type.slice(0, 80), input.occurredAt, received, input.subjectRef ?? null, key, input.taint)
    .run();
  return { id, duplicate: (result.meta.changes ?? 0) === 0 };
}

export interface StoredEvent {
  id: string;
  source: string;
  type: string;
  occurred_at: string;
  received_at: string;
  contact_id: string | null;
  subject_ref: string | null;
  payload_key: string | null;
  taint: TaintLevel;
  routed_at: string | null;
  routing_started_at: string | null;
  route_attempts: number;
}

export interface RouteContext<E> {
  env: E;
  db: D1Database;
  bucket: R2Bucket | undefined | null;
  now: Date;
  flags: FlagReader;
  log: JobLogger;
}

export interface EventRouter<E> {
  /**
   * Every flag must read on for the event to route; unreadable counts as off, and the event waits.
   * A function decides per event (an erasure, for example, needs none).
   */
  flags: readonly string[] | ((event: StoredEvent) => readonly string[]);
  /**
   * Act on one event. Throws to have it retried; a router claims every effect it must not repeat.
   * Returns the contact it resolved to, if any, for the events row.
   */
  route(event: StoredEvent, payload: string, ctx: RouteContext<E>): Promise<{ contactId?: string | null; outcome?: string }>;
}

export type EventRouters<E> = Readonly<Record<string, EventRouter<E>>>;

export type RouteOutcome = "routed" | "already_routed" | "parked" | "leased" | "disabled" | "failed" | "missing";

/** Route one event under a lease. Never throws; a database error is reported as "failed". */
export async function routeEvent<E>(ctx: RouteContext<E>, routers: EventRouters<E>, id: string): Promise<RouteOutcome> {
  const { db, now, log } = ctx;
  let row: StoredEvent | null;
  try {
    row = await db
      .prepare("SELECT id, source, type, occurred_at, received_at, contact_id, subject_ref, payload_key, taint, routed_at, routing_started_at, route_attempts FROM events WHERE id = ?1")
      .bind(id)
      .first<StoredEvent>();
  } catch (error) {
    log.warn("an event could not be read", { id, error: sanitizeErrorMessage(error) });
    return "failed";
  }
  if (!row) return "missing";
  if (row.routed_at) return "already_routed";
  if (row.route_attempts >= MAX_ROUTE_ATTEMPTS) return "parked";
  const router = Object.hasOwn(routers, row.source) ? routers[row.source] : undefined;
  if (!router) {
    await park(db, row, "no router for this source", now);
    return "parked";
  }
  const required = typeof router.flags === "function" ? router.flags(row) : router.flags;
  for (const flag of required) if (!(await readSwitch(ctx.flags, flag))) return "disabled";

  const at = now.toISOString();
  try {
    const lease = await db
      .prepare(
        `UPDATE events SET routing_started_at = ?2, route_attempts = route_attempts + 1
          WHERE id = ?1 AND routed_at IS NULL AND route_attempts < ?3 AND (routing_started_at IS NULL OR routing_started_at < ?4)`,
      )
      .bind(id, at, MAX_ROUTE_ATTEMPTS, new Date(now.getTime() - LEASE_MS).toISOString())
      .run();
    if ((lease.meta.changes ?? 0) === 0) return "leased";
  } catch (error) {
    log.warn("an event lease could not be taken", { id, error: sanitizeErrorMessage(error) });
    return "failed";
  }
  const attempts = row.route_attempts + 1;
  try {
    const object = row.payload_key && ctx.bucket ? await ctx.bucket.get(row.payload_key) : null;
    if (!object) throw new Error("the event's payload is missing from blob storage");
    const result = await router.route(row, await object.text(), ctx);
    await db
      .prepare(
        `UPDATE events SET routed_at = ?2, routing_started_at = NULL, route_error = NULL,
           contact_id = COALESCE((SELECT id FROM contacts WHERE id = ?3), contact_id)
          WHERE id = ?1`,
      )
      .bind(id, at, result.contactId ?? null)
      .run();
    return "routed";
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    log.warn("an event could not be routed", { id, source: row.source, attempt: attempts, error: message });
    try {
      await db.prepare("UPDATE events SET routing_started_at = NULL, route_error = ?2 WHERE id = ?1 AND routed_at IS NULL").bind(id, message).run();
    } catch {
      // The lease goes stale on its own; the sweep retries after LEASE_MS.
    }
    if (attempts >= MAX_ROUTE_ATTEMPTS) {
      await park(db, row, message, now);
      return "parked";
    }
    return "failed";
  }
}

async function park(db: D1Database, row: StoredEvent, reason: string, now: Date): Promise<void> {
  try {
    await db.prepare("UPDATE events SET route_attempts = MAX(route_attempts, ?2), routing_started_at = NULL, route_error = ?3 WHERE id = ?1").bind(row.id, MAX_ROUTE_ATTEMPTS, `parked: ${reason}`.slice(0, 300)).run();
  } catch {
    // Bookkeeping: the attempt count already keeps it out of the sweep.
  }
  await writeAudit(db, { agentId: "event_spine", action: "event_parked", details: { id: row.id, source: row.source, type: row.type, reason: reason.slice(0, 200) }, now });
}

/**
 * Delete one event's payload and forget whom it was about, keeping the row (a router refusing an
 * erased person's event calls it, so nothing they sent stays in blob storage). Throws on a storage
 * or database error, so the router retries.
 */
export async function dropPayload(store: { db: D1Database; bucket: Pick<R2Bucket, "delete"> | undefined | null }, event: Pick<StoredEvent, "id" | "payload_key">): Promise<void> {
  if (event.payload_key?.startsWith(EVENT_PAYLOAD_PREFIX)) {
    if (!store.bucket) throw new Error("the BUCKET binding is missing; the payload cannot be deleted");
    await store.bucket.delete(event.payload_key);
  }
  await store.db.prepare("UPDATE events SET payload_key = NULL, subject_ref = NULL WHERE id = ?1").bind(event.id).run();
}

/** Hand an event to the queue, or route it inline when no queue is bound. Never throws. */
export async function dispatchEvent(input: { queue: Pick<Queue<{ id: string }>, "send"> | undefined | null; id: string; inline: () => Promise<unknown>; log: JobLogger; waitUntil?: (promise: Promise<unknown>) => void }): Promise<"queued" | "inline" | "deferred"> {
  if (input.queue) {
    try {
      await input.queue.send({ id: input.id });
      return "queued";
    } catch (error) {
      input.log.warn("an event could not be queued; the sweep routes it", { id: input.id, error: sanitizeErrorMessage(error) });
      return "deferred";
    }
  }
  const run = input.inline().catch((error: unknown) => input.log.warn("inline routing failed; the sweep retries it", { id: input.id, error: sanitizeErrorMessage(error) }));
  if (input.waitUntil) input.waitUntil(run);
  else await run;
  return "inline";
}

/** Route unrouted events older than SWEEP_AFTER_MS, oldest first. Returns how many routed. Throws on a database error in the read. */
export async function sweepEvents<E>(ctx: RouteContext<E>, routers: EventRouters<E>, options: { limit: number; signal?: AbortSignal }): Promise<{ seen: number; routed: number; parked: number }> {
  const { results } = await ctx.db
    .prepare(
      `SELECT id FROM events
        WHERE routed_at IS NULL AND received_at < ?1 AND route_attempts < ?2 AND (routing_started_at IS NULL OR routing_started_at < ?3)
        ORDER BY received_at LIMIT ?4`,
    )
    .bind(new Date(ctx.now.getTime() - SWEEP_AFTER_MS).toISOString(), MAX_ROUTE_ATTEMPTS, new Date(ctx.now.getTime() - LEASE_MS).toISOString(), Math.max(1, Math.floor(options.limit)))
    .all<{ id: string }>();
  let routed = 0;
  let parked = 0;
  for (const { id } of results) {
    if (options.signal?.aborted) break;
    const outcome = await routeEvent(ctx, routers, id);
    if (outcome === "routed") routed += 1;
    if (outcome === "parked") parked += 1;
  }
  return { seen: results.length, routed, parked };
}

/**
 * Delete the payloads of events routed (or parked) more than `days` ago (only keys under
 * EVENT_PAYLOAD_PREFIX), keeping the rows. An unrouted event keeps its payload so it can still be routed. Returns how many.
 * Throws on a database or storage error.
 */
export async function purgeRoutedPayloads(store: { db: D1Database; bucket: Pick<R2Bucket, "delete"> | undefined | null }, options: { now: Date; days: number; limit: number }): Promise<number> {
  if (!store.bucket) return 0;
  const { results } = await store.db
    .prepare(
      `SELECT id, payload_key FROM events
        WHERE payload_key IS NOT NULL AND ((routed_at IS NOT NULL AND routed_at < ?1) OR (routed_at IS NULL AND route_attempts >= ?3 AND received_at < ?1))
        ORDER BY received_at LIMIT ?2`,
    )
    .bind(new Date(options.now.getTime() - options.days * 86_400_000).toISOString(), Math.min(1000, Math.max(1, Math.floor(options.limit))), MAX_ROUTE_ATTEMPTS)
    .all<{ id: string; payload_key: string }>();
  const owned = results.filter((r) => r.payload_key.startsWith(EVENT_PAYLOAD_PREFIX));
  if (owned.length === 0) return 0;
  await store.bucket.delete(owned.map((r) => r.payload_key));
  await store.db.prepare("UPDATE events SET payload_key = NULL WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(owned.map((r) => r.id))).run();
  return owned.length;
}
