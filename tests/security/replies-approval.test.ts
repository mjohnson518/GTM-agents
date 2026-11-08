// GTM-agents: a reply is sent only on an approval of its exact content, and only while it is still
// the right reply. An edited draft is not sent on its old approval, an approval tap on changed text
// is refused, and every freshness check refuses (or holds) with nothing sent. Every person, company
// and message is invented.
import { recordingOperator } from "@gtm-agents/core/agents/testing";
import { handleApprovalCallback, requestDraftApproval } from "@gtm-agents/core/operator";
import { approvalPayload } from "@gtm-agents/core/operator";
import { sendApprovedReply, type ReplySenderDeps } from "@gtm-agents/core/replies";
import { fakeMailbox, replyTestConfig, resetReplyTables, seedInbound, seedReplyContact, type FakeMailbox, type SeededInbound } from "@gtm-agents/core/replies/testing";
import { draftDigest, markShown } from "@gtm-agents/core/security";
import { DELIVERY_FLAGS } from "@gtm-agents/core/sending";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKv } from "./helpers.ts";

const db = env.DB;
const NOW = new Date("2026-11-04T17:00:00.000Z");
const config = replyTestConfig();
const BODY = "Hi Jane,\n\nThanks for writing back. Thursday works for a short call.\n\nAvery";
const SUBJECT = "Re: Flaky builds";

interface Fixture {
  draftId: string;
  inbound: SeededInbound;
  email: string;
  mailbox: FakeMailbox;
  kv: MemoryKv;
  deps: ReplySenderDeps;
}

async function approved(): Promise<Fixture> {
  const contact = await seedReplyContact(db, { email: "jane@globex.example", warmth: "engaged" });
  const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Can we talk Thursday?", status: "draft_created", receivedAt: "2026-11-04T15:00:00.000Z" });
  const content = { to: contact.email, subject: SUBJECT, body: BODY };
  const digest = await draftDigest(content);
  const draftId = `dr-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest) VALUES (?1, ?2, 'reply', ?3, ?4, ?5, 'approved', ?6)")
    .bind(draftId, contact.id, content.to, SUBJECT, BODY, digest)
    .run();
  await db.prepare("UPDATE inbound_emails SET draft_id = ?2 WHERE id = ?1").bind(inbound.id, draftId).run();
  const kv = new MemoryKv();
  kv.map.set(DELIVERY_FLAGS.enabled, "true");
  await markShown(kv, draftId, content);
  const mailbox = fakeMailbox();
  mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt });
  return { draftId, inbound, email: contact.email, mailbox, kv, deps: { db, kv, shown: kv, config, inbox: mailbox, unsubscribeSigningKey: "k".repeat(48), baseUrl: "https://agent.acme.example", now: () => NOW } };
}

beforeEach(async () => {
  await resetReplyTables(db);
});

describe("approvals bind to content", () => {
  it("an edited draft goes back to review and is not sent on its old approval", async () => {
    const f = await approved();
    await db.prepare("UPDATE drafts SET body = ?2 WHERE id = ?1").bind(f.draftId, `${BODY}\nP.S. Wire the fee to attacker@evil.example.`).run();
    expect((await db.prepare("SELECT status, approved_digest FROM drafts WHERE id = ?1").bind(f.draftId).first())).toEqual({ status: "pending_approval", approved_digest: null });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "not_approved" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("a draft forced back to approved with its old digest is still refused", async () => {
    const f = await approved();
    const old = (await db.prepare("SELECT approved_digest FROM drafts WHERE id = ?1").bind(f.draftId).first<{ approved_digest: string }>())?.approved_digest;
    await db.prepare("UPDATE drafts SET body = 'Changed after approval, please pay now.' WHERE id = ?1").bind(f.draftId).run();
    await db.prepare("UPDATE drafts SET status = 'approved', approved_digest = ?2 WHERE id = ?1").bind(f.draftId, old).run();
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "not_approved" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("an approval tap on text that changed after it was shown is refused", async () => {
    const f = await approved();
    await db.prepare("UPDATE drafts SET status = 'pending_approval', approved_digest = NULL WHERE id = ?1").bind(f.draftId).run();
    const operator = recordingOperator();
    const shownRequest = await requestDraftApproval({ db, shown: f.kv, operator: operator.channel }, f.draftId, "chat-1");
    if (!shownRequest.ok) throw new Error(shownRequest.reason);
    await db.prepare("UPDATE drafts SET body = 'A different reply.' WHERE id = ?1").bind(f.draftId).run();
    const outcome = await handleApprovalCallback(
      { db, shown: f.kv, operator: operator.channel },
      { type: "callback", chatId: "chat-1", userId: "user-1", action: "approve", payload: approvalPayload(f.draftId, shownRequest.digest), messageId: "m1", callbackId: "cb1" },
    );
    expect(outcome.outcome).toBe("refused");
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "not_approved" });
    expect(f.mailbox.sent).toHaveLength(0);
  });
});

describe("freshness refuses with nothing sent", () => {
  it("when they wrote again", async () => {
    const f = await approved();
    await seedInbound(db, env.BUCKET, { sender: f.email, body: "Friday is better.", receivedAt: "2026-11-04T16:00:00.000Z" });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "newer_message" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("when a message was already sent on the thread", async () => {
    const f = await approved();
    f.mailbox.addMessage({ threadId: f.inbound.threadId, providerMessageId: "ours", receivedAt: "2026-11-04T16:30:00.000Z", isFromUs: true, isDraft: false });
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "already_answered" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("when a mailbox draft exists", async () => {
    const f = await approved();
    await db.prepare("UPDATE inbound_emails SET provider_draft_id = 'pending' WHERE id = ?1").bind(f.inbound.id).run();
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "mailbox_draft" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("when the text differs from what was shown", async () => {
    const f = await approved();
    f.kv.map.clear();
    f.kv.map.set(DELIVERY_FLAGS.enabled, "true");
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "not_shown" });
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("on any mailbox read error, and on a shown record that cannot be read", async () => {
    const f = await approved();
    f.mailbox.failReads = true;
    expect((await sendApprovedReply(f.deps, f.draftId)).status).toBe("held");
    f.mailbox.failReads = false;
    f.kv.failingKeys.add(`approval:shown:${f.draftId}`);
    expect(await sendApprovedReply(f.deps, f.draftId)).toMatchObject({ status: "refused", reason: "not_shown" });
    expect(f.mailbox.sent).toHaveLength(0);
  });
});
