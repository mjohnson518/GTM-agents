// GTM-agents: the reply commands and the outbox: listing and settling owed replies, sending approved
// ones, and the notices each outcome leaves. Every person, company and message is invented.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import type { Env } from "../src/env.ts";
import { processChatMessage } from "../src/operator/chat.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { runReplyCommand, type ReplyCommandDeps } from "../src/replies/commands.ts";
import { runOutbox } from "../src/replies/outbox.ts";
import { fakeMailbox, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, type FakeMailbox } from "../src/replies/testing.ts";
import { draftDigest, markShown } from "../src/security/approval-digest.ts";
import { BASE_URL, SIGNING_KEY, deliveryKv } from "./delivery-fakes.ts";

const db = env.DB;
const config = replyTestConfig();
const BODY = "Hi Jane,\n\nThanks for writing back. Thursday works well for a short call.\n\nAvery";

async function reply(mailbox: FakeMailbox, options: { status?: "pending_approval" | "approved" | "rejected"; email?: string; shown?: boolean; kv?: ReturnType<typeof deliveryKv> } = {}) {
  const contact = await seedReplyContact(db, { email: options.email ?? "jane@globex.example", warmth: "engaged" });
  const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Can we talk Thursday?", status: "draft_created" });
  const content = { to: contact.email, subject: "Re: Flaky builds", body: BODY };
  const digest = await draftDigest(content);
  const status = options.status ?? "approved";
  const draftId = `dr-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest, approved_at, action_class, updated_at) VALUES (?1, ?2, 'reply', ?3, ?4, ?5, ?6, ?7, ?8, 'reply_send', ?8)")
    .bind(draftId, contact.id, content.to, content.subject, BODY, status, status === "approved" ? digest : null, REPLY_TEST_NOW.toISOString())
    .run();
  await db.prepare("UPDATE inbound_emails SET draft_id = ?2 WHERE id = ?1").bind(inbound.id, draftId).run();
  if (options.kv && options.shown !== false) await markShown(options.kv, draftId, content);
  mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt });
  return { contact, inbound, draftId };
}

let kv: ReturnType<typeof deliveryKv>;
let mailbox: FakeMailbox;
let operator: ReturnType<typeof recordingOperator>;
const commandDeps = (flags = flagReader({ "replies:send_enabled": "true", "delivery:enabled": "true" })): ReplyCommandDeps => ({
  db,
  kv,
  shown: kv,
  flags,
  config,
  operator: operator.channel,
  inbox: mailbox,
  unsubscribeSigningKey: SIGNING_KEY,
  baseUrl: BASE_URL,
  now: () => REPLY_TEST_NOW,
  log: silentLogger,
});
const command = (name: string, args = "", flags?: ReturnType<typeof flagReader>) => runReplyCommand(commandDeps(flags), { name, args }, { chatId: "chat-1", userId: "user-1" });

beforeEach(async () => {
  await resetReplyTables(db);
  kv = deliveryKv();
  mailbox = fakeMailbox();
  operator = recordingOperator();
});

describe("reply commands", () => {
  it("list what is owed, with ids and drafts", async () => {
    const { inbound, draftId } = await reply(mailbox, { status: "pending_approval" });
    await db.prepare("UPDATE inbound_emails SET intent = 'question' WHERE id = ?1").bind(inbound.id).run();
    const text = await command("replies");
    expect(text).toContain(inbound.id);
    expect(text).toContain(`draft ${draftId} (pending_approval)`);
    expect(text).not.toContain("Can we talk Thursday?");
  });

  it("mark a reply answered by hand from a unique prefix, rejecting its draft without evidence", async () => {
    const { inbound, draftId } = await reply(mailbox, { status: "pending_approval" });
    expect(await command("reply_done", inbound.id.slice(0, 8))).toMatch(/answered/);
    expect((await db.prepare("SELECT status FROM inbound_emails WHERE id = ?1").bind(inbound.id).first<{ status: string }>())?.status).toBe("responded");
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("rejected");
    await runOutbox({ ...commandDeps(), chatId: "chat-1", maxRows: 10 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_events").first()).toEqual({ n: 0 });
    expect(await command("replies")).toBe("No replies are waiting on you.");
  });

  it("mark a message as needing no answer, and refuse an id that matches nothing", async () => {
    const { inbound } = await reply(mailbox, { status: "pending_approval" });
    expect(await command("reply_ignore", inbound.id)).toMatch(/needing no answer/);
    expect((await db.prepare("SELECT status FROM inbound_emails WHERE id = ?1").bind(inbound.id).first<{ status: string }>())?.status).toBe("ignored");
    expect(await command("reply_done", "zzzzzzzz")).toMatch(/No open message/);
    expect(await command("reply_done", "ab")).toMatch(/at least 6 characters/);
  });

  it("send an approved reply only while sending is turned on", async () => {
    const { draftId } = await reply(mailbox, { kv });
    expect(await command("reply_send", draftId, flagReader({}))).toMatch(/turned off/);
    expect(mailbox.sent).toHaveLength(0);
    expect(await command("reply_send", draftId)).toMatch(/^Sent your reply to jane@globex.example/);
    expect(mailbox.sent).toHaveLength(1);
  });

  it("show a pending draft again as an approval request in this chat", async () => {
    const { inbound, draftId } = await reply(mailbox, { status: "pending_approval" });
    expect(await command("reply_draft", inbound.id)).toBe("Here it is again.");
    expect(operator.approvals[0]).toMatchObject({ approvalId: draftId, chatId: "chat-1" });
  });

  it("run once per chat message and never reach the model", async () => {
    await env.KV.put("operator:agent_enabled", "true");
    const { inbound } = await reply(mailbox, { status: "pending_approval" });
    const options = { config, operator: () => operator.channel, model: () => { throw new Error("the model must not be called"); }, inbox: () => mailbox, now: () => REPLY_TEST_NOW };
    const message = { updateId: `operator:chat-1:${crypto.randomUUID()}`, chatId: "chat-1", userId: "user-1", sessionKey: "s-1", text: `/reply_done ${inbound.id}` };
    await processChatMessage(options, env as unknown as Env, message);
    await processChatMessage(options, env as unknown as Env, message);
    expect(operator.messages.map((m) => m.text)).toEqual([expect.stringMatching(/answered/)]);
  });

  afterEach(async () => {
    await env.KV.delete("operator:agent_enabled");
  });
});

describe("the outbox", () => {
  const outbox = (flags = flagReader({ "replies:send_enabled": "true", "delivery:enabled": "true" })) => runOutbox({ ...commandDeps(flags), chatId: "chat-1", maxRows: 10 });

  it("sends approved replies and tells the operator", async () => {
    await reply(mailbox, { kv });
    const result = await outbox();
    expect(result.sent).toBe(1);
    expect(mailbox.sent).toHaveLength(1);
    expect(operator.messages[0]?.text).toMatch(/^Sent your reply to jane@globex.example/);
    expect((await outbox()).sent).toBe(0);
    expect(mailbox.sent).toHaveLength(1);
  });

  it("tells the operator once when a reply is refused, and does not try it again", async () => {
    const { inbound } = await reply(mailbox, { kv });
    await db.prepare("UPDATE inbound_emails SET provider_draft_id = 'mbd-1' WHERE id = ?1").bind(inbound.id).run();
    expect((await outbox()).refused).toBe(1);
    expect(operator.messages[0]?.text).toMatch(/send it from the mailbox/);
    await outbox();
    expect(operator.messages).toHaveLength(1);
  });

  it("holds while delivery is off, telling the operator at most once a day", async () => {
    kv.map.delete("delivery:enabled");
    await reply(mailbox, { kv });
    const off = flagReader({ "replies:send_enabled": "true" });
    expect((await outbox(off)).held).toBe(1);
    expect((await outbox(off)).held).toBe(1);
    expect(operator.messages).toHaveLength(1);
    expect(mailbox.sent).toHaveLength(0);
  });

  it("returns a reply whose shown record changed for approval, with a fresh request", async () => {
    const { draftId } = await reply(mailbox, { kv, shown: false });
    expect((await outbox()).refused).toBe(1);
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("pending_approval");
    expect(operator.approvals[0]).toMatchObject({ approvalId: draftId });
  });

  it("records a rejection made in chat as evidence, once", async () => {
    const { draftId } = await reply(mailbox, { status: "rejected" });
    expect((await outbox()).rejectedRecorded).toBe(1);
    expect((await outbox()).rejectedRecorded).toBe(0);
    expect(await db.prepare("SELECT action_class, outcome FROM autonomy_events WHERE subject_id = ?1").bind(draftId).first()).toEqual({ action_class: "reply_send", outcome: "rejected" });
  });
});
