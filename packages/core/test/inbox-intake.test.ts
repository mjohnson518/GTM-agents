// GTM-agents: tests for inbox intake: dedup, mail from us, own mail, contact and account matching,
// body storage, and the deterministic rules (stop on reply, opt out on unsubscribe, suppress a
// bounce we sent to, hold on out of office, flag billing). Every person and address is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { readInboundBody } from "../src/inbox/body.ts";
import { processPendingInbound, recordInbound, type InboxIntakeDeps } from "../src/inbox/intake.ts";
import { inboundMessage } from "../src/inbox/testing.ts";
import { addressHash } from "../src/sending/suppression.ts";
import { NOW, config, failingOn, insertCampaign, insertContact, uid, type TestContact } from "./delivery-fakes.ts";

function deps(overrides: Partial<InboxIntakeDeps> = {}): InboxIntakeDeps & { operator: ReturnType<typeof recordingOperator>["channel"]; texts: () => string[] } {
  const operator = recordingOperator();
  return { db: env.DB, bucket: env.BUCKET, config, provider: "test-inbox", now: NOW, operator: operator.channel, texts: () => operator.texts(), ...overrides };
}

async function enroll(contact: TestContact, campaignId: string, nextSendAt = "2026-11-05T15:00:00.000Z"): Promise<void> {
  await env.DB.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_step, sequence_active, next_send_at) VALUES (?1, ?2, 'sent', 1, 1, ?3)").bind(campaignId, contact.id, nextSendAt).run();
}

async function campaignRow(campaignId: string, contactId: string) {
  return env.DB.prepare("SELECT status, sequence_active, next_send_at, sequence_pause_reason FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2").bind(campaignId, contactId).first<{ status: string; sequence_active: number; next_send_at: string | null; sequence_pause_reason: string | null }>();
}

interface Row {
  id: string;
  classification: string;
  contact_id: string | null;
  account_key: string | null;
  status: string;
  intent: string | null;
  priority: string;
  body_key: string | null;
  body_preview: string | null;
  notes: string | null;
  processed_at: string | null;
  message_id: string | null;
  headers: string | null;
  failed_recipients: string | null;
  sender_sha256: string | null;
}

async function rowFor(providerMessageId: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM inbound_emails WHERE provider = 'test-inbox' AND provider_message_id = ?1").bind(providerMessageId).first<Row>();
}

async function sentTo(contact: TestContact): Promise<void> {
  await env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, account_key, send_path, provider, provider_message_id, sent_at) VALUES (?1, ?2, ?3, 'cold', 'test-esp', ?4, '2026-11-02T15:00:00.000Z')")
    .bind(uid("send"), contact.id, contact.accountKey, uid("esp-msg"))
    .run();
}

describe("recordInbound", () => {
  it("records a reply once, matches the contact by mailbox, and stops sequences for the contact and the account", async () => {
    const contact = await insertContact(env.DB);
    const colleague = await insertContact(env.DB, { email: `${uid("jordan")}@${contact.accountKey}` });
    const campaign = await insertCampaign(env.DB);
    await enroll(contact, campaign);
    await enroll(colleague, campaign);
    const [local, domain] = contact.email.split("@");
    const message = inboundMessage({
      from: { email: `${local}+work@${domain}`, name: "Riley" },
      subject: "Re: Flaky builds",
      text: "Thanks, tell me more.",
      headers: { "message-id": "<reply-a@prospect.example>", "in-reply-to": "<first-a@acme.example>" },
    });
    const d = deps();
    const result = await recordInbound(d, [message]);
    expect(result).toMatchObject({ received: 1, recorded: 1, processed: 1, pending: 0, duplicates: 0 });
    const row = await rowFor(message.providerMessageId);
    expect(row).toMatchObject({ classification: "reply", contact_id: contact.id, account_key: contact.accountKey, status: "new", intent: null, priority: "high", message_id: "<reply-a@prospect.example>" });
    expect(row?.processed_at).toBe(NOW.toISOString());
    expect(JSON.parse(row?.headers ?? "{}")).toMatchObject({ "message-id": "<reply-a@prospect.example>", "in-reply-to": "<first-a@acme.example>" });
    expect(await readInboundBody(env.BUCKET, row?.body_key)).toBe("Thanks, tell me more.");
    for (const id of [contact.id, colleague.id]) expect(await campaignRow(campaign, id)).toMatchObject({ status: "replied", sequence_active: 0, next_send_at: null });

    const again = await recordInbound(d, [message]);
    expect(again).toMatchObject({ recorded: 0, duplicates: 1 });
  });

  it("stops the account's sequences for a new inquiry from someone it does not know there", async () => {
    const contact = await insertContact(env.DB);
    const campaign = await insertCampaign(env.DB);
    await enroll(contact, campaign);
    const message = inboundMessage({ from: { email: `${uid("someone")}@${contact.accountKey}` }, subject: "Pricing for our team", text: "What does it cost?" });
    await recordInbound(deps(), [message]);
    expect(await rowFor(message.providerMessageId)).toMatchObject({ classification: "new_inquiry", contact_id: null, account_key: contact.accountKey });
    expect(await campaignRow(campaign, contact.id)).toMatchObject({ status: "replied", sequence_active: 0 });
  });

  it("skips mail the mailbox or the deployment sent itself", async () => {
    const result = await recordInbound(deps(), [
      inboundMessage({ isFromUs: true }),
      inboundMessage({ from: { email: config.sending.replyTo } }),
      inboundMessage({ from: { email: config.sending.from.email } }),
      inboundMessage({ from: { email: `bounces@${config.sending.domain}` } }),
    ]);
    expect(result).toMatchObject({ received: 4, recorded: 0, fromUs: 4 });
  });

  it("records the company's own mail and the support address with no contact, no account, no side effects, and never as new", async () => {
    const messages = [inboundMessage({ from: { email: `${uid("teammate")}@acme.example` }, subject: "Re: lunch", text: "unsubscribe" }), inboundMessage({ from: { email: config.sending.supportAddress }, subject: "New contact form submission" })];
    const result = await recordInbound(deps(), messages);
    expect(result).toMatchObject({ recorded: 2, processed: 2 });
    for (const message of messages) {
      const row = await rowFor(message.providerMessageId);
      expect(row).toMatchObject({ status: "ignored", contact_id: null, account_key: null });
      expect(row?.notes).toContain("[own_mail]");
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM suppression WHERE source = 'inbound_unsubscribe' AND email LIKE '%@acme.example'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("skips a message whose id or sender does not parse, rather than guess", async () => {
    const result = await recordInbound(deps(), [inboundMessage({ from: { email: "not an address" } }), inboundMessage({ providerMessageId: "" }), inboundMessage({ from: { email: "a@b.example, c@d.example" } })]);
    expect(result).toMatchObject({ recorded: 0, unparseable: 3 });
  });

  it("reads a message that answers our mail as a reply even without a Re: prefix", async () => {
    const contact = await insertContact(env.DB);
    const espId = uid("esp-id");
    await env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, provider_message_id, sent_at) VALUES (?1, ?2, 'cold', 'test-esp', ?3, '2026-11-02T15:00:00.000Z')").bind(uid("send"), contact.id, espId).run();
    const rfcId = `<${uid("rfc")}@mail.esp.example>`;
    await env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, provider_message_id, message_id, sent_at) VALUES (?1, ?2, 'cold', 'test-esp', ?3, ?4, '2026-11-02T15:00:00.000Z')").bind(uid("send"), contact.id, uid("esp-id"), rfcId).run();
    const byMessageId = inboundMessage({ from: { email: contact.email }, subject: "Flaky builds", references: [rfcId] });
    await recordInbound(deps(), [byMessageId]);
    expect((await rowFor(byMessageId.providerMessageId))?.classification).toBe("reply");
    const bySend = inboundMessage({ from: { email: contact.email }, subject: "Flaky builds", inReplyTo: `<${espId}@mail.esp.example>` });
    const byDomain = inboundMessage({ from: { email: `${uid("x")}@globex.example` }, subject: "Flaky builds", references: ["<abc@outreach.acme.example>"] });
    const thread = uid("thread");
    const first = inboundMessage({ from: { email: `${uid("y")}@initech.example` }, subject: "Hello", threadId: thread });
    const second = inboundMessage({ from: { email: `${uid("z")}@initech.example` }, subject: "Following up", threadId: thread });
    await recordInbound(deps(), [bySend, byDomain, first]);
    await recordInbound(deps(), [second]);
    expect((await rowFor(bySend.providerMessageId))?.classification).toBe("reply");
    expect((await rowFor(byDomain.providerMessageId))?.classification).toBe("reply");
    expect((await rowFor(first.providerMessageId))?.classification).toBe("new_inquiry");
    expect((await rowFor(second.providerMessageId))?.classification).toBe("reply");
  });

  it("opts out an unsubscribe; if the opt-out cannot be written the row stays pending, the operator is told once, and the pending pass finishes it", async () => {
    const contact = await insertContact(env.DB);
    const campaign = await insertCampaign(env.DB);
    await enroll(contact, campaign);
    const message = inboundMessage({ from: { email: contact.email }, subject: "Re: Flaky builds", text: "Unsubscribe" });
    const broken = deps({ db: failingOn(env.DB, /INTO suppression/) });
    const result = await recordInbound(broken, [message]);
    expect(result).toMatchObject({ recorded: 1, processed: 0, pending: 1 });
    expect((await rowFor(message.providerMessageId))?.processed_at).toBeNull();
    expect(broken.texts().join("\n")).toContain("could not be recorded yet");
    expect(await env.DB.prepare("SELECT 1 AS hit FROM suppression WHERE email = ?1").bind(contact.email).first()).toBeNull();

    const later = deps({ now: new Date(NOW.getTime() + 3 * 60_000) });
    const pending = await processPendingInbound(later, { limit: 100 });
    expect(pending.processed).toBeGreaterThanOrEqual(1);
    const row = await rowFor(message.providerMessageId);
    expect(row?.processed_at).not.toBeNull();
    expect(row?.notes).toContain("[unsubscribed]");
    expect(await env.DB.prepare("SELECT reason, source FROM suppression WHERE email = ?1").bind(contact.email).first()).toEqual({ reason: "opt_out", source: "inbound_unsubscribe" });
    expect(await env.DB.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first()).toEqual({ warmth: "opted_out" });
    expect(await campaignRow(campaign, contact.id)).toMatchObject({ status: "opted_out", sequence_active: 0 });
  });

  it("suppresses a hard bounce only for an address we sent to, without opting the person out", async () => {
    const sent = await insertContact(env.DB, { warmth: "contacted" });
    await sentTo(sent);
    const campaign = await insertCampaign(env.DB);
    await enroll(sent, campaign);
    const neverSent = await insertContact(env.DB);
    const report = (address: string) => `Reporting-MTA: dns; mx.example\n\nFinal-Recipient: rfc822; ${address}\nAction: failed\nStatus: 5.1.1\n`;
    const ours = inboundMessage({ from: { email: "mailer-daemon@googlemail.example" }, subject: "Delivery Status Notification (Failure)", text: "Not delivered.", deliveryReport: report(sent.email) });
    const notOurs = inboundMessage({ from: { email: "mailer-daemon@googlemail.example" }, subject: "Delivery Status Notification (Failure)", deliveryReport: report(neverSent.email) });
    const unparsed = inboundMessage({ from: { email: "mailer-daemon@googlemail.example" }, subject: "Undelivered Mail", text: "I could not deliver your message to someone." });
    const result = await recordInbound(deps(), [ours, notOurs, unparsed]);
    expect(result).toMatchObject({ recorded: 3, processed: 3 });

    const row = await rowFor(ours.providerMessageId);
    expect(row?.classification).toBe("bounce");
    expect(row?.notes).toContain("[bounce:suppressed]");
    expect(JSON.parse(row?.failed_recipients ?? "[]")).toEqual([await addressHash(sent.email), await addressHash(sent.email)]);
    expect(row?.sender_sha256).toBe(await addressHash("mailer-daemon@googlemail.example"));
    expect(await env.DB.prepare("SELECT reason, source FROM suppression WHERE email = ?1").bind(sent.email).first()).toEqual({ reason: "bounce", source: "inbound_bounce" });
    expect(await env.DB.prepare("SELECT warmth, verification_status FROM contacts WHERE id = ?1").bind(sent.id).first()).toEqual({ warmth: "contacted", verification_status: "undeliverable" });
    expect(await campaignRow(campaign, sent.id)).toMatchObject({ status: "bounced", sequence_active: 0 });

    expect((await rowFor(notOurs.providerMessageId))?.notes).toContain("[bounce:not_ours]");
    expect(await env.DB.prepare("SELECT 1 AS hit FROM suppression WHERE email = ?1").bind(neverSent.email).first()).toBeNull();
    expect((await rowFor(unparsed.providerMessageId))?.notes).toContain("[bounce:unparsed]");
  });

  it("retries every failed recipient of a bounce whose suppression could not be written, not just the first", async () => {
    const first = await insertContact(env.DB);
    const second = await insertContact(env.DB);
    await sentTo(second);
    const message = inboundMessage({ from: { email: "mailer-daemon@googlemail.example" }, subject: "Delivery Status Notification (Failure)", headers: { "content-type": 'multipart/report; report-type=delivery-status; boundary="r"', "x-failed-recipients": `${first.email}, ${second.email}` } });
    const broken = deps({ db: failingOn(env.DB, /INTO suppression/) });
    expect(await recordInbound(broken, [message])).toMatchObject({ recorded: 1, pending: 1 });
    expect(await env.DB.prepare("SELECT 1 AS hit FROM suppression WHERE email = ?1").bind(second.email).first()).toBeNull();
    await processPendingInbound(deps({ now: new Date(NOW.getTime() + 3 * 60_000) }), { limit: 100 });
    expect((await rowFor(message.providerMessageId))?.processed_at).not.toBeNull();
    expect(await env.DB.prepare("SELECT reason FROM suppression WHERE email = ?1").bind(second.email).first()).toEqual({ reason: "bounce" });
    expect(await env.DB.prepare("SELECT 1 AS hit FROM suppression WHERE email = ?1").bind(first.email).first()).toBeNull();
  });

  it("records a message once when two intake paths both see it, matching the sender and Message-ID", async () => {
    const sender = `${uid("dana")}@prospect.example`;
    const header = `<${uid("twin")}@prospect.example>`;
    const routed = inboundMessage({ from: { email: sender }, threadId: "", headers: { "message-id": header } });
    const polled = inboundMessage({ from: { email: sender }, headers: { "message-id": header } });
    const otherSender = inboundMessage({ from: { email: `${uid("eve")}@prospect.example` }, headers: { "message-id": header } });
    expect(await recordInbound(deps({ provider: "email-cloudflare" }), [routed])).toMatchObject({ recorded: 1 });
    expect(await recordInbound(deps({ provider: "inbox-gmail" }), [polled, otherSender])).toMatchObject({ recorded: 1, duplicates: 1 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM inbound_emails WHERE message_id = ?1").bind(header).first<{ n: number }>())?.n).toBe(2);
    expect(await rowFor(polled.providerMessageId)).toBeNull();
    // The routed copy had no mailbox thread; it takes the polled copy's, so a reply can answer on it.
    expect(await env.DB.prepare("SELECT provider_thread_id FROM inbound_emails WHERE provider_message_id = ?1").bind(routed.providerMessageId).first()).toEqual({ provider_thread_id: polled.threadId });
  });

  it("believes X-Failed-Recipients only on a real delivery report, even from a mailer-daemon address", async () => {
    const mailed = await insertContact(env.DB);
    await sentTo(mailed);
    const spoofed = inboundMessage({ from: { email: "mailer-daemon@attacker.example" }, subject: "Delivery Status Notification (Failure)", headers: { "x-failed-recipients": mailed.email } });
    await recordInbound(deps(), [spoofed]);
    expect((await rowFor(spoofed.providerMessageId))?.notes).toContain("[bounce:unparsed]");
    expect(await env.DB.prepare("SELECT 1 AS hit FROM suppression WHERE email = ?1").bind(mailed.email).first()).toBeNull();
  });

  it("believes X-Failed-Recipients only on a real delivery report", async () => {
    const mailed = await insertContact(env.DB);
    await sentTo(mailed);
    const forged = inboundMessage({ from: { email: `${uid("x")}@attacker.example` }, subject: "hello", headers: { "x-failed-recipients": mailed.email } });
    await recordInbound(deps(), [forged]);
    const row = await rowFor(forged.providerMessageId);
    expect(row?.classification).toBe("bounce");
    expect(row?.notes).toContain("[bounce:unparsed]");
    expect(await env.DB.prepare("SELECT 1 AS hit FROM suppression WHERE email = ?1").bind(mailed.email).first()).toBeNull();
  });

  it("keeps a newsletter that shares a thread with an earlier one as machine mail", async () => {
    const contact = await insertContact(env.DB);
    const campaign = await insertCampaign(env.DB);
    await enroll(contact, campaign);
    const thread = uid("news-thread");
    const issue = (n: number) => inboundMessage({ from: { email: `news@${contact.accountKey}` }, subject: `Weekly digest ${n}`, threadId: thread, headers: { "list-id": "<digest.prospect.example>", precedence: "bulk" } });
    const [one, two] = [issue(1), issue(2)];
    await recordInbound(deps(), [one]);
    await recordInbound(deps(), [two]);
    expect((await rowFor(two.providerMessageId))?.classification).toBe("auto_reply");
    expect(await campaignRow(campaign, contact.id)).toMatchObject({ status: "sent", sequence_active: 1 });
  });

  it("holds an out-of-office contact's sequence until the day after they return, or for a week, without a stop", async () => {
    const dated = await insertContact(env.DB);
    const undated = await insertContact(env.DB);
    const campaign = await insertCampaign(env.DB);
    await enroll(dated, campaign);
    await enroll(undated, campaign);
    const back = inboundMessage({ from: { email: dated.email }, subject: "Automatic reply: Flaky builds", text: "I am out of the office until November 20 with limited access." });
    const vague = inboundMessage({ from: { email: undated.email }, subject: "Re: Flaky builds", text: "I am travelling.", headers: { "auto-submitted": "auto-replied" } });
    await recordInbound(deps(), [back, vague]);
    expect((await rowFor(back.providerMessageId))?.classification).toBe("out_of_office");
    expect(await campaignRow(campaign, dated.id)).toMatchObject({ status: "sent", sequence_active: 1, next_send_at: "2026-11-21T00:00:00.000Z" });
    expect((await rowFor(back.providerMessageId))?.notes).toContain("[ooo:until=2026-11-21]");
    expect(await campaignRow(campaign, undated.id)).toMatchObject({ status: "sent", sequence_active: 1, next_send_at: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() });
    expect(await env.DB.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(dated.id).first()).toEqual({ warmth: "cold" });
  });

  it("records the row without a body when blob storage fails, and says so on the row", async () => {
    const failing = { put: () => Promise.reject(new Error("R2 unavailable")), get: env.BUCKET.get.bind(env.BUCKET), delete: env.BUCKET.delete.bind(env.BUCKET) } as unknown as R2Bucket;
    const message = inboundMessage({ from: { email: `${uid("lee")}@umbrella.example` }, text: "Please send the deck." });
    const result = await recordInbound(deps({ bucket: failing }), [message]);
    expect(result).toMatchObject({ recorded: 1, processed: 1 });
    const row = await rowFor(message.providerMessageId);
    expect(row?.body_key).toBeNull();
    expect(row?.body_preview).toBe("Please send the deck.");
    expect(row?.notes).toContain("[body_not_stored]");
  });

  it("writes nothing it cannot record: the blob goes, and the failure is counted for the caller", async () => {
    const puts: string[] = [];
    const deletes: string[] = [];
    const watched = {
      put: (key: string, value: string) => {
        puts.push(key);
        return env.BUCKET.put(key, value);
      },
      get: env.BUCKET.get.bind(env.BUCKET),
      delete: (key: string) => {
        deletes.push(key);
        return env.BUCKET.delete(key);
      },
    } as unknown as R2Bucket;
    const message = inboundMessage({ from: { email: `${uid("kim")}@umbrella.example` } });
    const result = await recordInbound(deps({ db: failingOn(env.DB, /INSERT INTO inbound_emails/), bucket: watched }), [message]);
    expect(result).toMatchObject({ recorded: 0, failed: 1 });
    expect(puts).toHaveLength(1);
    expect(deletes).toEqual(puts);
    expect(await rowFor(message.providerMessageId)).toBeNull();
  });

  it("flags a billing failure for the operator, whatever its classification", async () => {
    const message = inboundMessage({ from: { email: "payments-noreply@cloud.example" }, subject: "Your payment was declined", text: "Update your payment method." });
    const d = deps();
    await recordInbound(d, [message]);
    const row = await rowFor(message.providerMessageId);
    expect(row).toMatchObject({ classification: "auto_reply", priority: "high" });
    expect(row?.notes).toContain("[billing_alert]");
    expect(d.texts().join("\n")).toContain("billing problem notice");
  });
});
