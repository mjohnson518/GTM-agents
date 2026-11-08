// GTM-agents: synthetic fakes for the delivery tests: contacts, drafts, a KV store with delivery
// turned on, and send-function dependencies. Every person, address and id is invented, on
// *.example domains.
import { memoryKv, recordingOperator, type MemoryKvNamespace } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { contactEmailFields } from "../src/data/contacts.ts";
import { draftDigest } from "../src/security/approval-digest.ts";
import type { OutreachSenderDeps } from "../src/sending/boundary.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { fakeEmailProvider, type FakeEmailProvider } from "../src/sending/testing.ts";
import type { OutreachItem } from "../src/sending/types.ts";
import { acmeConfig } from "./fixtures.ts";

export const SIGNING_KEY = "test-unsubscribe-signing-key-0123456789abcdef";
export const BASE_URL = "https://agent.acme.example";
export const WEBHOOK_SECRET = "test-webhook-signing-secret";
/** Wednesday 4 November 2026, 12:00 in New York (EST), inside the default Monday to Thursday 8 to 15 window. */
export const NOW = new Date("2026-11-04T17:00:00.000Z");

export const config = defineConfig(acmeConfig);

let counter = 0;
/** A unique, lowercase id fragment, so tests sharing a database never see each other's rows. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export interface TestContact {
  id: string;
  email: string;
  accountKey: string;
}

export async function insertContact(
  db: D1Database,
  options: { email?: string; warmth?: string; verification?: string | null; timezone?: string | null; location?: string | null; accountKey?: string } = {},
): Promise<TestContact> {
  const domain = options.email ? options.email.slice(options.email.indexOf("@") + 1) : `${uid("prospect")}.example`;
  const email = options.email ?? `${uid("riley")}@${domain}`;
  const fields = await contactEmailFields(email);
  if (!fields) throw new Error(`bad test address ${email}`);
  const id = uid("contact");
  const accountKey = options.accountKey ?? domain;
  await db
    .prepare(
      "INSERT INTO contacts (id, first_name, email, email_sha256, mailbox_sha256, account_key, timezone, location, warmth, verification_status) VALUES (?1, 'Riley', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, accountKey, options.timezone === undefined ? "America/New_York" : options.timezone, options.location ?? null, options.warmth ?? "cold", options.verification === undefined ? "deliverable" : options.verification)
    .run();
  return { id, email: fields.email, accountKey };
}

/** Record an inbound email from the contact, so a reply to them is a reply. */
export async function insertInbound(db: D1Database, contact: TestContact): Promise<void> {
  await db
    .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, contact_id) VALUES (?1, 'test', ?2, ?3, '2026-11-01T10:00:00.000Z', ?4)")
    .bind(uid("inbound"), uid("msg"), contact.email, contact.id)
    .run();
}

/** Give the contact a lifecycle record, so lifecycle mail to them is lifecycle mail. */
export async function insertLifecycle(db: D1Database, contact: TestContact): Promise<void> {
  await db.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'signed_up')").bind(contact.id).run();
}

export async function insertCampaign(db: D1Database): Promise<string> {
  const id = uid("campaign");
  await db.prepare("INSERT INTO campaigns (id, name, status) VALUES (?1, 'Test campaign', 'active')").bind(id).run();
  return id;
}

export async function insertDraft(db: D1Database, contact: TestContact, content: { subject: string; body: string }, options: { approved?: boolean; campaignId?: string } = {}): Promise<{ id: string; digest: string }> {
  const id = uid("draft");
  const digest = await draftDigest({ to: contact.email, subject: content.subject, body: content.body });
  await db
    .prepare("INSERT INTO drafts (id, contact_id, campaign_id, kind, recipient_email, subject, body, status, approved_digest) VALUES (?1, ?2, ?3, 'cold_intro', ?4, ?5, ?6, ?7, ?8)")
    .bind(id, contact.id, options.campaignId ?? null, contact.email, content.subject, content.body, options.approved === false ? "pending_approval" : "approved", options.approved === false ? null : digest)
    .run();
  return { id, digest };
}

/** A KV store with delivery turned on, plus any extra keys. */
export function deliveryKv(extra: Record<string, string> = {}): MemoryKvNamespace {
  return memoryKv({ [DELIVERY_FLAGS.enabled]: "true", ...extra });
}

export function coldItem(contact: TestContact, overrides: Partial<OutreachItem> = {}): OutreachItem {
  return {
    idempotencyKey: uid("2026-11-04"),
    path: "cold",
    contactId: contact.id,
    to: contact.email,
    subject: "Flaky builds at your team",
    body: "Hi Riley,\n\nAcme quarantines flaky tests so reruns stop. Worth a look?\n\nAvery",
    ...overrides,
  };
}

export interface Harness {
  deps: OutreachSenderDeps;
  provider: FakeEmailProvider;
  kv: MemoryKvNamespace;
  operator: ReturnType<typeof recordingOperator>;
}

/** Send-function dependencies over the test database, with a fresh fake provider of its own name. */
export function harness(db: D1Database, overrides: Partial<OutreachSenderDeps> & { kv?: MemoryKvNamespace } = {}): Harness {
  const provider = fakeEmailProvider({ name: uid("fake-esp"), webhookSecret: WEBHOOK_SECRET, now: () => NOW });
  const kv = overrides.kv ?? deliveryKv();
  const operator = recordingOperator();
  const deps: OutreachSenderDeps = {
    db,
    kv,
    config,
    provider,
    unsubscribeSigningKey: SIGNING_KEY,
    baseUrl: BASE_URL,
    operator: operator.channel,
    now: () => NOW,
    options: { chunkIntervalMs: 0 },
    ...overrides,
  };
  return { deps, provider, kv, operator };
}

/** A database that fails every statement whose SQL matches `pattern`, and passes the rest through. */
export function failingOn(db: D1Database, pattern: RegExp): D1Database {
  const wrapStatement = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    if (!pattern.test(sql)) return statement;
    const fail = () => Promise.reject(new Error("D1_ERROR: injected failure"));
    const failing = { bind: () => failing, run: fail, all: fail, first: fail, raw: fail, __failing: true };
    return failing;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrapStatement(sql, target.prepare(sql));
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) =>
          statements.some((s) => (s as unknown as { __failing?: boolean }).__failing) ? Promise.reject(new Error("D1_ERROR: injected failure")) : target.batch(statements);
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A database that records every SQL statement prepared on it. */
export function watchedDb(db: D1Database): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, statements };
}
