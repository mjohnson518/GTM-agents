// GTM-agents: tests for incidents and immediate demotion: harm after an automatic send demotes every
// class that sent to the contact in the last 14 days, the cold batch counts only complaints per
// contact and the rest through its rate check, a polite decline is never an incident, nothing is
// lost when a write fails, and the hourly watch records, notifies and writes flags down. Every
// person, company and message is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { checkColdBatchRates, classOfSend, coldBatchRateBreach, incidentCountsFor, reconcileIncidents, recordContactIncident } from "../src/autonomy/incidents.ts";
import { runAutonomyWatch } from "../src/autonomy/jobs.ts";
import { readAutonomyLevel } from "../src/autonomy/store.ts";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { runReplyPipeline } from "../src/replies/pipeline.ts";
import { replyModel, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, triageAnswer, writerAnswer, type SeededContact } from "../src/replies/testing.ts";
import { optOutAddress } from "../src/sending/opt-out.ts";
import { processEmailEvents } from "../src/sending/webhook.ts";
import { failingOn } from "./delivery-fakes.ts";

const db = env.DB;
const config = replyTestConfig();
const NOW = REPLY_TEST_NOW;
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const DIGEST = "d".repeat(64);
let n = 0;

/** A message sent to the contact: a draft approved by `approvedBy`, and its send ledger row. */
async function sent(contact: SeededContact, input: { path: "cold" | "sequence" | "reply"; approvedBy: string; actionClass?: string; daysAgo?: number; status?: string }): Promise<string> {
  n += 1;
  const draftId = `dr-${n}-${crypto.randomUUID().slice(0, 6)}`;
  const kind = input.path === "reply" ? "reply" : input.path === "sequence" ? "follow_up" : "cold_intro";
  await db
    .prepare(
      `INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, approved_digest, approved_by, action_class)
       VALUES (?1, ?2, ?3, ?4, 'A subject', 'A body', ?5, ?6, ?7, ?8)`,
    )
    .bind(draftId, contact.id, kind, contact.email, input.status ?? "sent", DIGEST, input.approvedBy, input.actionClass ?? null)
    .run();
  if ((input.status ?? "sent") === "sent") {
    await db
      .prepare("INSERT INTO outreach_sends (id, contact_id, account_key, draft_id, send_path, provider, sequence_step, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'test-ledger', ?6, ?7)")
      .bind(`os-${n}-${crypto.randomUUID().slice(0, 6)}`, contact.id, contact.accountKey, draftId, input.path, input.path === "reply" ? null : input.path === "sequence" ? 2 : 1, ago(input.daysAgo ?? 2))
      .run();
  }
  return draftId;
}

const incidents = async () => (await db.prepare("SELECT action_class, subject_id FROM autonomy_events WHERE outcome = 'incident' ORDER BY action_class").all<{ action_class: string; subject_id: string | null }>()).results;
const demotions = async () => (await db.prepare("SELECT action_class, to_level FROM autonomy_level_changes WHERE source = 'demotion' ORDER BY action_class").all()).results;
const level = async (actionClass: string, flags = flagReader({ [`autonomy:${actionClass}`]: "2" })) => (await readAutonomyLevel({ flags, db }, actionClass)).level;

beforeEach(async () => {
  await resetReplyTables(db);
  await db.batch([db.prepare("DELETE FROM autonomy_level_changes"), db.prepare("DELETE FROM autonomy_proposals")]);
});

describe("which harm counts against which class", () => {
  it("counts every kind against a reply class and only complaints, per contact, against the cold batch", () => {
    expect(incidentCountsFor("reply_send", "hard_bounce")).toBe(true);
    expect(incidentCountsFor("reply_demo_link", "unsubscribe")).toBe(true);
    expect(incidentCountsFor("cold_batch", "complaint")).toBe(true);
    expect(incidentCountsFor("cold_batch", "hard_bounce")).toBe(false);
    expect(incidentCountsFor("cold_batch", "unsubscribe")).toBe(false);
  });

  it("files a send under its class from its path and its draft", () => {
    expect(classOfSend("cold", null)).toBe("cold_batch");
    expect(classOfSend("sequence", "reply_send")).toBe("cold_batch");
    expect(classOfSend("reply", "reply_demo_link")).toBe("reply_demo_link");
    expect(classOfSend("reply", "offers")).toBe("reply_send");
    expect(classOfSend("lifecycle", null)).toBe("lifecycle_activation");
  });
});

describe("harm after an automatic send", () => {
  it("demotes every reply class that sent to the contact automatically, at once", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_demo_link:L2", actionClass: "reply_demo_link", daysAgo: 10 });
    await optOutAddress(db, contact.email, { reason: "bounce", source: "provider_webhook", now: NOW });
    expect(await incidents()).toEqual([
      { action_class: "reply_demo_link", subject_id: contact.id },
      { action_class: "reply_send", subject_id: contact.id },
    ]);
    expect(await demotions()).toEqual([
      { action_class: "reply_demo_link", to_level: 1 },
      { action_class: "reply_send", to_level: 1 },
    ]);
    expect(await level("reply_send")).toBe(1);
    expect(await level("reply_demo_link")).toBe(1);
  });

  it("counts a hard bounce or an opt-out on automatic cold mail only through the rate check", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "cold", approvedBy: "auto:autonomy_level" });
    await sent(contact, { path: "sequence", approvedBy: "auto:autonomy_level" });
    const result = await recordContactIncident(db, { contactIds: [contact.id], kind: "hard_bounce", at: NOW, source: "test" });
    expect(result).toMatchObject({ recorded: [], volumeTouched: true, failed: false });
    await optOutAddress(db, contact.email, { reason: "opt_out", source: "unsubscribe_link", now: NOW });
    expect(await incidents()).toEqual([]);
    expect(await level("cold_batch")).toBe(2);
  });

  it("demotes the cold batch on a complaint about its automatic mail, from the provider webhook", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "cold", approvedBy: "auto:flag" });
    const result = await processEmailEvents({ db, kv: memoryKv(), provider: "test-ledger", now: NOW }, [{ type: "complained", to: contact.email, providerMessageId: "pm-1" } as never]);
    expect(result.retry).toBe(false);
    expect(await incidents()).toEqual([{ action_class: "cold_batch", subject_id: contact.id }]);
    expect(await level("cold_batch", flagReader({ "autonomy:cold_batch": "3" }))).toBe(1);
  });

  it("is not an incident after a person's approval, or after the 14 days", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "operator:user-1", actionClass: "reply_send" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send", daysAgo: 15 });
    await optOutAddress(db, contact.email, { reason: "complaint", source: "provider_webhook", now: NOW });
    expect(await incidents()).toEqual([]);
    expect(await demotions()).toEqual([]);
  });

  it("never lifts a class a person set to 0", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor) VALUES ('reply_send', 0, 'operator', 'operator:user-1')").run();
    await optOutAddress(db, contact.email, { reason: "opt_out", source: "unsubscribe_link", now: NOW });
    expect(await demotions()).toEqual([{ action_class: "reply_send", to_level: 0 }]);
    expect(await level("reply_send")).toBe(0);
  });

  it("counts the same harm once, however often it is reported", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    for (let i = 0; i < 3; i++) await optOutAddress(db, contact.email, { reason: "opt_out", source: "unsubscribe_link", now: NOW });
    expect(await incidents()).toHaveLength(1);
    expect(await demotions()).toHaveLength(1);
  });

  it("returns the class's automatically approved, unsent drafts to review", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const other = await seedReplyContact(db, { email: "sam@initech.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    const queued = await sent(other, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send", status: "approved" });
    const byPerson = await sent(other, { path: "reply", approvedBy: "operator:user-1", actionClass: "reply_send", status: "approved" });
    await optOutAddress(db, contact.email, { reason: "opt_out", source: "unsubscribe_link", now: NOW });
    const status = async (id: string) => (await db.prepare("SELECT status, approved_digest FROM drafts WHERE id = ?1").bind(id).first())?.status;
    expect(await status(queued)).toBe("pending_approval");
    expect(await status(byPerson)).toBe("approved");
  });

  it("never treats a polite decline as an incident", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Thanks for reaching out, but this is not a fit for us right now." });
    const model = replyModel({ triage: triageAnswer({ intent: "not_a_fit", confidence: 0.95 }), writer: writerAnswer("Hi Jane,\n\nThanks for letting me know.\n\nAvery") });
    await runReplyPipeline({ db, kv: env.KV, bucket: env.BUCKET, flags: flagReader({ "replies:triage_enabled": "true" }), config, model, job: "replies_triage", now: NOW, log: silentLogger, maxRows: 10 });
    expect(await incidents()).toEqual([]);
    expect(await level("reply_send")).toBe(2);
  });

  it("treats a triaged opt-out reply as an incident", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Please remove me from your list." });
    const model = replyModel({ triage: triageAnswer({ intent: "opt_out", confidence: 0.95 }) });
    await runReplyPipeline({ db, kv: env.KV, bucket: env.BUCKET, flags: flagReader({ "replies:triage_enabled": "true" }), config, model, job: "replies_triage", now: NOW, log: silentLogger, maxRows: 10 });
    expect(await incidents()).toEqual([{ action_class: "reply_send", subject_id: contact.id }]);
  });
});

describe("a demotion that cannot be written", () => {
  it("never fails the opt-out, is reported, and is recorded later by the hourly watch", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    const broken = failingOn(db, /autonomy_level_changes|outreach_sends os JOIN drafts/);
    const result = await optOutAddress(broken, contact.email, { reason: "bounce", source: "provider_webhook", now: NOW });
    expect(result.failedWrites).toContain("autonomy_incident");
    expect(await db.prepare("SELECT reason FROM suppression WHERE email = ?1").bind(contact.email).first()).toEqual({ reason: "bounce" });
    expect(await incidents()).toEqual([]);

    // Until it lands, a level read that cannot see the recorded changes is 1.
    expect((await readAutonomyLevel({ flags: flagReader({ "autonomy:reply_send": "2" }), db: broken }, "reply_send")).level).toBe(1);

    const reconciled = await reconcileIncidents(db, new Date(NOW.getTime() + 60 * 60_000), 50, { attempts: 1 });
    expect(reconciled.recorded).toEqual([{ actionClass: "reply_send", contactId: contact.id }]);
    expect(await demotions()).toEqual([{ action_class: "reply_send", to_level: 1 }]);
    expect((await reconcileIncidents(db, new Date(NOW.getTime() + 2 * 60 * 60_000), 50)).recorded).toEqual([]);
  });

  it("retries a write before giving up", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    let failures = 1;
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(new Error("D1_ERROR: busy"));
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await recordContactIncident(flaky, { contactIds: [contact.id], kind: "unsubscribe", at: NOW, source: "test" }, { pauseMs: 1 });
    expect(result).toMatchObject({ failed: false, recorded: [{ actionClass: "reply_send" }] });
  });
});

describe("the cold batch's rate check", () => {
  async function ledger(count: number, opts: { bounced?: number; optedOut?: number } = {}): Promise<void> {
    const contacts: SeededContact[] = [];
    for (let i = 0; i < count; i++) contacts.push(await seedReplyContact(db, { email: `person${i}@prospect${i}.example` }));
    for (const [i, contact] of contacts.entries()) {
      await db
        .prepare("INSERT INTO outreach_sends (id, contact_id, account_key, send_path, provider, sequence_step, sent_at, bounced_at) VALUES (?1, ?2, ?3, 'cold', 'test-ledger', 1, ?4, ?5)")
        .bind(`os-rate-${i}-${crypto.randomUUID().slice(0, 6)}`, contact.id, contact.accountKey, ago(5), i < (opts.bounced ?? 0) ? ago(4) : null)
        .run();
      if (i >= count - (opts.optedOut ?? 0)) {
        await db.prepare("INSERT INTO suppression (email_sha256, email, reason, source, created_at) SELECT email_sha256, email, 'opt_out', 'test', ?2 FROM contacts WHERE id = ?1").bind(contact.id, ago(3)).run();
      }
    }
  }

  it("names the breach only with enough sends", () => {
    expect(coldBatchRateBreach({ sends: 49, hardBounceRate: 0.5, unsubscribeRate: 0.5 })).toBeNull();
    expect(coldBatchRateBreach({ sends: 50, hardBounceRate: 0.02, unsubscribeRate: 0 })).toMatch(/hard bounce rate 2\.0%/);
    expect(coldBatchRateBreach({ sends: 50, hardBounceRate: 0.019, unsubscribeRate: 0.01 })).toMatch(/unsubscribe rate 1\.0%/);
    expect(coldBatchRateBreach({ sends: 50, hardBounceRate: null, unsubscribeRate: null })).toBeNull();
  });

  it("demotes the cold batch at a 2% hard bounce rate over 50 or more sends while it sends on its own", async () => {
    await ledger(60, { bounced: 2 });
    const flags = flagReader({ "autonomy:cold_batch": "2" });
    const result = await checkColdBatchRates({ db, flags, now: NOW });
    expect(result).toMatchObject({ status: "demoted", written: true });
    expect(await demotions()).toEqual([{ action_class: "cold_batch", to_level: 1 }]);
    expect(await checkColdBatchRates({ db, flags, now: NOW })).toEqual({ status: "already_demoted" });
  });

  it("passes under the limits, and demotes at a 1% unsubscribe rate, from the one definition in metrics/", async () => {
    await ledger(60, { bounced: 1 });
    expect(await checkColdBatchRates({ db, flags: flagReader({ "cold_batch:auto_approve": "true" }), now: NOW })).toMatchObject({ status: "ok" });
    await db.prepare("INSERT INTO suppression (email_sha256, email, reason, source, created_at) SELECT email_sha256, email, 'opt_out', 'test', ?1 FROM contacts WHERE email = 'person59@prospect59.example'").bind(ago(3)).run();
    expect(await checkColdBatchRates({ db, flags: flagReader({ "cold_batch:auto_approve": "true" }), now: NOW })).toMatchObject({ status: "demoted" });
  });

  it("does nothing under 50 sends, below the limits, or while a person releases every batch", async () => {
    await ledger(40, { bounced: 5 });
    expect(await checkColdBatchRates({ db, flags: flagReader({ "autonomy:cold_batch": "2" }), now: NOW })).toMatchObject({ status: "small_sample" });
    expect(await checkColdBatchRates({ db, flags: flagReader({ "autonomy:cold_batch": "1" }), now: NOW })).toEqual({ status: "not_automatic" });
    expect(await demotions()).toEqual([]);
  });

  it("runs the check when the level cannot be read, since demoting is the safe direction", async () => {
    await ledger(60, { bounced: 3 });
    expect(await checkColdBatchRates({ db, flags: flagReader({}, ["autonomy:cold_batch"]), now: NOW })).toMatchObject({ status: "demoted" });
  });
});

describe("the hourly watch", () => {
  it("tells the operator once per demotion and writes the flag down to it", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await sent(contact, { path: "reply", approvedBy: "auto:autonomy:reply_send:L2", actionClass: "reply_send" });
    await optOutAddress(db, contact.email, { reason: "complaint", source: "provider_webhook", now: NOW });
    const kv = memoryKv({ "autonomy:reply_send": "2" });
    const operator = recordingOperator();
    const watch = () => runAutonomyWatch({ db, kv, flags: { get: (k) => kv.get(k) }, config, operator: operator.channel, now: new Date(NOW.getTime() + 60 * 60_000), log: silentLogger, maxRows: 50 });
    const first = await watch();
    expect(first).toMatchObject({ notified: 1, flagsWritten: 1 });
    expect(kv.map.get("autonomy:reply_send")).toBe("1");
    expect(operator.messages[0]?.text).toMatch(/Autonomy demoted: reply_send is back to level 1/);
    expect(await watch()).toMatchObject({ notified: 0, flagsWritten: 0 });
    expect(operator.messages).toHaveLength(1);
  });

  it("retries a notice that could not be sent", async () => {
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason, created_at) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint', ?1)").bind(NOW.toISOString()).run();
    const kv = memoryKv();
    const failing = recordingOperator();
    failing.channel.notify = () => Promise.reject(new Error("channel down"));
    const deps = { db, kv, flags: { get: (k: string) => kv.get(k) }, config, now: NOW, log: silentLogger, maxRows: 50 };
    expect(await runAutonomyWatch({ ...deps, operator: failing.channel })).toMatchObject({ notified: 0 });
    const working = recordingOperator();
    expect(await runAutonomyWatch({ ...deps, operator: working.channel })).toMatchObject({ notified: 1 });
  });
});
