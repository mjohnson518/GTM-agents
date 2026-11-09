// GTM-agents: reply drafts mirrored into the mailbox, and the reconciliation of what the operator did
// with them. Every person, company and message is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { silentLogger } from "../src/outreach/testing.ts";
import { runMirror } from "../src/replies/mirror.ts";
import { fakeMailbox, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, type FakeMailbox, type SeededInbound } from "../src/replies/testing.ts";

const db = env.DB;
const BODY = "Hi Jane,\n\nThanks for the note. Happy to walk you through how quarantine works.\n\nAvery";
const daysAgo = (d: number, now = REPLY_TEST_NOW) => new Date(now.getTime() - d * 86_400_000).toISOString();

async function pending(mailbox: FakeMailbox, options: { email?: string; receivedAt?: string; threadId?: string; draftStatus?: string } = {}): Promise<{ inbound: SeededInbound; draftId: string }> {
  const contact = await seedReplyContact(db, { email: options.email ?? "jane@globex.example" });
  const inbound = await seedInbound(db, env.BUCKET, {
    sender: contact.email,
    contactId: contact.id,
    body: "How does it work?",
    status: "draft_created",
    ...(options.receivedAt ? { receivedAt: options.receivedAt } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
  const draftId = `dr-${crypto.randomUUID().slice(0, 8)}`;
  const status = options.draftStatus ?? "pending_approval";
  await db
    .prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest, action_class) VALUES (?1, ?2, 'reply', ?3, 'Re: Flaky builds', ?4, ?5, ?6, 'reply_question')")
    .bind(draftId, contact.id, contact.email, BODY, status, status === "approved" ? "a".repeat(64) : null)
    .run();
  await db.prepare("UPDATE inbound_emails SET draft_id = ?2 WHERE id = ?1").bind(inbound.id, draftId).run();
  mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt });
  return { inbound, draftId };
}

const mirror = (mailbox: FakeMailbox | undefined, now = REPLY_TEST_NOW, operator = recordingOperator()) =>
  runMirror({ db, inbox: mailbox, operator: operator.channel, now, log: silentLogger, maxRows: 20 }).then((result) => ({ result, operator }));

const row = (id: string) => db.prepare("SELECT status, provider_draft_id FROM inbound_emails WHERE id = ?1").bind(id).first<{ status: string; provider_draft_id: string | null }>();

beforeEach(async () => {
  await resetReplyTables(db);
});

describe("mirroring", () => {
  it("skips cleanly when the mailbox cannot create drafts", async () => {
    const mailbox = fakeMailbox();
    mailbox.capabilities.drafts = false;
    const { inbound } = await pending(mailbox);
    const { result } = await mirror(mailbox);
    expect(result.skipped).toMatch(/cannot create drafts/);
    expect((await row(inbound.id))?.provider_draft_id).toBeNull();
    expect((await mirror(undefined)).result.skipped).not.toBeNull();
  });

  it("puts a waiting reply draft on its thread in the mailbox, without a footer", async () => {
    const mailbox = fakeMailbox();
    const { inbound } = await pending(mailbox);
    const { result } = await mirror(mailbox);
    expect(result.created).toBe(1);
    const id = (await row(inbound.id))?.provider_draft_id ?? "";
    expect(mailbox.drafts.get(id)).toMatchObject({ threadId: inbound.threadId, to: "jane@globex.example", subject: "Re: Flaky builds", text: BODY });
    expect((await mirror(mailbox)).result.created).toBe(0);
    expect(mailbox.drafts.size).toBe(1);
  });

  it("mirrors only the newest message on a thread, under 14 days old, and never an approved draft", async () => {
    const mailbox = fakeMailbox();
    const old = await pending(mailbox, { email: "jane@globex.example", receivedAt: daysAgo(15) });
    const superseded = await pending(mailbox, { email: "ada@northwind.example", receivedAt: daysAgo(2), threadId: "shared-thread" });
    await seedInbound(db, env.BUCKET, { sender: "ada@northwind.example", body: "One more thing.", threadId: "shared-thread", receivedAt: daysAgo(1) });
    const approved = await pending(mailbox, { email: "lin@initrode.example", draftStatus: "approved" });
    await mirror(mailbox);
    for (const r of [old, superseded, approved]) expect((await row(r.inbound.id))?.provider_draft_id).toBeNull();
    expect(mailbox.drafts.size).toBe(0);
  });
});

describe("reconciliation", () => {
  it("records a reply sent as drafted as approved_unchanged, quoted history and signature aside", async () => {
    const mailbox = fakeMailbox();
    const { inbound, draftId } = await pending(mailbox);
    await mirror(mailbox);
    const mirrored = (await row(inbound.id))?.provider_draft_id ?? "";
    expect((await mirror(mailbox)).result.sent).toBe(0);
    mailbox.sendDraft(mirrored, new Date(REPLY_TEST_NOW.getTime() + 60_000).toISOString(), `${BODY}\n\nOn Wed, Jane wrote:\n> How does it work?`);
    const { result } = await mirror(mailbox, new Date(REPLY_TEST_NOW.getTime() + 15 * 60_000));
    expect(result.sent).toBe(1);
    expect((await row(inbound.id))?.status).toBe("responded");
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("sent");
    expect(await db.prepare("SELECT action_class, outcome FROM autonomy_events WHERE subject_id = ?1").bind(draftId).first()).toEqual({ action_class: "reply_question", outcome: "approved_unchanged" });
    expect(await db.prepare("SELECT summary, direction FROM outreach_log").first()).toEqual({ summary: "reply sent from the mailbox", direction: "outbound" });
  });

  it("records an edited reply as approved_edited", async () => {
    const mailbox = fakeMailbox();
    const { inbound, draftId } = await pending(mailbox);
    await mirror(mailbox);
    mailbox.sendDraft((await row(inbound.id))?.provider_draft_id ?? "", new Date(REPLY_TEST_NOW.getTime() + 60_000).toISOString(), "Hi Jane, sure. Call me tomorrow?\n\nAvery");
    await mirror(mailbox, new Date(REPLY_TEST_NOW.getTime() + 15 * 60_000));
    expect((await db.prepare("SELECT outcome FROM autonomy_events WHERE subject_id = ?1").bind(draftId).first<{ outcome: string }>())?.outcome).toBe("approved_edited");
    // Edit mining keeps the pair: what was written and what went out, signature stripped.
    expect(await db.prepare("SELECT generated_body, sent_body FROM draft_edits WHERE draft_id = ?1").bind(draftId).first()).toEqual({ generated_body: BODY.replace(/\n\nAvery$/, ""), sent_body: "Hi Jane, sure. Call me tomorrow?" });
  });

  it("alerts once when the mailbox draft is gone with nothing sent, and keeps the reply owed", async () => {
    const mailbox = fakeMailbox();
    const { inbound } = await pending(mailbox);
    await mirror(mailbox);
    mailbox.drafts.clear();
    const first = await mirror(mailbox);
    expect(first.result.waiting).toBe(1);
    expect(first.operator.messages[0]?.text).toMatch(/mailbox draft replying to jane@globex.example is gone/);
    const second = await mirror(mailbox);
    expect(second.operator.messages).toHaveLength(0);
    expect((await row(inbound.id))?.status).toBe("draft_created");
  });

  it("never takes its own draft for a send when the mailbox does not mark drafts, and counts it once the draft is gone", async () => {
    const mailbox = fakeMailbox({ marksDrafts: false });
    const { inbound, draftId } = await pending(mailbox);
    await mirror(mailbox);
    const mirrored = (await row(inbound.id))?.provider_draft_id ?? "";
    expect((await mirror(mailbox)).result.sent).toBe(0);
    expect((await row(inbound.id))?.status).toBe("draft_created");
    mailbox.sendDraft(mirrored, new Date(REPLY_TEST_NOW.getTime() + 60_000).toISOString());
    expect((await mirror(mailbox)).result.sent).toBe(1);
    expect((await db.prepare("SELECT outcome FROM autonomy_events WHERE subject_id = ?1").bind(draftId).first<{ outcome: string }>())?.outcome).toBe("approved_unchanged");
  });

  it("concludes nothing and records no evidence when the mailbox can tell neither drafts nor sends", async () => {
    const mailbox = fakeMailbox({ marksDrafts: false, canProbeDrafts: false });
    const { inbound, draftId } = await pending(mailbox);
    await mirror(mailbox);
    mailbox.sendDraft((await row(inbound.id))?.provider_draft_id ?? "", new Date(REPLY_TEST_NOW.getTime() + 60_000).toISOString());
    expect((await mirror(mailbox)).result.sent).toBe(0);
    const { result } = await mirror(mailbox, new Date(REPLY_TEST_NOW.getTime() + 8 * 86_400_000));
    expect(result.discarded).toBe(1);
    expect((await row(inbound.id))?.status).toBe("ignored");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_events WHERE subject_id = ?1").bind(draftId).first()).toEqual({ n: 0 });
  });

  it("closes a reply with nothing sent after 7 days as ignored, with rejected evidence", async () => {
    const mailbox = fakeMailbox();
    const { inbound, draftId } = await pending(mailbox);
    await mirror(mailbox);
    const { result } = await mirror(mailbox, new Date(REPLY_TEST_NOW.getTime() + 8 * 86_400_000));
    expect(result.discarded).toBe(1);
    expect((await row(inbound.id))?.status).toBe("ignored");
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("rejected");
    expect((await db.prepare("SELECT outcome FROM autonomy_events WHERE subject_id = ?1").bind(draftId).first<{ outcome: string }>())?.outcome).toBe("rejected");
  });
});
