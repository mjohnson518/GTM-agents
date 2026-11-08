// GTM-agents: tests for POST /api/webhooks/email: verification first, events claimed once, matching
// by tag, message id and address, and what each event type records.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import type { Env } from "../src/env.ts";
import type { EmailEvent, EmailProvider } from "../src/ports/email.ts";
import { createOutreachSender } from "../src/sending/boundary.ts";
import { checkSuppression } from "../src/sending/suppression.ts";
import { fakeEmailProvider, fakeEmailWebhook } from "../src/sending/testing.ts";
import { processEmailEvents } from "../src/sending/webhook.ts";
import { createWorker } from "../src/worker.ts";
import { coldItem, config, failingOn, harness, insertCampaign, insertContact, NOW, uid, WEBHOOK_SECRET, type TestContact } from "./delivery-fakes.ts";

const db = env.DB;

async function sendOne(contact: TestContact, campaignId?: string) {
  const h = harness(db);
  const [outcome] = await createOutreachSender(h.deps)([coldItem(contact, campaignId ? { campaignId } : {})]);
  if (outcome?.status !== "sent") throw new Error(`expected a send, got ${JSON.stringify(outcome)}`);
  return { ...outcome, provider: h.provider, tags: h.provider.messages()[0]?.tags ?? {} };
}

function workerWith(provider: EmailProvider | undefined, operator = recordingOperator()) {
  return { worker: createWorker(config, { email: () => provider, operator: () => operator.channel }), operator };
}

async function post(worker: ReturnType<typeof createWorker>, request: Request, bindings: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, { ...(env as unknown as Env), ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const eventsDeps = (provider: string, operator = recordingOperator()) => ({ db, kv: undefined, provider, operator: operator.channel, now: NOW });

describe("delivery events", () => {
  it("records a delivery once, however often it is delivered", async () => {
    const contact = await insertContact(db);
    const campaignId = await insertCampaign(db);
    const sent = await sendOne(contact, campaignId);
    const event: EmailEvent = { type: "delivered", providerMessageId: sent.providerMessageId, tags: sent.tags, to: contact.email, at: NOW.toISOString() };
    const domain = contact.email.split("@")[1];
    expect(await processEmailEvents(eventsDeps(sent.provider.name), [event])).toMatchObject({ processed: 1, retry: false });
    expect(await processEmailEvents(eventsDeps(sent.provider.name), [event])).toMatchObject({ processed: 0, duplicates: 1 });
    expect((await db.prepare("SELECT delivered_at FROM outreach_sends WHERE id = ?1").bind(sent.sendId).first<{ delivered_at: string }>())?.delivered_at).toBe(NOW.toISOString());
    expect((await db.prepare("SELECT sends, delivered FROM domain_delivery WHERE domain = ?1").bind(domain).first())).toEqual({ sends: 1, delivered: 1 });
  });

  it("suppresses a hard bounce, opts the contact out, records it and pages", async () => {
    const contact = await insertContact(db);
    const sent = await sendOne(contact);
    const operator = recordingOperator();
    const event: EmailEvent = { type: "bounced", providerMessageId: sent.providerMessageId, tags: sent.tags, to: contact.email, at: NOW.toISOString(), hard: true, reason: "Permanent/General" };
    expect(await processEmailEvents(eventsDeps(sent.provider.name, operator), [event])).toMatchObject({ processed: 1, retry: false });
    expect((await checkSuppression(db, [contact.email])).blocked[0]?.reason).toBe("bounce");
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string }>())?.warmth).toBe("opted_out");
    expect((await db.prepare("SELECT bounced_at FROM outreach_sends WHERE id = ?1").bind(sent.sendId).first<{ bounced_at: string }>())?.bounced_at).toBe(NOW.toISOString());
    expect((await db.prepare("SELECT hard_bounces FROM domain_delivery WHERE domain = ?1").bind(contact.email.split("@")[1]).first<{ hard_bounces: number }>())?.hard_bounces).toBe(1);
    expect((await db.prepare("SELECT metadata FROM funnel_events WHERE contact_id = ?1 AND event_type = 'outreach_bounced'").bind(contact.id).first<{ metadata: string }>())?.metadata).toContain('"hard":true');
    expect(operator.messages.some((m) => m.text.startsWith("Hard bounce"))).toBe(true);
    const [again] = await createOutreachSender(harness(db).deps)([coldItem(contact)]);
    expect(again).toMatchObject({ status: "blocked", reason: "suppressed" });
  });

  it("records a soft bounce without suppressing", async () => {
    const contact = await insertContact(db);
    const sent = await sendOne(contact);
    await processEmailEvents(eventsDeps(sent.provider.name), [{ type: "bounced", providerMessageId: sent.providerMessageId, tags: sent.tags, to: contact.email, at: NOW.toISOString(), hard: false }]);
    expect((await checkSuppression(db, [contact.email])).ok).toBe(true);
    expect((await db.prepare("SELECT metadata FROM funnel_events WHERE contact_id = ?1 AND event_type = 'outreach_bounced'").bind(contact.id).first<{ metadata: string }>())?.metadata).toContain('"hard":false');
  });

  it("suppresses a complaint even when no send matches, and pages", async () => {
    const address = `${uid("stranger")}@${uid("elsewhere")}.example`;
    const operator = recordingOperator();
    await processEmailEvents(eventsDeps(uid("esp"), operator), [{ type: "complained", providerMessageId: uid("unknown"), tags: {}, to: address, at: NOW.toISOString() }]);
    expect((await checkSuppression(db, [address])).blocked[0]?.reason).toBe("complaint");
    expect(operator.messages.some((m) => m.text.startsWith("Spam complaint"))).toBe(true);
  });

  it("matches by message id when the tags are missing, and never trusts a send id that names another message", async () => {
    const contact = await insertContact(db);
    const sent = await sendOne(contact);
    const other = await sendOne(await insertContact(db));
    await processEmailEvents(eventsDeps(sent.provider.name), [{ type: "delivered", providerMessageId: sent.providerMessageId, tags: {}, to: contact.email, at: NOW.toISOString() }]);
    expect((await db.prepare("SELECT delivered_at FROM outreach_sends WHERE id = ?1").bind(sent.sendId).first<{ delivered_at: string | null }>())?.delivered_at).toBe(NOW.toISOString());
    // A send id tag pointing at another send, with this send's message id: the tag is ignored.
    await processEmailEvents(eventsDeps(other.provider.name), [{ type: "complained", providerMessageId: other.providerMessageId, tags: { send_id: sent.sendId }, to: contact.email, at: NOW.toISOString() }]);
    expect((await db.prepare("SELECT complained_at FROM outreach_sends WHERE id = ?1").bind(sent.sendId).first<{ complained_at: string | null }>())?.complained_at).toBeNull();
    expect((await db.prepare("SELECT complained_at FROM outreach_sends WHERE id = ?1").bind(other.sendId).first<{ complained_at: string | null }>())?.complained_at).toBe(NOW.toISOString());
  });

  it("ignores opens and clicks without touching the database", async () => {
    const result = await processEmailEvents(eventsDeps(uid("esp")), [
      { type: "opened", providerMessageId: "m-1", at: NOW.toISOString() },
      { type: "clicked", providerMessageId: "m-1", at: NOW.toISOString() },
    ]);
    expect(result).toEqual({ processed: 0, duplicates: 0, ignored: 2, retry: false });
  });

  it("asks for a retry, and releases its claim, when the suppression cannot be written", async () => {
    const contact = await insertContact(db);
    const sent = await sendOne(contact);
    const event: EmailEvent = { type: "bounced", providerMessageId: sent.providerMessageId, tags: sent.tags, to: contact.email, at: NOW.toISOString(), hard: true };
    const broken = { ...eventsDeps(sent.provider.name), db: failingOn(db, /INSERT OR IGNORE INTO suppression/) };
    expect((await processEmailEvents(broken, [event])).retry).toBe(true);
    expect((await processEmailEvents(eventsDeps(sent.provider.name), [event])).processed).toBe(1);
    expect((await checkSuppression(db, [contact.email])).ok).toBe(false);
  });
});

describe("the email webhook route", () => {
  it("answers 503 until a provider is configured", async () => {
    const { worker } = workerWith(undefined);
    const response = await post(worker, await fakeEmailWebhook([], { secret: WEBHOOK_SECRET, at: new Date() }));
    expect(response.status).toBe(503);
  });

  it("verifies, then processes, and skips the bearer token", async () => {
    const contact = await insertContact(db);
    const sent = await sendOne(contact);
    const provider = fakeEmailProvider({ name: sent.provider.name, webhookSecret: WEBHOOK_SECRET });
    const { worker } = workerWith(provider);
    const request = await fakeEmailWebhook([{ type: "delivered", providerMessageId: sent.providerMessageId, tags: sent.tags, to: contact.email, at: NOW.toISOString() }], { secret: WEBHOOK_SECRET, at: new Date() });
    const response = await post(worker, request, { GATEWAY_TOKEN: "test-gateway-token-not-sent" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, processed: 1 });
  });

  it("answers 401 to a tampered or stale webhook and 503 when the provider cannot verify", async () => {
    const provider = fakeEmailProvider({ name: uid("esp"), webhookSecret: WEBHOOK_SECRET });
    const { worker } = workerWith(provider);
    const event: EmailEvent = { type: "delivered", providerMessageId: "m-1", tags: {}, to: "riley@prospect.example", at: NOW.toISOString() };
    expect((await post(worker, await fakeEmailWebhook([event], { secret: WEBHOOK_SECRET, at: new Date(), tamper: true }))).status).toBe(401);
    expect((await post(worker, await fakeEmailWebhook([event], { secret: WEBHOOK_SECRET, at: new Date(Date.now() - 10 * 60_000) }))).status).toBe(401);
    const unconfigured = workerWith(fakeEmailProvider({ name: uid("esp") })).worker;
    expect((await post(unconfigured, await fakeEmailWebhook([event], { secret: WEBHOOK_SECRET, at: new Date() }))).status).toBe(503);
  });
});
