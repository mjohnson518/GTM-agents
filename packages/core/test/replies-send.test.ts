// GTM-agents: sending an approved reply: freshness checks, the send lock, the warm mailbox on the
// thread, and what a send or a refusal leaves behind. Every person, company and message is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryKvNamespace } from "../src/agents/testing.ts";
import { HALT_KEY } from "../src/security/halt.ts";
import { draftDigest, markShown } from "../src/security/approval-digest.ts";
import { sendApprovedReply, sendLockKey, SEND_LOCK_EFFECT, type ReplySenderDeps } from "../src/replies/send.ts";
import { fakeMailbox, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, type FakeMailbox, type SeededContact, type SeededInbound } from "../src/replies/testing.ts";
import { addSuppression } from "../src/sending/suppression.ts";
import { BASE_URL, SIGNING_KEY, deliveryKv } from "./delivery-fakes.ts";

const db = env.DB;
const config = replyTestConfig();
const BODY = "Hi Jane,\n\nThanks for writing back. Thursday works well for a short call.\n\nAvery";

interface Fixture {
  contact: SeededContact;
  inbound: SeededInbound;
  draftId: string;
  digest: string;
  mailbox: FakeMailbox;
  kv: MemoryKvNamespace;
  deps: ReplySenderDeps;
}

async function fixture(options: { generated?: string; body?: string; shown?: boolean; kv?: MemoryKvNamespace; email?: string } = {}): Promise<Fixture> {
  const contact = await seedReplyContact(db, { email: options.email ?? "jane@globex.example", warmth: "engaged" });
  // A Gmail-shaped provider id (no "@"), with the RFC Message-ID intake records.
  const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Can we talk Thursday?", status: "draft_created", messageId: "<cafe.123@mail.globex.example>" });
  const body = options.body ?? BODY;
  const content = { to: contact.email, subject: "Re: Flaky builds at Globex", body };
  const digest = await draftDigest(content);
  const draftId = `dr-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(
      `INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest, approved_at, action_class, notes, idempotency_key)
       VALUES (?1, ?2, 'reply', ?3, ?4, ?5, 'approved', ?6, ?7, 'reply_send', ?8, ?9)`,
    )
    .bind(draftId, contact.id, content.to, content.subject, body, digest, REPLY_TEST_NOW.toISOString(), JSON.stringify({ generated_digest: options.generated ?? digest }), `reply:${inbound.id}`)
    .run();
  await db.prepare("UPDATE inbound_emails SET draft_id = ?2 WHERE id = ?1").bind(inbound.id, draftId).run();
  const kv = options.kv ?? deliveryKv();
  if (options.shown !== false) await markShown(kv, draftId, content);
  const mailbox = fakeMailbox();
  mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt, from: { email: contact.email }, text: "Can we talk Thursday?" });
  const deps: ReplySenderDeps = { db, kv, shown: kv, config, inbox: mailbox, unsubscribeSigningKey: SIGNING_KEY, baseUrl: BASE_URL, now: () => REPLY_TEST_NOW };
  return { contact, inbound, draftId, digest, mailbox, kv, deps };
}

const statusOf = async (f: Fixture) => ({
  draft: (await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(f.draftId).first<{ status: string }>())?.status,
  inbound: (await db.prepare("SELECT status FROM inbound_emails WHERE id = ?1").bind(f.inbound.id).first<{ status: string }>())?.status,
});

beforeEach(async () => {
  await resetReplyTables(db);
});

describe("an approved reply", () => {
  it("goes out through the mailbox on its thread, reads like a normal reply, and is recorded", async () => {
    const f = await fixture();
    const result = await sendApprovedReply(f.deps, f.draftId);
    expect(result).toMatchObject({ status: "sent", evidence: "approved_unchanged" });
    expect(f.mailbox.sent).toHaveLength(1);
    const [message] = f.mailbox.sent;
    expect(message?.threadId).toBe(f.inbound.threadId);
    expect(message?.from.email).toBe(config.sending.replyTo);
    expect(message?.to.email).toBe(f.contact.email);
    expect(message?.text).toBe(BODY);
    expect(message?.text).not.toContain(config.sending.postalAddress);
    expect(message?.headers["List-Unsubscribe"]).toContain(`${BASE_URL}/u/`);
    expect(message?.headers["In-Reply-To"]).toBe("<cafe.123@mail.globex.example>");
    expect(message?.headers.References).toBe("<cafe.123@mail.globex.example>");
    expect(await statusOf(f)).toEqual({ draft: "sent", inbound: "responded" });
    expect(await db.prepare("SELECT send_path, provider FROM outreach_sends WHERE draft_id = ?1").bind(f.draftId).first()).toEqual({ send_path: "reply", provider: "fake-mailbox" });
    expect(await db.prepare("SELECT action_class, outcome FROM autonomy_events WHERE subject_id = ?1").bind(f.draftId).first()).toEqual({ action_class: "reply_send", outcome: "approved_unchanged" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deferred_sends").first()).toEqual({ n: 0 });
  });

  it("counts as approved_edited when the approved text is not what the writer produced", async () => {
    const f = await fixture({ generated: "0".repeat(64) });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "sent", evidence: "approved_edited" });
  });

  it("is sent once, however many sends race for it", async () => {
    const f = await fixture();
    const results = await Promise.all([sendApprovedReply(f.deps, f.draftId), sendApprovedReply(f.deps, f.draftId), sendApprovedReply(f.deps, f.draftId)]);
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(f.mailbox.sent).toHaveLength(1);
  });

  it("is never retried after an uncertain mailbox answer", async () => {
    const f = await fixture();
    f.mailbox.sendBehavior = "throw";
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("failed");
    f.mailbox.sendBehavior = "accept";
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "maybe_sent" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("takes over a lock left by an attempt that stopped before the mailbox was asked, and sends once", async () => {
    const f = await fixture();
    const stale = new Date(REPLY_TEST_NOW.getTime() - 20 * 60_000).toISOString();
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(sendLockKey(f.draftId, f.digest), SEND_LOCK_EFFECT, stale).run();
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("sent");
    expect(f.mailbox.sent).toHaveLength(1);
  });

  it("leaves a fresh lock alone", async () => {
    const f = await fixture();
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(sendLockKey(f.draftId, f.digest), SEND_LOCK_EFFECT, REPLY_TEST_NOW.toISOString()).run();
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "in_progress" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("never retries a reply the mailbox may have sent, however old the lock", async () => {
    const g = await fixture();
    g.mailbox.sendBehavior = "throw";
    expect((await sendApprovedReply(g.deps, g.draftId)).status).toBe("failed");
    await db.prepare("UPDATE event_effects SET created_at = ?2 WHERE event_id = ?1").bind(sendLockKey(g.draftId, g.digest), new Date(REPLY_TEST_NOW.getTime() - 60 * 60_000).toISOString()).run();
    g.mailbox.sendBehavior = "accept";
    expect(await sendApprovedReply(g.deps, g.draftId)).toMatchObject({ status: "refused", reason: "maybe_sent" });
    expect(g.mailbox.sent).toHaveLength(0);
  });

  it("is held, not queued, while the system is halted, and goes once the halt is lifted", async () => {
    const f = await fixture({ kv: deliveryKv({ [HALT_KEY]: JSON.stringify({ reason: "incident" }) }) });
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("held");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deferred_sends").first()).toEqual({ n: 0 });
    f.kv.map.delete(HALT_KEY);
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("sent");
  });

  it("is refused for a suppressed recipient", async () => {
    const f = await fixture();
    await addSuppression(db, { email: f.contact.email, reason: "opt_out", source: "test" });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "blocked" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("is held while delivery is turned off", async () => {
    const f = await fixture();
    f.kv.map.delete("delivery:enabled");
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("held");
    expect(f.mailbox.sent).toHaveLength(0);
  });
});

describe("freshness", () => {
  it("refuses when they wrote again, closing the stale draft without evidence", async () => {
    const f = await fixture();
    await seedInbound(db, env.BUCKET, { sender: f.contact.email, contactId: f.contact.id, body: "Actually, Friday is better.", receivedAt: new Date(REPLY_TEST_NOW.getTime() - 10 * 60_000).toISOString() });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "newer_message" });
    expect(f.mailbox.sent).toHaveLength(0);
    expect(await statusOf(f)).toEqual({ draft: "rejected", inbound: "archived" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_events").first()).toEqual({ n: 0 });
  });

  it("refuses when a newer human message is on the thread, but not for an automatic reply", async () => {
    const f = await fixture();
    f.mailbox.addMessage({ threadId: f.inbound.threadId, providerMessageId: "auto-1", receivedAt: new Date(REPLY_TEST_NOW.getTime() - 20 * 60_000).toISOString(), headers: { "Auto-Submitted": "auto-replied" } });
    const g = await fixture({ email: "ada@northwind.example" });
    g.mailbox.addMessage({ threadId: g.inbound.threadId, providerMessageId: "human-1", receivedAt: new Date(REPLY_TEST_NOW.getTime() - 20 * 60_000).toISOString() });
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("sent");
    expect(await sendApprovedReply(g.deps, g.draftId)).toMatchObject({ status: "refused", reason: "newer_message" });
  });

  it("refuses when the thread was already answered, and marks the message responded", async () => {
    const f = await fixture();
    f.mailbox.addMessage({ threadId: f.inbound.threadId, providerMessageId: "ours-1", receivedAt: new Date(REPLY_TEST_NOW.getTime() - 5 * 60_000).toISOString(), isFromUs: true, isDraft: false });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "already_answered" });
    expect(f.mailbox.sent).toHaveLength(0);
    expect(await statusOf(f)).toEqual({ draft: "rejected", inbound: "responded" });
  });

  it("refuses, changing nothing, when a draft or an unmarked message from the mailbox is on the thread", async () => {
    const f = await fixture();
    f.mailbox.addMessage({ threadId: f.inbound.threadId, providerMessageId: "draft-1", receivedAt: new Date(REPLY_TEST_NOW.getTime() - 5 * 60_000).toISOString(), isFromUs: true, isDraft: true });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "mailbox_draft" });
    const g = await fixture({ email: "ada@northwind.example" });
    g.mailbox.addMessage({ threadId: g.inbound.threadId, providerMessageId: "own-1", receivedAt: new Date(REPLY_TEST_NOW.getTime() - 5 * 60_000).toISOString(), isFromUs: true });
    expect(await sendApprovedReply(g.deps, g.draftId)).toMatchObject({ status: "refused", reason: "mailbox_draft" });
    expect(f.mailbox.sent).toHaveLength(0);
    expect(g.mailbox.sent).toHaveLength(0);
    expect(await statusOf(f)).toEqual({ draft: "approved", inbound: "draft_created" });
    expect(await statusOf(g)).toEqual({ draft: "approved", inbound: "draft_created" });
  });

  it("refuses when a mailbox draft exists, leaving the reply for the mailbox", async () => {
    const f = await fixture();
    await db.prepare("UPDATE inbound_emails SET provider_draft_id = 'mbd-9' WHERE id = ?1").bind(f.inbound.id).run();
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "mailbox_draft" });
    expect((await statusOf(f)).draft).toBe("approved");
  });

  it("refuses text that differs from what was shown, and returns the draft for approval", async () => {
    const f = await fixture({ shown: false });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "not_shown" });
    expect((await statusOf(f)).draft).toBe("pending_approval");
  });

  it("holds on any mailbox read error, then sends once the mailbox answers", async () => {
    const f = await fixture();
    f.mailbox.failReads = true;
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("held");
    f.mailbox.failReads = false;
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("sent");
  });

  it("holds when the mailbox cannot read threads or send", async () => {
    const f = await fixture();
    f.mailbox.capabilities.send = false;
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("held");
    f.mailbox.capabilities.send = true;
    f.mailbox.capabilities.threads = false;
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("held");
    expect(f.mailbox.sent).toHaveLength(0);
  });
});
