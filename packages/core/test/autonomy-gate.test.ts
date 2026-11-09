// GTM-agents: the autonomy milestone's gate, end to end: an action class earns "act and notify" from
// evidence. A reply class starts at "draft and ask"; thirty decisions a person made on its drafts
// are recorded; the weekly review proposes level 2 with that evidence; only the operator's confirm
// from the chat applies it; then a reply that passes every rule goes out on its own and the
// operator is told after; and one hard bounce on an automatic reply takes it back at once. The
// meeting drafts' approve and reject taps feed the same evidence. Every person, company and message
// is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runAutonomyReview } from "../src/autonomy/promotion.ts";
import { autoSendReply, type ReplyAutoSendCandidate, type ReplyAutoSendDeps } from "../src/autonomy/reply-auto-send.ts";
import { readAutonomyLevel } from "../src/autonomy/store.ts";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import type { Env } from "../src/env.ts";
import { approvalPayload } from "../src/operator/approval-payload.ts";
import { handleApprovalCallback } from "../src/operator/approvals.ts";
import { processChatMessage } from "../src/operator/chat.ts";
import { silentLogger } from "../src/outreach/testing.ts";
import { recordReplyEvidence } from "../src/replies/evidence.ts";
import { inboundColumns, type InboundRow } from "../src/replies/rows.ts";
import { fakeMailbox, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact } from "../src/replies/testing.ts";
import { draftDigest, markShown } from "../src/security/approval-digest.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { optOutAddress } from "../src/sending/opt-out.ts";
import { BASE_URL, SIGNING_KEY } from "./delivery-fakes.ts";

const db = env.DB;
const NOW = REPLY_TEST_NOW;
const config = replyTestConfig();
const TEXT = "Thanks, this sounds useful. Happy to chat, can you send a link to book a call?";
const BODY = "Hi Jane,\n\nGlad it sounds useful. You can pick a time that suits you here: https://acme.example/book\n\nAvery";
const BRAIN = ["### facts (v1)", "- setup-time: text: Most teams finish setup in under an hour.; value: under an hour", "", "### competitors (v1)", "- globex-insights: name: Globex Test Insights; positioning: A dashboard."].join("\n");

async function candidate(email: string): Promise<{ candidate: ReplyAutoSendCandidate; mailbox: ReturnType<typeof fakeMailbox> }> {
  const contact = await seedReplyContact(db, { email });
  const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: TEXT, messageId: `<${crypto.randomUUID()}@mail.globex.example>` });
  const domain = email.slice(email.indexOf("@") + 1);
  await db.prepare("UPDATE inbound_emails SET headers = ?2 WHERE id = ?1").bind(inbound.id, JSON.stringify({ "authentication-results": `mx.acme-test.example; dkim=pass header.i=@${domain}` })).run();
  const draftId = `dr-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, action_class, idempotency_key) VALUES (?1, ?2, 'reply', ?3, 'Re: Flaky builds', ?4, 'pending_approval', 'reply_send', ?5)")
    .bind(draftId, contact.id, contact.email, BODY, `reply:${inbound.id}`)
    .run();
  await db.prepare("UPDATE inbound_emails SET draft_id = ?2 WHERE id = ?1").bind(inbound.id, draftId).run();
  const row = (await db.prepare(`SELECT ${inboundColumns()} FROM inbound_emails WHERE id = ?1`).bind(inbound.id).first<InboundRow>()) as InboundRow;
  const mailbox = fakeMailbox();
  mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt, from: { email: contact.email }, text: TEXT });
  return {
    mailbox,
    candidate: {
      row,
      triage: { intent: "interested", confidence: 0.94, quote: null, problem_quote: null, timing_quote: null, proposed_time: null, meeting_requested: true, asset_requested: false, model: null, at: NOW.toISOString() },
      contact: { id: contact.id, email: contact.email, first_name: "Jane", job_title: "VP Engineering", account_key: contact.accountKey, account_name: "Globex Corporation", warmth: "engaged" },
      sender: TEXT,
      qualification: null,
      draftId,
      subject: "Re: Flaky builds",
      body: BODY,
      actionClass: "reply_send",
      quality: { verdict: "pass", score: 100, findings: [] },
      assetUrls: [],
      brainText: BRAIN,
    },
  };
}

beforeEach(async () => {
  await resetReplyTables(db);
  await db.batch([db.prepare("DELETE FROM autonomy_level_changes"), db.prepare("DELETE FROM autonomy_proposals")]);
});

describe("the autonomy gate", () => {
  it("an action class earns act and notify from evidence, applied only by the operator, and loses it on an incident", async () => {
    const kv = memoryKv({ "operator:agent_enabled": "true", "inbound:auto_send_tier": "true", "replies:send_enabled": "true", "quality:model_review_enabled": "true", [DELIVERY_FLAGS.enabled]: "true" });
    const flags = { get: (key: string) => kv.get(key) };
    const operator = recordingOperator();
    const deps = (inbox: ReplyAutoSendDeps["inbox"]): ReplyAutoSendDeps => ({
      db,
      kv,
      flags,
      config,
      ...(inbox ? { inbox } : {}),
      operator: operator.channel,
      spend: { allow: () => Promise.resolve(true), recordModel: () => Promise.resolve() },
      job: "replies_triage",
      judgeBrain: () => Promise.resolve(""),
      bucket: env.BUCKET,
      trustedAuthservIds: { "fake-mailbox": ["mx.acme-test.example"] },
      unsubscribeSigningKey: SIGNING_KEY,
      baseUrl: BASE_URL,
      now: NOW,
      log: silentLogger,
      review: (sample) => Promise.resolve({ key: sample.key, pass: true, scores: { relevance: 5, clarity: 5, tone: 5, claims: 5 }, reasons: [] }),
    });

    // 1. At the default level, a reply that passes every other rule waits for a person.
    const first = await candidate("jane@globex.example");
    const before = await autoSendReply(deps(first.mailbox), first.candidate);
    expect(before.outcome).toBe("not_sent");
    expect(before.failures.map((f) => f.rule)).toEqual([1]);
    expect(first.mailbox.sent).toHaveLength(0);

    // 2. Thirty decisions a person made on reply_send drafts, through the reply evidence writer.
    for (let i = 0; i < 30; i++) await recordReplyEvidence(db, { draftId: `dr-past-${i}`, actionClass: "reply_send", outcome: "approved_unchanged", detail: "approved in chat, sent from the mailbox", now: new Date(NOW.getTime() - (i + 1) * 86_400_000) });

    // 3. The weekly review proposes level 2 and changes nothing.
    const review = await runAutonomyReview({ db, flags, config, operator: operator.channel, now: NOW, log: silentLogger });
    expect(review.proposals.map((p) => `${p.actionClass} ${p.from}->${p.to}`)).toEqual(["reply_send 1->2"]);
    expect((await readAutonomyLevel({ flags, db }, "reply_send")).level).toBe(1);
    const confirm = /autonomy-confirm-[0-9a-f]{10}-[0-9a-f]{6}/.exec(operator.messages.at(-1)?.text ?? "")?.[0] ?? "";
    expect(confirm).not.toBe("");

    // 4. A message that is not from an allowlisted operator cannot apply it; the operator's confirm does.
    const chatEnv = { DB: db, KV: kv as unknown as KVNamespace } as Env;
    const options = { config, operator: () => operator.channel, now: () => NOW };
    await processChatMessage(options, chatEnv, { updateId: "u-1", chatId: "chat-1", userId: "someone-else", sessionKey: "s", text: confirm });
    expect((await readAutonomyLevel({ flags, db }, "reply_send")).level).toBe(1);
    await processChatMessage(options, chatEnv, { updateId: "u-2", chatId: "chat-1", userId: "user-1", sessionKey: "s", text: confirm });
    expect(operator.messages.at(-1)?.text).toMatch(/reply_send is now at level 2/);
    expect((await readAutonomyLevel({ flags, db }, "reply_send")).level).toBe(2);

    // 5. Act and notify: the reply goes out on its own and the operator is told after.
    const second = await candidate("sam@initech.example");
    expect((await autoSendReply(deps(second.mailbox), second.candidate)).outcome).toBe("sent");
    expect(second.mailbox.sent).toHaveLength(1);
    expect(operator.messages.at(-1)?.text).toMatch(/^Sent automatically: a reply to sam@initech\.example \(reply_send at level 2/);
    expect(await db.prepare("SELECT outcome FROM autonomy_events WHERE subject_id = ?1").bind(second.candidate.draftId).first()).toEqual({ outcome: "auto_sent" });

    // 6. One hard bounce on that automatic reply takes the class back to level 1 at once.
    await optOutAddress(db, "sam@initech.example", { reason: "bounce", source: "provider_webhook", now: new Date(NOW.getTime() + 60_000) });
    expect((await readAutonomyLevel({ flags, db }, "reply_send")).level).toBe(1);
    const third = await candidate("kim@hooli.example");
    expect((await autoSendReply(deps(third.mailbox), third.candidate)).failures.map((f) => f.rule)).toEqual([1]);
    expect(third.mailbox.sent).toHaveLength(0);
  });
});

describe("meeting drafts' approval taps", () => {
  it("record approved_unchanged and rejected evidence for their class", async () => {
    const kv = memoryKv();
    const operator = recordingOperator();
    const content = { to: "jane@globex.example", subject: "Following up on our conversation", body: "Hi Jane,\n\nThank you for your time.\n\nBest,\nAvery" };
    for (const [id, kind, actionClass] of [
      ["dr-recap-1", "recap", "post_meeting_followup"],
      ["dr-rebook-1", "check_in", "rebook"],
    ] as const) {
      await db
        .prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status, action_class) VALUES (?1, ?2, ?3, ?4, ?5, 'pending_approval', ?6)")
        .bind(id, kind, content.to, content.subject, content.body, actionClass)
        .run();
      await markShown(kv, id, content);
    }
    const digest = await draftDigest(content);
    const deps = { db, shown: kv, operator: operator.channel, now: () => NOW };
    await handleApprovalCallback(deps, { type: "callback", chatId: "chat-1", userId: "user-1", action: "approve", payload: approvalPayload("dr-recap-1", digest), messageId: "m1", callbackId: "cb-1" });
    await handleApprovalCallback(deps, { type: "callback", chatId: "chat-1", userId: "user-1", action: "reject", payload: approvalPayload("dr-rebook-1", digest), messageId: "m2", callbackId: "cb-2" });
    const rows = (await db.prepare("SELECT action_class, outcome FROM autonomy_events ORDER BY action_class").all()).results;
    expect(rows).toEqual([
      { action_class: "post_meeting_followup", outcome: "approved_unchanged" },
      { action_class: "rebook", outcome: "rejected" },
    ]);
  });
});
