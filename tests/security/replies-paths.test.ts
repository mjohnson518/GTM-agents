// GTM-agents: replies and cold mail never cross paths. With a warm mailbox configured, a reply goes out
// only through the mailbox, on the thread its contact wrote on, and only on its approved draft; cold
// and sequence mail goes out only through the email provider; a held reply is never queued for the
// provider's replay. Every person, company and message is invented.
import { contactEmailFields } from "@gtm-agents/core/data";
import { fakeMailbox, replyTestConfig, resetReplyTables } from "@gtm-agents/core/replies/testing";
import { draftDigest } from "@gtm-agents/core/security";
import { DELIVERY_FLAGS, createOutreachSender, type OutreachItem, type OutreachSenderDeps } from "@gtm-agents/core/sending";
import { fakeEmailProvider } from "@gtm-agents/core/sending/testing";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKv, uid } from "./helpers.ts";

const db = env.DB;
const NOW = new Date("2026-11-04T17:00:00.000Z");
const config = replyTestConfig();
const label = (prefix: string) => uid(prefix).replace(/_/g, "-");

async function contact(options: { wroteIn?: boolean; threadId?: string } = {}): Promise<{ id: string; email: string; threadId: string }> {
  const domain = `${label("prospect")}.example`;
  const fields = await contactEmailFields(`${label("riley")}@${domain}`);
  if (!fields) throw new Error("bad address");
  const id = uid("contact");
  await db
    .prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, account_key, timezone, warmth, verification_status) VALUES (?1, ?2, ?3, ?4, ?5, 'America/New_York', 'engaged', 'deliverable')")
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, domain)
    .run();
  const threadId = options.threadId ?? uid("thread");
  if (options.wroteIn !== false) {
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, provider_thread_id, sender_email, received_at, contact_id, classification) VALUES (?1, 'fake-mailbox', ?2, ?3, ?4, '2026-11-04T15:00:00.000Z', ?5, 'reply')")
      .bind(uid("in"), uid("msg"), threadId, fields.email, id)
      .run();
  }
  return { id, email: fields.email, threadId };
}

async function approvedDraft(c: { id: string; email: string }, body = "Hi Riley,\n\nThanks for writing back. Thursday works for a short call.\n\nAvery"): Promise<{ draftId: string; digest: string; subject: string; body: string }> {
  const subject = "Re: Flaky builds";
  const digest = await draftDigest({ to: c.email, subject, body });
  const draftId = uid("draft");
  await db
    .prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest) VALUES (?1, ?2, 'reply', ?3, ?4, ?5, 'approved', ?6)")
    .bind(draftId, c.id, c.email, subject, body, digest)
    .run();
  return { draftId, digest, subject, body };
}

function setup(overrides: Partial<OutreachSenderDeps> = {}) {
  const kv = new MemoryKv();
  kv.map.set(DELIVERY_FLAGS.enabled, "true");
  const provider = fakeEmailProvider({ name: uid("fake-esp") });
  const mailbox = fakeMailbox();
  const send = createOutreachSender({ db, kv, config, provider, mailbox, unsubscribeSigningKey: "k".repeat(48), baseUrl: "https://agent.acme.example", now: () => NOW, options: { chunkIntervalMs: 0 }, ...overrides });
  return { kv, provider, mailbox, send };
}

const replyItem = async (c: { id: string; email: string; threadId: string }, overrides: Partial<OutreachItem> = {}): Promise<OutreachItem> => {
  const draft = await approvedDraft(c);
  return { idempotencyKey: uid("reply"), path: "reply", contactId: c.id, to: c.email, subject: draft.subject, body: draft.body, draftId: draft.draftId, approvedDigest: draft.digest, threadId: c.threadId, ...overrides };
};

beforeEach(async () => {
  await resetReplyTables(db);
});

describe("with a warm mailbox configured", () => {
  it("sends a reply only through the mailbox, and cold and sequence mail only through the provider", async () => {
    const s = setup();
    const replier = await contact();
    const cold = await contact({ wroteIn: false });
    await db.prepare("UPDATE contacts SET warmth = 'cold' WHERE id = ?1").bind(cold.id).run();
    const outcomes = await s.send([
      await replyItem(replier),
      { idempotencyKey: uid("cold"), path: "cold", contactId: cold.id, to: cold.email, subject: "Flaky builds", body: "Hi Riley,\n\nAcme quarantines flaky tests so reruns stop. Worth a look?\n\nAvery" },
      { idempotencyKey: uid("seq"), path: "sequence", contactId: cold.id, to: cold.email, subject: "Re: Flaky builds", body: "Hi Riley,\n\nFollowing up on my note about flaky tests. Worth a look?\n\nAvery", sequenceStep: 2 },
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["sent", "sent", "sent"]);
    expect(s.mailbox.sent.map((m) => m.to.email)).toEqual([replier.email]);
    expect(s.mailbox.sent[0]?.threadId).toBe(replier.threadId);
    expect(s.provider.messages().map((m) => m.to.email)).toEqual([cold.email, cold.email]);
    expect(s.provider.messages().every((m) => m.tags.send_path !== "reply")).toBe(true);
  });

  it("refuses a reply to someone who never wrote in, instead of sending it as cold mail", async () => {
    const s = setup();
    const stranger = await contact({ wroteIn: false });
    const [outcome] = await s.send([await replyItem(stranger)]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "invalid" });
    expect(s.mailbox.sent).toHaveLength(0);
    expect(s.provider.batches).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deferred_sends").first()).toEqual({ n: 0 });
  });

  it("refuses a reply on a thread its contact never wrote on", async () => {
    const s = setup();
    const replier = await contact();
    const [outcome] = await s.send([await replyItem(replier, { threadId: "someone-elses-thread" })]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "invalid" });
    expect(s.mailbox.sent).toHaveLength(0);
  });

  it("refuses a reply that names no thread, so it never starts a new thread without a footer", async () => {
    const s = setup();
    const replier = await contact();
    const [outcome] = await s.send([await replyItem(replier, { threadId: undefined })]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "invalid" });
    expect(s.mailbox.sent).toHaveLength(0);
    expect(s.provider.messages()).toHaveLength(0);
  });

  it("refuses a reply without its approved draft", async () => {
    const s = setup();
    const replier = await contact();
    const item = await replyItem(replier);
    const { draftId: _draft, approvedDigest: _digest, ...unapproved } = item;
    const [outcome] = await s.send([unapproved]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "approval_mismatch" });
    expect(s.mailbox.sent).toHaveLength(0);
    expect(s.provider.batches).toHaveLength(0);
  });

  it("never falls back to the provider when the mailbox fails", async () => {
    const s = setup();
    s.mailbox.sendBehavior = "throw";
    const replier = await contact();
    const [outcome] = await s.send([await replyItem(replier)]);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(s.provider.batches).toHaveLength(0);
  });

  it("never queues a held reply for the provider's deferred replay", async () => {
    const s = setup();
    s.kv.map.set("system:halt", JSON.stringify({ reason: "incident" }));
    const replier = await contact();
    const [outcome] = await s.send([await replyItem(replier)]);
    expect(outcome).toMatchObject({ status: "deferred", reason: "halted" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deferred_sends WHERE contact_id = ?1").bind(replier.id).first()).toEqual({ n: 0 });
    expect(s.mailbox.sent).toHaveLength(0);
    expect(s.provider.batches).toHaveLength(0);
  });

  it("sends a reply with no email provider configured at all, and refuses cold mail", async () => {
    const s = setup({ provider: undefined });
    const replier = await contact();
    const cold = await contact({ wroteIn: false });
    const outcomes = await s.send([await replyItem(replier), { idempotencyKey: uid("cold"), path: "cold", contactId: cold.id, to: cold.email, subject: "Flaky builds", body: "Hi Riley,\n\nWorth a look at quarantining flaky tests?\n\nAvery" }]);
    expect(outcomes[0]?.status).toBe("sent");
    expect(outcomes[1]).toMatchObject({ status: "failed", retryable: true });
    expect(outcomes[1]?.status === "failed" && outcomes[1].message).toMatch(/^\[SEND BLOCKED:not_configured\].*an email provider/);
  });
});
