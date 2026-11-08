// GTM-agents: the send function's gates hold for every caller: the halt and the kill switch defer,
// suppression fails closed, a message is never sent twice, no message leaves without a working
// unsubscribe link, approvals bind to content, the content lint blocks, the per-account cap is
// enforced at the boundary, and the circuit breaker opens after three provider failures.
import { recordingOperator } from "@gtm-agents/core/agents/testing";
import { defineConfig } from "@gtm-agents/core/config";
import { contactEmailFields } from "@gtm-agents/core/data";
import { draftDigest } from "@gtm-agents/core/security";
import { COLD_PAUSE_CRITICAL_KEY, DELIVERY_FLAGS, createOutreachSender, type OutreachItem, type OutreachSenderDeps } from "@gtm-agents/core/sending";
import { fakeEmailProvider } from "@gtm-agents/core/sending/testing";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, uid } from "./helpers.ts";

const db = env.DB;
const NOW = new Date("2026-11-04T17:00:00.000Z");
const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example" },
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    domain: "outreach.acme.example",
  },
});

/** A unique label that is valid in a domain name (the shared uid uses underscores). */
const label = (prefix: string) => uid(prefix).replace(/_/g, "-");

async function contact(domain = `${label("prospect")}.example`): Promise<{ id: string; email: string }> {
  const fields = await contactEmailFields(`${label("riley")}@${domain}`);
  if (!fields) throw new Error("bad address");
  const id = uid("contact");
  await db
    .prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, account_key, timezone, warmth, verification_status) VALUES (?1, ?2, ?3, ?4, ?5, 'America/New_York', 'cold', 'deliverable')")
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, domain)
    .run();
  return { id, email: fields.email };
}

const item = (c: { id: string; email: string }, extra: Partial<OutreachItem> = {}): OutreachItem => ({
  idempotencyKey: uid("key"),
  path: "cold",
  contactId: c.id,
  to: c.email,
  subject: "Flaky builds",
  body: "Hi Riley, Acme quarantines flaky tests. Worth a look?",
  ...extra,
});

function setup(kvValues: Record<string, string> = {}, overrides: Partial<OutreachSenderDeps> = {}) {
  const kv = new MemoryKv();
  kv.map.set(DELIVERY_FLAGS.enabled, "true");
  for (const [k, v] of Object.entries(kvValues)) kv.map.set(k, v);
  const provider = fakeEmailProvider({ name: uid("esp") });
  const operator = recordingOperator();
  const deps: OutreachSenderDeps = {
    db,
    kv,
    config,
    provider,
    unsubscribeSigningKey: "test-unsubscribe-signing-key-0123456789abcdef",
    baseUrl: "https://agent.acme.example",
    operator: operator.channel,
    now: () => NOW,
    options: { chunkIntervalMs: 0 },
    ...overrides,
  };
  return { send: createOutreachSender(deps), provider, kv, operator, deps };
}

/** A database whose suppression reads fail and everything else works. */
function suppressionUnreadable(): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (/FROM suppression/.test(sql)) throw new Error("D1_ERROR: suppression unavailable");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("delivery gates", () => {
  it("defers on the halt and the cold kill switch, and calls no provider", async () => {
    const c = await contact();
    for (const [key, value] of [
      ["system:halt", JSON.stringify({ reason: "incident" })],
      [COLD_PAUSE_CRITICAL_KEY, JSON.stringify({ reason: "operator hold" })],
    ] as const) {
      const s = setup({ [key]: value });
      const [outcome] = await s.send([item(c)]);
      expect(outcome?.status, key).toBe("deferred");
      expect(s.provider.batches).toHaveLength(0);
    }
    const failing = setup();
    failing.kv.failing = true;
    expect((await failing.send([item(c)]))[0]?.status).not.toBe("sent");
    expect(failing.provider.batches).toHaveLength(0);
  });

  it("blocks every recipient when suppression cannot be read", async () => {
    const c = await contact();
    const s = setup({}, { db: suppressionUnreadable() });
    const [outcome] = await s.send([item(c)]);
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(outcome?.status === "failed" && outcome.message).toMatch(/^\[SEND BLOCKED:suppressed\]/);
    expect(s.provider.batches).toHaveLength(0);
  });

  it("never sends the same idempotency key twice, even from concurrent calls", async () => {
    const c = await contact();
    const s = setup();
    const one = item(c);
    const outcomes = (await Promise.all([s.send([one]), s.send([one]), s.send([{ ...one }])])).flat();
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "duplicate")).toHaveLength(2);
    expect(s.provider.messages()).toHaveLength(1);
    expect((await s.send([one]))[0]?.status).toBe("duplicate");
    expect(s.provider.messages()).toHaveLength(1);
  });

  it("blocks every send while the unsubscribe signing key is missing", async () => {
    const c = await contact();
    const s = setup({}, { unsubscribeSigningKey: undefined });
    const [outcome] = await s.send([item(c, { path: "reply" })]);
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(outcome?.status === "failed" && outcome.message).toMatch(/^\[SEND BLOCKED:not_configured\]/);
    expect(s.provider.batches).toHaveLength(0);
  });

  it("refuses a send whose content does not match the approved digest", async () => {
    const c = await contact();
    const approved = { to: c.email, subject: "Flaky builds", body: "Hi Riley, the approved body." };
    const digest = await draftDigest(approved);
    const draftId = uid("draft");
    await db
      .prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest) VALUES (?1, ?2, 'cold_intro', ?3, ?4, ?5, 'approved', ?6)")
      .bind(draftId, c.id, approved.to, approved.subject, approved.body, digest)
      .run();
    const s = setup();
    const [outcome] = await s.send([item(c, { draftId, approvedDigest: digest, body: "Hi Riley, an injected body." })]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "approval_mismatch" });
    const [forged] = await s.send([item(c, { draftId, approvedDigest: "0".repeat(64), body: approved.body })]);
    expect(forged).toMatchObject({ status: "blocked", reason: "approval_mismatch" });
    expect(s.provider.batches).toHaveLength(0);
  });

  it("refuses a content lint block", async () => {
    const c = await contact();
    const s = setup();
    const [outcome] = await s.send([item(c, { body: "Hi [FIRST NAME], see https://bit.ly/acme-demo" })]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "content_lint" });
    expect(s.provider.batches).toHaveLength(0);
  });

  it("enforces the per-account cap inside the send function, whoever calls it", async () => {
    const domain = `${label("initech")}.example`;
    const people = await Promise.all([1, 2].map(() => contact(domain)));
    const s = setup({ [DELIVERY_FLAGS.accountWeeklyCap]: "1" });
    expect((await s.send([item(people[0] as never)]))[0]?.status).toBe("sent");
    const other = setup({ [DELIVERY_FLAGS.accountWeeklyCap]: "1" });
    expect((await other.send([item(people[1] as never, { path: "sequence" })]))[0]).toMatchObject({ status: "deferred", reason: "account_cap" });
    expect(other.provider.batches).toHaveLength(0);
  });

  it("opens the circuit breaker after three consecutive provider failures", async () => {
    const s = setup();
    s.provider.behavior = { code: "unavailable", retryable: true };
    const contacts = await Promise.all([1, 2, 3, 4].map(() => contact()));
    for (const c of contacts.slice(0, 3)) await s.send([item(c)]);
    const [fourth] = await s.send([item(contacts[3] as never)]);
    expect(fourth).toMatchObject({ status: "deferred", reason: "circuit_open" });
    expect(s.provider.batches).toHaveLength(3);
    expect(s.operator.messages.filter((m) => m.text.includes("circuit breaker"))).toHaveLength(1);
  });
});
