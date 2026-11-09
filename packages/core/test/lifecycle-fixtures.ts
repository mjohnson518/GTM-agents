// GTM-agents: synthetic fixtures for the lifecycle, product bridge and billing tests: a clean slate,
// invented contacts on *.example domains, signed product pushes, a worker wired with the lifecycle,
// and a database wrapper that fails one chosen statement. Secrets are low-entropy on purpose.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { memoryKv, type MemoryKvNamespace } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { contactEmailFields } from "../src/data/contacts.ts";
import type { Env } from "../src/env.ts";
import { createLifecycle, type LifecycleOptions } from "../src/lifecycle/jobs.ts";
import { LIFECYCLE_FLAGS } from "../src/lifecycle/flags.ts";
import { flagReader, resetOutreachTables, silentLogger } from "../src/outreach/testing.ts";
import { createWorker } from "../src/worker.ts";
import type { RouteContext } from "../src/events/spine.ts";
import { acmeConfig } from "./fixtures.ts";

export const db = env.DB;
export const bucket = env.BUCKET;
export const config = defineConfig(acmeConfig);
export const PUSH_SECRET = "p".repeat(40);
export const READ_SECRET = "r".repeat(40);
export const BILLING_SECRET = "b".repeat(40);
export const PRICES = { free: 0, pro: 4900, team: 19900 } as const;
export const ON = { [LIFECYCLE_FLAGS.enabled]: "true", [LIFECYCLE_FLAGS.billing]: "true" };

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter}`;
}

/** Remove everything the lifecycle tests write, so counts start from zero. */
export async function resetLifecycle(): Promise<void> {
  await resetOutreachTables(db);
  await db.batch(
    ["funnel_events", "lifecycle_transitions", "events", "billing_customers", "mrr_snapshots", "feedback_items", "deal_stage_history", "ref_tokens", "audit_log", "experiments", "calendar_meetings", "calendar_events", "deal_handoffs"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
}

export interface Person {
  id: string;
  email: string;
  accountKey: string | null;
}

/** An invented contact. */
export async function person(options: { email?: string; warmth?: string; accountKey?: string | null; first?: string } = {}): Promise<Person> {
  const email = options.email ?? `${uid("ada")}@${uid("acme")}.example`;
  const fields = await contactEmailFields(email);
  if (!fields) throw new Error(`bad test address ${email}`);
  const id = uid("ct");
  const accountKey = options.accountKey === undefined ? (fields.email.split("@")[1] ?? null) : options.accountKey;
  await db
    .prepare("INSERT INTO contacts (id, first_name, email, email_sha256, mailbox_sha256, account_key, warmth) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, options.first ?? "Ada", fields.email, fields.email_sha256, fields.mailbox_sha256, accountKey, options.warmth ?? "cold")
    .run();
  return { id, email: fields.email, accountKey };
}

/** A first touch to the contact, on the ledger, optionally in an experiment arm. */
export async function firstTouch(contactId: string, sentAt: string, options: { campaignId?: string; templateId?: string; experiment?: { id: string; arm: string } } = {}): Promise<string> {
  const id = uid("os");
  await db
    .prepare(
      "INSERT INTO outreach_sends (id, contact_id, campaign_id, template_id, experiment_id, experiment_arm, sequence_step, send_path, provider, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'cold', 'test-esp', ?7)",
    )
    .bind(id, contactId, options.campaignId ?? null, options.templateId ?? null, options.experiment?.id ?? null, options.experiment?.arm ?? null, sentAt)
    .run();
  return id;
}

/** An active cold sequence row, a queued deferred send and an open draft for the contact. */
export async function coldOutreach(contactId: string): Promise<{ campaignId: string }> {
  const campaignId = uid("cmp");
  await db.batch([
    db.prepare("INSERT INTO campaigns (id, name) VALUES (?1, 'Spring')").bind(campaignId),
    db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_step, sequence_active, next_send_at) VALUES (?1, ?2, 'sent', 1, 1, '2030-01-01T00:00:00.000Z')").bind(campaignId, contactId),
    db
      .prepare("INSERT INTO deferred_sends (id, contact_id, send_path, status, recipient_email, subject, body, defer_reason, next_attempt_at) VALUES (?1, ?2, 'sequence', 'queued', 'x@acme.example', 'Following up', 'Hi', 'window', '2030-01-01T00:00:00.000Z')")
      .bind(uid("ds"), contactId),
    db.prepare("INSERT INTO drafts (id, contact_id, kind, status, recipient_email, subject, body) VALUES (?1, ?2, 'follow_up', 'pending_approval', 'x@acme.example', 'Following up', 'Hi')").bind(uid("dr"), contactId),
  ]);
  return { campaignId };
}

export async function state(contactId: string): Promise<Record<string, unknown> | null> {
  return db.prepare("SELECT * FROM contact_lifecycle WHERE contact_id = ?1").bind(contactId).first();
}

export async function dealsOf(contactId: string): Promise<Array<{ id: string; stage: string; loss_reason: string | null }>> {
  return (await db.prepare("SELECT id, stage, loss_reason FROM deals WHERE contact_id = ?1 ORDER BY created_at").bind(contactId).all<{ id: string; stage: string; loss_reason: string | null }>()).results;
}

export async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** A route context over the test bindings, with the given flags. */
export function routeContext(flags: Record<string, string> = ON, now = new Date()): RouteContext<Env> {
  return { env: env as unknown as Env, db, bucket, now, flags: flagReader(flags), log: silentLogger };
}

/** The test bindings with a fresh in-memory KV (holding `flags`) and the given secrets. */
export function testEnv(options: { flags?: Record<string, string>; kv?: MemoryKvNamespace; queue?: Queue<{ id: string }>; secrets?: Partial<Env> } = {}): Env & { KV: KVNamespace } {
  const kv = options.kv ?? memoryKv(options.flags ?? ON);
  const base = env as unknown as Env;
  return {
    ...base,
    KV: kv as unknown as KVNamespace,
    PRODUCT_WEBHOOK_SECRET: PUSH_SECRET,
    ...(options.queue ? { EVENTS_QUEUE: options.queue } : { EVENTS_QUEUE: undefined as unknown as Queue<{ id: string }> }),
    ...(options.secrets ?? {}),
  };
}

/** A worker wired with the lifecycle. */
export function lifecycleWorker(options: LifecycleOptions<Env> = {}) {
  const lifecycle = createLifecycle<Env>({ prices: PRICES, ...options });
  return { worker: createWorker<Env>(config, { lifecycle, jobs: lifecycle.jobs }), lifecycle };
}

/** Call the worker and wait for everything it scheduled after the response (inline routing). */
export async function call(worker: ReturnType<typeof createWorker<Env>>, request: Request, bindings: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const encoder = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A signed push of `event` (an object, or exact bytes). */
export async function push(event: Record<string, unknown> | string, options: { secret?: string; eventId?: string; signature?: string; url?: string } = {}): Promise<Request> {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  const id = options.eventId ?? (typeof event === "string" || typeof event.id !== "string" ? "" : event.id);
  return new Request(options.url ?? "https://agent.acme.example/api/webhooks/product", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Event-Id": id, "X-Signature": options.signature ?? `sha256=${await hmacHex(options.secret ?? PUSH_SECRET, body)}` },
    body,
  });
}

/** A product event envelope for an invented user. */
export function envelope(type: string, user: { id: string; email?: string; name?: string } | { id: string; email_sha256: string }, data: Record<string, unknown> = {}, options: { id?: string; occurredAt?: string; ref?: string | null; org?: Record<string, unknown> | null } = {}): Record<string, unknown> {
  return {
    id: options.id ?? uid("evt"),
    version: 1,
    type,
    occurred_at: options.occurredAt ?? new Date().toISOString(),
    user,
    org: options.org === undefined ? null : options.org,
    ref: options.ref ?? null,
    data,
  };
}

/**
 * A D1Database whose statements matching `pattern` throw while `fail.on` is true. Everything else
 * passes through, so a test can make exactly one side effect fail and then recover.
 */
/** The URL a fetch stub was called with. */
export const urlOf = (input: Parameters<typeof fetch>[0]): string => (input instanceof Request ? input.url : input.toString());

export function failingDb(inner: D1Database, pattern: RegExp): { db: D1Database; fail: { on: boolean } } {
  const fail = { on: true };
  const real = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const failing = () => fail.on && pattern.test(sql);
    const wrapped = {
      bind: (...args: unknown[]) => wrap(statement.bind(...args), sql),
      run: () => (failing() ? Promise.reject(new Error("injected failure")) : statement.run()),
      all: () => (failing() ? Promise.reject(new Error("injected failure")) : statement.all()),
      first: (column?: string) => (failing() ? Promise.reject(new Error("injected failure")) : column === undefined ? statement.first() : statement.first(column)),
      raw: () => (failing() ? Promise.reject(new Error("injected failure")) : statement.raw()),
    } as unknown as D1PreparedStatement;
    real.set(wrapped, { statement, sql });
    return wrapped;
  };
  const db = {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    batch: (statements: D1PreparedStatement[]) => {
      const unwrapped = statements.map((s) => real.get(s) ?? { statement: s, sql: "" });
      if (fail.on && unwrapped.some((u) => pattern.test(u.sql))) return Promise.reject(new Error("injected failure"));
      return inner.batch(unwrapped.map((u) => u.statement));
    },
    exec: (sql: string) => inner.exec(sql),
  } as unknown as D1Database;
  return { db, fail };
}
