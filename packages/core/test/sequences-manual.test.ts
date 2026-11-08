// GTM-agents: tests for the manual channel step before the last follow-up, the weekend stale check
// and the sequence jobs. Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { findFlag } from "../src/flags/registry.ts";
import { fakeJudge, flagReader, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "../src/outreach/testing.ts";
import type { OutreachSenderDeps } from "../src/sending/boundary.ts";
import type { FakeEmailProvider } from "../src/sending/testing.ts";
import { createSequenceJobs, SEQUENCE_STALE_JOB, SEQUENCE_SWEEP_JOB } from "../src/sequences/jobs.ts";
import { composeManualNote, recordManualTouch } from "../src/sequences/manual.ts";
import { createSequenceSender } from "../src/sequences/sender.ts";
import { runStaleCheck } from "../src/sequences/stale.ts";
import { runFollowUpSweep } from "../src/sequences/sweep.ts";
import { ACME_SEQUENCE_TEMPLATES, resetSequenceTables, seedFirstTouch, withMessageIds } from "../src/sequences/testing.ts";
import type { JobContext } from "../src/jobs/registry.ts";
import { recordingOperator } from "../src/agents/testing.ts";
import { acmeConfig } from "./fixtures.ts";
import { harness, NOW } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const CAMPAIGN = "cb20261101";
const config = defineConfig({ ...acmeConfig, models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } } });
const FLAGS = { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true", "followup:manual_channel_enabled": "true" };

describe("the manual channel step", () => {
  let provider: FakeEmailProvider & ReturnType<typeof withMessageIds>;
  let senderDeps: OutreachSenderDeps;
  let operator: ReturnType<typeof harness>["operator"];
  let contactId: string;
  beforeEach(async () => {
    await resetSequenceTables(db);
    await uploadOutreachBrain(env.KV);
    await uploadTemplates(env.KV, [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
    const h = harness(db, { config });
    provider = withMessageIds(h.provider);
    senderDeps = h.deps;
    operator = h.operator;
    contactId = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    // Step 2 went out a week ago, so step 3 (the last) is due now.
    await seedFirstTouch(db, { campaignId: CAMPAIGN, contactId, provider: provider.name, sentAt: new Date(NOW.getTime() - 10 * DAY), messageId: "<first-touch@mail.fake.example>" });
    await db
      .prepare("INSERT INTO outreach_sends (id, contact_id, campaign_id, sequence_step, subject, send_path, provider, provider_message_id, message_id, sent_at) VALUES ('os-step2', ?1, ?2, 2, 'Re: Flaky builds at Globex Corporation', 'sequence', ?3, 'pm-step2', '<step-two@mail.fake.example>', ?4)")
      .bind(contactId, CAMPAIGN, provider.name, new Date(NOW.getTime() - 7 * DAY - 3_600_000).toISOString())
      .run();
    await db.prepare("UPDATE campaign_contacts SET sequence_step = 2, next_send_at = ?2 WHERE contact_id = ?1").bind(contactId, new Date(NOW.getTime() - 3_600_000).toISOString()).run();
  });

  const sweep = (now: Date = NOW, flags: Record<string, string> = FLAGS) =>
    runFollowUpSweep({ db, kv: env.KV, flags: flagReader(flags), config, now, job: "sequence_sweep", log: silentLogger, send: createSequenceSender({ ...senderDeps, now: () => now }), provider, model: fakeJudge(), operator: operator.channel });

  it("asks for a manual touch before the last step and makes it wait, posting nothing", async () => {
    const result = await sweep();
    expect(result.waiting).toBe(1);
    expect(provider.messages()).toHaveLength(0);
    const touch = await db.prepare("SELECT id, status, body, expires_at FROM manual_touches").first<{ id: string; status: string; body: string; expires_at: string }>();
    expect(touch?.status).toBe("pending");
    expect(touch?.body.length).toBeLessThanOrEqual(300);
    expect(touch?.body).toMatch(/^Hi Jane,/);
    expect(touch?.expires_at).toBe(new Date(NOW.getTime() + 5 * DAY).toISOString());
    expect((await db.prepare("SELECT next_send_at FROM campaign_contacts").first<{ next_send_at: string }>())?.next_send_at).toBe(touch?.expires_at);
    expect(operator.messages.some((m) => m.text.includes(`channel-done-${touch?.id}`) && m.text.includes(`channel-skip-${touch?.id}`))).toBe(true);
  });

  it("sends the last step on the next sweep once the touch is marked done, and logs the touch as manual", async () => {
    await sweep();
    const touch = await db.prepare("SELECT id FROM manual_touches").first<{ id: string }>();
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await recordManualTouch(db, { id: touch?.id ?? "", decision: "done", channel: "linkedin", by: "operator:42", now: later })).toMatch(/Recorded the LinkedIn touch/);
    expect(await recordManualTouch(db, { id: touch?.id ?? "", decision: "skip", channel: "linkedin", by: "operator:42", now: later })).toMatch(/already done/);
    expect(await db.prepare("SELECT channel, provider, outcome FROM outreach_log").first()).toEqual({ channel: "linkedin", provider: "manual", outcome: "sent" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM outreach_sends WHERE provider = 'manual'").first<{ n: number }>()).toEqual({ n: 0 });
    const result = await sweep(new Date(later.getTime() + 60_000));
    expect(result.sent).toBe(1);
    const [last] = provider.messages();
    expect(last?.effectKey).toBe(`seq:${CAMPAIGN}:${contactId}:3`);
    expect(last?.headers["In-Reply-To"]).toBe("<step-two@mail.fake.example>");
    expect(last?.headers.References).toBe("<first-touch@mail.fake.example> <step-two@mail.fake.example>");
  });

  it("lets the last step go once the touch expires unanswered", async () => {
    await sweep();
    const result = await sweep(new Date(NOW.getTime() + 5 * DAY + 60_000));
    expect(result.sent).toBe(1);
    expect((await db.prepare("SELECT status FROM manual_touches").first<{ status: string }>())?.status).toBe("expired");
  });

  it("asks for nothing while the flag is off", async () => {
    const result = await sweep(NOW, { ...FLAGS, "followup:manual_channel_enabled": "false" });
    expect(result.sent).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_touches").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("writes a note of at most 300 characters from the contact, the first subject and the sender", () => {
    expect(composeManualNote({ firstName: "Jane", firstSubject: "Re: Flaky builds", senderName: "Avery" })).toBe('Hi Jane, I sent you a short email about "Flaky builds". If it is easier to pick it up here, I am happy to. Avery');
    expect(composeManualNote({ firstName: null, firstSubject: "x".repeat(400), senderName: "Avery" }).length).toBeLessThanOrEqual(300);
  });
});

describe("the stale check", () => {
  beforeEach(async () => {
    await resetSequenceTables(db);
  });

  it("reports paused and long-overdue sequences once, until their state changes", async () => {
    const paused = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    const overdue = await seedContact(db, { first: "Ada", email: "ada@northwind.example" });
    const fine = await seedContact(db, { first: "Sam", email: "sam@initrode.example" });
    for (const id of [paused, overdue, fine]) await seedFirstTouch(db, { campaignId: CAMPAIGN, contactId: id, provider: "p", sentAt: new Date(NOW.getTime() - 10 * DAY) });
    await db.prepare("UPDATE campaign_contacts SET sequence_paused_at = ?2, sequence_pause_reason = 'a test pause' WHERE contact_id = ?1").bind(paused, NOW.toISOString()).run();
    await db.prepare("UPDATE campaign_contacts SET next_send_at = ?2 WHERE contact_id = ?1").bind(fine, new Date(NOW.getTime() - DAY).toISOString()).run();
    const operator = recordingOperator();
    const first = await runStaleCheck({ db, operator: operator.channel, now: NOW, maxRows: 100 });
    expect(first).toEqual({ stale: 2, paused: 1, reported: 2 });
    expect(operator.messages[0]?.text).toMatch(`sequence-resume-${paused}`);
    const second = await runStaleCheck({ db, operator: operator.channel, now: NOW, maxRows: 100 });
    expect(second.reported).toBe(0);
    expect(operator.messages).toHaveLength(1);
  });
});

describe("the sequence jobs", () => {
  const email = () => undefined;

  it("registers the sweep and the stale check behind sequences:enabled, with ceilings and named days", () => {
    const jobs = createSequenceJobs({ email });
    const sweep = jobs.find((j) => j.name === SEQUENCE_SWEEP_JOB);
    const stale = jobs.find((j) => j.name === SEQUENCE_STALE_JOB);
    expect(sweep).toMatchObject({ schedule: "30 8,12,16,20 * * MON-FRI", flag: "sequences:enabled", ceilings: { maxDurationMs: 240_000, maxRows: 200, maxSpendCents: 25 }, rerunnable: true });
    expect(stale).toMatchObject({ schedule: "0 10 * * SAT", flag: "sequences:enabled", ceilings: { maxDurationMs: 30_000, maxRows: 500 } });
    expect(findFlag("sequences:enabled")).toMatchObject({ kind: "boolean", default: "false" });
    expect(findFlag("followup:manual_channel_enabled")).toMatchObject({ kind: "boolean", default: "false" });
  });

  it("refuses a sweep schedule that would call the reviewer more often than every 15 minutes", () => {
    expect(() => createSequenceJobs({ email, options: { sweepSchedule: "*/5 * * * MON-FRI" } })).toThrow(/at most every 15 minutes/);
    expect(() => createSequenceJobs({ email, options: { sweepMaxRows: 0 } })).toThrow(/sweepMaxRows/);
  });

  it("does nothing when run directly with the flag off", async () => {
    const [sweep, stale] = createSequenceJobs({ email });
    const ctx = { env: { DB: db }, config, job: "x", now: NOW, signal: new AbortController().signal, ceilings: { maxDurationMs: 1000, maxRows: 10 }, flags: flagReader({}), log: silentLogger } as unknown as JobContext<{ DB: D1Database }>;
    expect(await sweep?.run(ctx)).toEqual({ summary: "flag off" });
    expect(await stale?.run(ctx)).toEqual({ summary: "flag off" });
  });
});
