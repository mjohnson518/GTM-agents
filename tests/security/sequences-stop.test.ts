// GTM-agents: the sequence's stop rules and approvals hold for every step: a reply from anyone at
// the account stops the next step (and mail not yet triaged counts as a reply), a reply check that
// cannot be read holds the step and sends nothing, an edited follow-up draft is never sent on an
// old release, and nothing goes out at the default autonomy level without a person's release.
// Every person, company and address is invented.
import { recordingOperator } from "@gtm-agents/core/agents/testing";
import { defineConfig } from "@gtm-agents/core/config";
import { fakeJudge, flagReader, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "@gtm-agents/core/outreach/testing";
import { DELIVERY_FLAGS, type OutreachSenderDeps } from "@gtm-agents/core/sending";
import { fakeEmailProvider } from "@gtm-agents/core/sending/testing";
import { createSequenceSender, parseSequenceReleaseCommand, releaseSequenceManifest, runFollowUpSweep, type SweepDeps } from "@gtm-agents/core/sequences";
import { ACME_SEQUENCE_TEMPLATES, failingOn, resetSequenceTables, seedFirstTouch, withMessageIds } from "@gtm-agents/core/sequences/testing";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKv } from "./helpers.ts";

const db = env.DB;
const DAY = 86_400_000;
/** Wednesday 4 November 2026, 12:00 in New York: inside the default send window. */
const NOW = new Date("2026-11-04T17:00:00.000Z");
const CAMPAIGN = "cb20261101";
const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example" },
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    domain: "outreach.acme.example",
    bookingUrl: "https://acme.example/book",
  },
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } },
});
/** Auto-approve on and the reviewer on: without the stop rules, every due step would go out. */
const AUTO = { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" };

let provider: ReturnType<typeof fakeEmailProvider> & ReturnType<typeof withMessageIds>;
let senderDeps: OutreachSenderDeps;
let jane: string;
let sam: string;

async function inbound(from: string, options: { classification?: string | null; contactId?: string | null; at?: Date } = {}): Promise<void> {
  await db
    .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification, contact_id) VALUES (?1, 'test', ?1, ?2, ?3, ?4, ?5)")
    .bind(`in-${crypto.randomUUID()}`, from, (options.at ?? new Date(NOW.getTime() - DAY)).toISOString(), options.classification === undefined ? null : options.classification, options.contactId ?? null)
    .run();
}

function sweepDeps(flags: Record<string, string> = AUTO, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    db,
    kv: env.KV,
    flags: flagReader(flags),
    config,
    now: NOW,
    job: "sequence_sweep",
    log: silentLogger,
    send: createSequenceSender(senderDeps),
    provider,
    model: fakeJudge(),
    operator: recordingOperator().channel,
    ...overrides,
  };
}

const active = async (contactId: string) => (await db.prepare("SELECT sequence_active FROM campaign_contacts WHERE contact_id = ?1").bind(contactId).first<{ sequence_active: number }>())?.sequence_active;

beforeEach(async () => {
  await resetSequenceTables(db);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
  const kv = new MemoryKv();
  kv.map.set(DELIVERY_FLAGS.enabled, "true");
  // Two colleagues at one account: room under the per-account weekly cap for both steps.
  kv.map.set(DELIVERY_FLAGS.accountWeeklyCap, "10");
  provider = withMessageIds(fakeEmailProvider({ name: "fake-esp-seq", now: () => NOW }));
  senderDeps = { db, kv, config, provider, unsubscribeSigningKey: "k".repeat(48), baseUrl: "https://agent.acme.example", now: () => NOW, options: { chunkIntervalMs: 0 } };
  jane = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
  sam = await seedContact(db, { first: "Sam", email: "sam@globex.example", accountName: "Globex Corporation" });
  for (const id of [jane, sam]) await seedFirstTouch(db, { campaignId: CAMPAIGN, contactId: id, provider: provider.name, sentAt: new Date(NOW.getTime() - 3 * DAY - 3_600_000) });
});

describe("a reply from anyone at the account stops the next step", () => {
  it("sends both steps when nobody has written in (the control)", async () => {
    expect((await runFollowUpSweep(sweepDeps())).sent).toBe(2);
  });

  it.each([
    ["the inbox is switched off", { "inbox:enabled": "false" }, null],
    ["poll intake has never run", { "sequences:reply_intake": "poll" }, null],
    ["the latest poll failed", { "sequences:reply_intake": "poll" }, "failed"],
    ["the latest poll was skipped, as under a halt", { "sequences:reply_intake": "poll" }, "skipped"],
    ["the latest poll completed without listing a mailbox, as when a secret is missing", { "sequences:reply_intake": "poll" }, "completed"],
  ])("sends nothing while replies may be going unseen: %s", async (_name, change, lastPoll) => {
    await env.DB.prepare("DELETE FROM execution_runs WHERE task_name = 'inbox_poll'").run();
    if (lastPoll) {
      await env.DB.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, finished_at) VALUES (?1, 'inbox_poll', 'cron', ?2, ?3, ?3)").bind(`poll-${lastPoll}`, lastPoll, NOW.toISOString()).run();
    }
    const result = await runFollowUpSweep(sweepDeps({ ...AUTO, ...change }));
    expect(result).toMatchObject({ status: "held", sent: 0 });
  });

  it.each([
    ["the contact, matched by address", () => inbound("jane@globex.example", { classification: "reply" })],
    ["the contact, matched by id from another address", () => inbound("jane.personal@mail.example", { classification: "reply", contactId: jane })],
    ["a colleague who is not a contact", () => inbound("pat@globex.example", { classification: "new_inquiry" })],
    ["a colleague on a subdomain of the account", () => inbound("pat@eu.globex.example", { classification: "reply" })],
    ["anyone at the account, not yet classified", () => inbound("pat@globex.example", { classification: null })],
    ["anyone at the account, classified unclassified", () => inbound("pat@globex.example", { classification: "unclassified" })],
    ["anyone at the account, asking to unsubscribe", () => inbound("pat@globex.example", { classification: "unsubscribe" })],
  ])("stops every sequence at the account on mail from %s", async (_name, write) => {
    await write();
    const result = await runFollowUpSweep(sweepDeps());
    expect(provider.messages()).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(await active(jane)).toBe(0);
    expect(await active(sam)).toBe(0);
    expect((await db.prepare("SELECT DISTINCT status FROM campaign_contacts").all<{ status: string }>()).results).toEqual([{ status: "replied" }]);
  });

  it.each([
    ["an out-of-office reply", "out_of_office"],
    ["an auto-reply", "auto_reply"],
    ["a bounce", "bounce"],
    ["spam", "spam"],
  ])("does not stop on %s", async (_name, classification) => {
    await inbound("jane@globex.example", { classification });
    expect((await runFollowUpSweep(sweepDeps())).sent).toBe(2);
  });

  it("does not stop on mail from a look-alike domain of another company", async () => {
    await inbound("pat@globex-other.example", { classification: "reply" });
    await inbound("pat@notglobex.example", { classification: "reply" });
    expect((await runFollowUpSweep(sweepDeps())).sent).toBe(2);
  });

  it("still ends the sequence on a reply older than 30 days, through the account's 90-day live thread", async () => {
    await inbound("jane@globex.example", { classification: "reply", at: new Date(NOW.getTime() - 31 * DAY) });
    const result = await runFollowUpSweep(sweepDeps());
    expect(result.sent).toBe(0);
    expect(result.ended).toBe(2);
    expect(provider.messages()).toHaveLength(0);
  });

  it("withholds a step when a colleague's mail lands while the sweep is running", async () => {
    // The Message-ID lookup happens after the sweep's checks; the mail arrives during it.
    let wrote = false;
    provider.lookups.answer = (id) => {
      if (!wrote) {
        wrote = true;
        void inbound("pat@globex.example", { classification: null });
      }
      return `<${id}@mail.fake.example>`;
    };
    const result = await runFollowUpSweep(sweepDeps());
    expect(wrote).toBe(true);
    expect(provider.messages()).toHaveLength(0);
    expect(result.send?.withheld).toBe(2);
    expect(result.sent).toBe(0);
  });

  it("does not send a step approved earlier once someone at the account replied", async () => {
    const { manifest } = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }));
    // Released while not yet due: approved, waiting for the sweep.
    await db.prepare("UPDATE campaign_contacts SET next_send_at = ?1").bind(new Date(NOW.getTime() + DAY).toISOString()).run();
    const command = parseSequenceReleaseCommand(`sequence-release-${manifest?.id}-${manifest?.code}`);
    await releaseSequenceManifest({ db, flags: flagReader(AUTO), kv: env.KV, send: createSequenceSender(senderDeps), provider, config, actor: "operator:test", now: () => NOW }, command ?? { manifestId: "", code: "" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'approved'").first<{ n: number }>())?.n).toBe(2);
    await inbound("pat@globex.example", { classification: "reply", at: new Date(NOW.getTime() + 3_600_000) });
    const later = new Date(NOW.getTime() + DAY + 60_000);
    const result = await runFollowUpSweep(sweepDeps(AUTO, { now: later, send: createSequenceSender({ ...senderDeps, now: () => later }) }));
    expect(result.stopped).toBe(2);
    expect(provider.messages()).toHaveLength(0);
  });

  it("refuses to release a step after someone at the account replied", async () => {
    const { manifest } = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }));
    await inbound("pat@globex.example", { classification: "reply" });
    const command = parseSequenceReleaseCommand(`sequence-release-${manifest?.id}-${manifest?.code}`);
    const result = await releaseSequenceManifest({ db, flags: flagReader(AUTO), kv: env.KV, send: createSequenceSender(senderDeps), provider, config, actor: "operator:test", now: () => NOW }, command ?? { manifestId: "", code: "" });
    expect(result.refused).toHaveLength(2);
    expect(provider.messages()).toHaveLength(0);
  });
});

describe("a read error in the reply check holds the step and never sends", () => {
  it("holds every due step, writes nothing to the rows and sends nothing", async () => {
    const broken = failingOn(db, /FROM inbound_emails/);
    const result = await runFollowUpSweep(sweepDeps(AUTO, { db: broken }));
    expect(result.status).toBe("held");
    expect(result.summary).toMatch(/reply check could not read inbound mail/);
    expect(result.held).toBe(2);
    expect(provider.messages()).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>()).toEqual({ n: 0 });
    const rows = await db.prepare("SELECT sequence_step, sequence_active, sequence_paused_at FROM campaign_contacts").all();
    expect(rows.results).toEqual([
      { sequence_step: 1, sequence_active: 1, sequence_paused_at: null },
      { sequence_step: 1, sequence_active: 1, sequence_paused_at: null },
    ]);
  });

  it("refuses a release when the reply check cannot be read", async () => {
    const { manifest } = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }));
    const command = parseSequenceReleaseCommand(`sequence-release-${manifest?.id}-${manifest?.code}`);
    const result = await releaseSequenceManifest(
      { db: failingOn(db, /FROM inbound_emails/), flags: flagReader(AUTO), kv: env.KV, send: createSequenceSender(senderDeps), provider, config, actor: "operator:test", now: () => NOW },
      command ?? { manifestId: "", code: "" },
    );
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/reply check could not read inbound mail/);
    expect(provider.messages()).toHaveLength(0);
  });
});

describe("an edited follow-up draft is not sent on an old release", () => {
  it("refuses the edited draft and sends only the untouched one", async () => {
    const { manifest } = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }));
    const [edited, kept] = Object.keys(manifest?.entries ?? {});
    await db.prepare("UPDATE drafts SET body = body || ?2 WHERE id = ?1").bind(edited, "\n\nP.S. One more thing.").run();
    const command = parseSequenceReleaseCommand(`sequence-release-${manifest?.id}-${manifest?.code}`);
    const result = await releaseSequenceManifest({ db, flags: flagReader(AUTO), kv: env.KV, send: createSequenceSender(senderDeps), provider, config, actor: "operator:test", now: () => NOW }, command ?? { manifestId: "", code: "" });
    expect(result.refused).toEqual([{ draftId: edited, reason: "the draft changed after it was put up for release" }]);
    expect(provider.messages().map((m) => m.tags.draft_id)).toEqual([kept]);
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(edited).first<{ status: string }>())?.status).toBe("pending_approval");
  });

  it("never sends an approved draft edited after its approval: the edit returns it to review", async () => {
    const { manifest } = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }));
    const ids = Object.keys(manifest?.entries ?? {});
    // Released while the steps were not due: approved, waiting for the sweep.
    await db.prepare("UPDATE campaign_contacts SET next_send_at = ?1").bind(new Date(NOW.getTime() + DAY).toISOString()).run();
    const command = parseSequenceReleaseCommand(`sequence-release-${manifest?.id}-${manifest?.code}`);
    await releaseSequenceManifest({ db, flags: flagReader(AUTO), kv: env.KV, send: createSequenceSender(senderDeps), provider, config, actor: "operator:test", now: () => NOW }, command ?? { manifestId: "", code: "" });
    await db.prepare("UPDATE drafts SET body = body || ?2 WHERE id = ?1").bind(ids[0], "\n\nP.S. Edited after approval.").run();
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(ids[0]).first<{ status: string }>())?.status).toBe("pending_approval");
    const later = new Date(NOW.getTime() + DAY + 60_000);
    await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }, { now: later, send: createSequenceSender({ ...senderDeps, now: () => later }) }));
    expect(provider.messages().map((m) => m.tags.draft_id)).toEqual([ids[1]]);
    expect(provider.messages().some((m) => m.text.includes("Edited after approval"))).toBe(false);
  });
});

describe("nothing sends at the default autonomy level without a release", () => {
  it("drafts and asks, even with the reviewer on and every check passing", async () => {
    const result = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "quality:model_review_enabled": "true" }));
    expect(result.sent).toBe(0);
    expect(result.drafted).toBe(2);
    expect(provider.messages()).toHaveLength(0);
    expect((await db.prepare("SELECT DISTINCT status FROM drafts").all<{ status: string }>()).results).toEqual([{ status: "pending_approval" }]);
  });

  it.each([
    ["an unreadable autonomy level", { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "quality:model_review_enabled": "true" }, ["autonomy:cold_batch"]],
    ["an unreadable auto-approve switch", { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "quality:model_review_enabled": "true", "autonomy:cold_batch": "1" }, ["cold_batch:auto_approve"]],
    ["a malformed autonomy level", { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "quality:model_review_enabled": "true", "autonomy:cold_batch": "9" }, []],
  ])("drafts and asks with %s", async (_name, values, failing) => {
    const result = await runFollowUpSweep(sweepDeps(values, { flags: flagReader(values, failing) }));
    expect(result.sent).toBe(0);
    expect(provider.messages()).toHaveLength(0);
  });

  it("returns an automatically approved step that had to wait to review once automatic approval no longer applies", async () => {
    // Approved automatically, then held for Jane's send window (02:00 in Tokyo).
    await db.prepare("UPDATE contacts SET timezone = 'Asia/Tokyo' WHERE id = ?1").bind(jane).run();
    await db.prepare("UPDATE campaign_contacts SET sequence_active = 0 WHERE contact_id = ?1").bind(sam).run();
    expect((await runFollowUpSweep(sweepDeps())).deferred).toBe(1);
    expect((await db.prepare("SELECT status, approved_by FROM drafts").first())).toEqual({ status: "approved", approved_by: "auto:flag" });
    // The operator turns auto-approve off; the window opens at 08:00 in Tokyo.
    const open = new Date("2026-11-04T23:30:00.000Z");
    const result = await runFollowUpSweep(sweepDeps({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }, { now: open, send: createSequenceSender({ ...senderDeps, now: () => open }) }));
    expect(provider.messages()).toHaveLength(0);
    expect(result.drafted).toBe(1);
    expect((await db.prepare("SELECT status, approved_by FROM drafts").first())).toEqual({ status: "pending_approval", approved_by: null });
  });

  it("sends at level 2 only once the reviewer passed the template", async () => {
    const level2 = { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "autonomy:cold_batch": "2" };
    expect((await runFollowUpSweep(sweepDeps(level2))).sent).toBe(0);
    expect((await runFollowUpSweep(sweepDeps({ ...level2, "quality:model_review_enabled": "true" }, { model: fakeJudge({ failure: "garbage" }) }))).sent).toBe(0);
    expect(provider.messages()).toHaveLength(0);
  });
});
