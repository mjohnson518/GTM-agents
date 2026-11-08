// GTM-agents: routing after triage: each intent's side effects, claimed so a re-run never repeats
// them; the opt-out retried when it fails; the send ledger credited from the reply's own timestamp.
// Every person, company and message is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { eraseContact } from "../src/data/erasure.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { runReplyPipeline, type PipelineDeps } from "../src/replies/pipeline.ts";
import { routeReply } from "../src/replies/route.ts";
import { inboundColumns, loadContact, parseStoredTriage, type InboundRow } from "../src/replies/rows.ts";
import { fakeMailbox, replyModel, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, triageAnswer, writerAnswer } from "../src/replies/testing.ts";
import { addSuppression } from "../src/sending/suppression.ts";
import { recordingOperator } from "../src/agents/testing.ts";
import { failingOn } from "./delivery-fakes.ts";

const db = env.DB;
const config = replyTestConfig();
const triageOnly = flagReader({ "replies:triage_enabled": "true" });
const withDrafting = flagReader({ "replies:triage_enabled": "true", "replies:drafting_enabled": "true" });

async function triage(answer: string, deps: Partial<PipelineDeps> = {}) {
  const model = replyModel({ triage: answer, writer: writerAnswer("Hi Jane,\n\nThanks for the note. Happy to help with that, and glad it is useful.\n\nAvery") });
  const result = await runReplyPipeline({ db, kv: env.KV, bucket: env.BUCKET, flags: triageOnly, config, model, job: "replies_triage", now: REPLY_TEST_NOW, log: silentLogger, maxRows: 10, ...deps });
  return { model, result };
}

const one = <T>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();

async function deal(contactId: string, accountKey: string, stage: string): Promise<string> {
  const id = `deal-${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare("INSERT INTO deals (id, account_key, contact_id, name, stage) VALUES (?1, ?2, ?3, 'Globex pilot', ?4)").bind(id, accountKey, contactId, stage).run();
  return id;
}

beforeEach(async () => {
  await resetReplyTables(db);
});

describe("opt-outs", () => {
  it("suppress the sender, opt the contact out, close the deal lost, archive the message and draft nothing", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const dealId = await deal(contact.id, contact.accountKey, "engaged");
    const inbound = await seedInbound(db, env.BUCKET, { sender: "Jane@Globex.example", contactId: contact.id, body: "Please take me off your list." });
    const { model } = await triage(triageAnswer({ intent: "opt_out", confidence: 0.95 }), { flags: withDrafting });
    expect(await one<{ reason: string }>("SELECT reason FROM suppression WHERE email = ?1", "jane@globex.example")).toMatchObject({ reason: "opt_out" });
    expect((await one<{ warmth: string }>("SELECT warmth FROM contacts WHERE id = ?1", contact.id))?.warmth).toBe("opted_out");
    expect(await one("SELECT stage, loss_reason FROM deals WHERE id = ?1", dealId)).toEqual({ stage: "closed_lost", loss_reason: "other" });
    expect((await one<{ status: string }>("SELECT status FROM inbound_emails WHERE id = ?1", inbound.id))?.status).toBe("archived");
    expect(model.byRole("writer")).toHaveLength(0);
  });

  it("are retried when the suppression cannot be written, without repeating the effects that held", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const dealId = await deal(contact.id, contact.accountKey, "engaged");
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Unsubscribe me." });
    await triage(triageAnswer({ intent: "opt_out", confidence: 0.9 }), { db: failingOn(db, /INSERT[\s\S]*INTO suppression/) });
    expect(await one("SELECT COUNT(*) AS n FROM suppression")).toEqual({ n: 0 });
    expect(await one("SELECT COUNT(*) AS n FROM event_effects WHERE event_id = ?1 AND effect = 'routed'", `reply:${inbound.id}`)).toEqual({ n: 0 });
    expect((await one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?1", dealId))?.stage).toBe("closed_lost");
    const { model } = await triage(triageAnswer({ intent: "opt_out", confidence: 0.9 }));
    expect(model.requests).toHaveLength(0);
    expect(await one("SELECT COUNT(*) AS n FROM suppression WHERE email = ?1", contact.email)).toEqual({ n: 1 });
    expect(await one("SELECT COUNT(*) AS n FROM event_effects WHERE event_id = ?1 AND effect = 'routed'", `reply:${inbound.id}`)).toEqual({ n: 1 });
    expect(await one("SELECT COUNT(*) AS n FROM deal_stage_history WHERE deal_id = ?1", dealId)).toEqual({ n: 1 });
  });

  it("are honored from the sender's wording when triage reads the message as a decline, and get no draft", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Not a fit. Please stop emailing me." });
    const { model } = await triage(triageAnswer({ intent: "not_a_fit", confidence: 0.9 }), { flags: withDrafting });
    expect(await one("SELECT COUNT(*) AS n FROM suppression WHERE email = ?1", contact.email)).toEqual({ n: 1 });
    expect((await one<{ status: string }>("SELECT status FROM inbound_emails WHERE id = ?1", inbound.id))?.status).toBe("archived");
    expect(model.byRole("writer")).toHaveLength(0);
  });

  it("are retried however old the message, and the operator is told once", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Remove me.", receivedAt: "2026-10-26T10:00:00.000Z" });
    const operator = recordingOperator();
    await triage(triageAnswer({ intent: "opt_out", confidence: 0.95 }), { db: failingOn(db, /INSERT[\s\S]*INTO suppression/), operator: operator.channel });
    await triage(triageAnswer({ intent: "opt_out", confidence: 0.95 }), { db: failingOn(db, /INSERT[\s\S]*INTO suppression/), operator: operator.channel, now: new Date(REPLY_TEST_NOW.getTime() + 5 * 86_400_000) });
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain(inbound.id);
    await triage(triageAnswer({ intent: "opt_out", confidence: 0.95 }), { now: new Date(REPLY_TEST_NOW.getTime() + 6 * 86_400_000) });
    expect(await one("SELECT COUNT(*) AS n FROM suppression WHERE email = ?1", contact.email)).toEqual({ n: 1 });
  });

  it("below 0.8 suppress nothing", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Maybe stop for now?" });
    await triage(triageAnswer({ intent: "opt_out", confidence: 0.6 }));
    expect(await one("SELECT COUNT(*) AS n FROM suppression")).toEqual({ n: 0 });
  });
});

describe("deals", () => {
  it("advance one stage on interest, never past demo_scheduled, and not below 0.7", async () => {
    const a = await seedReplyContact(db, { email: "jane@globex.example" });
    const b = await seedReplyContact(db, { email: "ada@northwind.example" });
    const c = await seedReplyContact(db, { email: "lin@initrode.example" });
    const dealA = await deal(a.id, a.accountKey, "contacted");
    const dealB = await deal(b.id, b.accountKey, "demo_scheduled");
    const dealC = await deal(c.id, c.accountKey, "contacted");
    await seedInbound(db, env.BUCKET, { sender: a.email, contactId: a.id, body: "Yes, let's talk." });
    await triage(triageAnswer({ intent: "interested", confidence: 0.9 }));
    await seedInbound(db, env.BUCKET, { sender: b.email, contactId: b.id, body: "Yes, let's talk." });
    await triage(triageAnswer({ intent: "question", confidence: 0.9 }));
    await seedInbound(db, env.BUCKET, { sender: c.email, contactId: c.id, body: "Hm, what is it?" });
    await triage(triageAnswer({ intent: "question", confidence: 0.6 }));
    expect((await one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?1", dealA))?.stage).toBe("engaged");
    expect((await one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?1", dealB))?.stage).toBe("demo_scheduled");
    expect((await one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?1", dealC))?.stage).toBe("contacted");
  });
});

describe("deal closing", () => {
  it("never closes a colleague's deal at the same account", async () => {
    const jane = await seedReplyContact(db, { email: "jane@globex.example" });
    const bob = await seedReplyContact(db, { email: "bob@globex.example" });
    const dealId = await deal(jane.id, jane.accountKey, "proposal");
    await seedInbound(db, env.BUCKET, { sender: bob.email, contactId: bob.id, body: "Not for me, thanks." });
    await triage(triageAnswer({ intent: "not_a_fit", confidence: 0.9 }));
    expect((await one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?1", dealId))?.stage).toBe("proposal");
  });
});

describe("declines", () => {
  it("hold the account for 90 days from the reply, archive a short closed one and draft nothing", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const dealId = await deal(contact.id, contact.accountKey, "contacted");
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Thanks, but this is not for us." });
    const { model } = await triage(triageAnswer({ intent: "not_a_fit", confidence: 0.9 }), { flags: withDrafting });
    expect((await one<{ declined_at: string }>("SELECT declined_at FROM contacts WHERE id = ?1", contact.id))?.declined_at).toBe(inbound.receivedAt);
    expect((await one<{ status: string }>("SELECT status FROM inbound_emails WHERE id = ?1", inbound.id))?.status).toBe("archived");
    expect(await one("SELECT stage, loss_reason FROM deals WHERE id = ?1", dealId)).toEqual({ stage: "closed_lost", loss_reason: "no_need" });
    expect(model.byRole("writer")).toHaveLength(0);
  });

  it("with opt-out wording do not set a decline hold", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Not a fit. Please stop emailing me." });
    await triage(triageAnswer({ intent: "not_a_fit", confidence: 0.9 }));
    expect((await one<{ declined_at: string | null }>("SELECT declined_at FROM contacts WHERE id = ?1", contact.id))?.declined_at).toBeNull();
  });
});

describe("referrals", () => {
  it("add up to three colleagues from the headers at the same account, warming, skipping suppressed and own addresses", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await addSuppression(db, { email: "blocked@globex.example", reason: "opt_out", source: "test" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Looping in Sam, who owns CI here." });
    const mailbox = fakeMailbox();
    mailbox.addMessage({
      threadId: inbound.threadId,
      providerMessageId: inbound.providerMessageId,
      receivedAt: inbound.receivedAt,
      to: ["avery@acme.example"],
      cc: ["Sam <sam@globex.example>", "blocked@globex.example", "kim@elsewhere.example", "jane@globex.example"],
    });
    await triage(triageAnswer({ intent: "referral", confidence: 0.9 }), { inbox: mailbox });
    const { results } = await db.prepare("SELECT email, warmth, source FROM contacts WHERE id <> ?1 ORDER BY email").bind(contact.id).all();
    expect(results).toEqual([{ email: "sam@globex.example", warmth: "warming", source: "referral" }]);
  });
});

describe("objections", () => {
  it("are filed unapproved for curation, and the sender's example is cleared when their mail is erased", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Our CI already retries failed tests automatically." });
    await triage(triageAnswer({ intent: "objection", confidence: 0.85, quote: "Our CI already retries failed tests automatically." }));
    const filed = await one<{ author: string; approved_digest: string | null; verbatim_example: string | null; response_template: string }>("SELECT author, approved_digest, verbatim_example, response_template FROM objections");
    expect(filed?.approved_digest).toBeNull();
    expect(filed?.response_template).toBe("");
    expect(filed?.verbatim_example).toBe("Our CI already retries failed tests automatically.");
    await eraseContact(db, contact.email, { source: "operator", bucket: env.BUCKET });
    const after = await one<{ author: string; verbatim_example: string | null }>("SELECT author, verbatim_example FROM objections");
    expect(after).toEqual({ author: "inbound:erased", verbatim_example: null });
  });

  it("get one answer per contact: a second objection gets no draft", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "We built our own script for this.", receivedAt: "2026-11-02T10:00:00.000Z" });
    const first = await triage(triageAnswer({ intent: "objection", confidence: 0.85 }), { flags: withDrafting });
    expect(first.model.byRole("writer")).toHaveLength(1);
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Still, the script works fine for us." });
    const second = await triage(triageAnswer({ intent: "objection", confidence: 0.85 }), { flags: withDrafting });
    expect(second.model.byRole("writer")).toHaveLength(0);
  });
});

describe("every human reply", () => {
  it("moves warmth forward, stops sequences and credits the first touch from the reply's own timestamp", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example", warmth: "contacted" });
    await db.prepare("INSERT INTO campaigns (id, name, status) VALUES ('camp-1', 'Fall', 'active')").run();
    await db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_step, sequence_active, next_send_at) VALUES ('camp-1', ?1, 'sent', 2, 1, '2026-11-06T13:00:00.000Z')").bind(contact.id).run();
    const send = (id: string, step: number, at: string) =>
      db.prepare("INSERT INTO outreach_sends (id, contact_id, account_key, sequence_step, send_path, provider, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'esp', ?6)").bind(id, contact.id, contact.accountKey, step, step === 1 ? "cold" : "sequence", at).run();
    await send("s1", 1, "2026-10-20T13:00:00.000Z");
    await send("s2", 2, "2026-10-23T13:00:00.000Z");
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Interesting. Can we talk Thursday?", receivedAt: "2026-11-03T15:00:00.000Z" });
    await send("s3", 3, "2026-11-04T13:00:00.000Z");
    await triage(triageAnswer({ intent: "interested", confidence: 0.9 }));
    expect((await one<{ warmth: string }>("SELECT warmth FROM contacts WHERE id = ?1", contact.id))?.warmth).toBe("engaged");
    expect(await one("SELECT sequence_active, status FROM campaign_contacts WHERE contact_id = ?1", contact.id)).toEqual({ sequence_active: 0, status: "replied" });
    expect(await one("SELECT replied_at, reply_intent, reply_after_step, positive_reply_at FROM outreach_sends WHERE id = 's1'")).toEqual({
      replied_at: inbound.receivedAt,
      reply_intent: "interested",
      reply_after_step: 2,
      positive_reply_at: inbound.receivedAt,
    });
  });

  it("is credited but never positive when it is a warm reply, and keeps the earliest reply", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await db.prepare("INSERT INTO outreach_sends (id, contact_id, sequence_step, send_path, provider, sent_at) VALUES ('s1', ?1, 1, 'cold', 'esp', '2026-10-20T13:00:00.000Z')").bind(contact.id).run();
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Maybe next quarter.", receivedAt: "2026-11-02T09:00:00.000Z" });
    await triage(triageAnswer({ intent: "warm", confidence: 0.9 }));
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Actually, can we talk?", receivedAt: "2026-11-03T09:00:00.000Z" });
    await triage(triageAnswer({ intent: "interested", confidence: 0.9 }));
    expect(await one("SELECT replied_at, reply_intent, positive_reply_at FROM outreach_sends WHERE id = 's1'")).toEqual({
      replied_at: "2026-11-02T09:00:00.000Z",
      reply_intent: "warm",
      positive_reply_at: "2026-11-03T09:00:00.000Z",
    });
  });

  it("never repeats an effect when routing runs again", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const dealId = await deal(contact.id, contact.accountKey, "contacted");
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Let's talk." });
    await triage(triageAnswer({ intent: "interested", confidence: 0.9 }));
    const row = await db.prepare(`SELECT ${inboundColumns()} FROM inbound_emails WHERE id = ?1`).bind(inbound.id).first<InboundRow>();
    const stored = parseStoredTriage(row?.triage);
    if (!row || !stored) throw new Error("expected a triaged row");
    const again = await routeReply({ db, config, objections: [], now: REPLY_TEST_NOW, log: silentLogger }, row, stored, "Let's talk.", await loadContact(db, contact.id));
    expect(again.applied).toEqual([]);
    expect((await one<{ stage: string }>("SELECT stage FROM deals WHERE id = ?1", dealId))?.stage).toBe("engaged");
  });
});
