// GTM-agents: the measurement milestone's gate: every report agrees on the numbers.
//
// One synthetic data set (first touches, follow-ups, delivery events, replies credited through the
// reply track's own crediting, a holdout, spend, failed runs, an owed reply) is read by the daily
// scorecard, the funnel digest, the conversion report and the holdout lift report. Each report must
// show exactly what the metric functions compute for the same window, the reports must agree with
// each other wherever they show the same quantity, and the numbers must be the ones the data set was
// built to produce. A last test fails if a report module ever counts anything itself instead of
// importing its numbers from the metrics module. Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countReplies,
  countSends,
  deliveryHealth,
  failedJobs,
  firstTouchOutcomes,
  firstTouchOutcomesBy,
  holdoutLift,
  maturedSamples,
  maturedTotals,
  measurementHealth,
  OUTCOME_DIMENSIONS,
  replyDepth,
  replyResponseTimes,
  replySla,
  spendByJob,
} from "../src/metrics/index.ts";
import { flagReader, resetOutreachTables } from "../src/outreach/testing.ts";
import { creditReply } from "../src/replies/ledger.ts";
import { conversionWindow, loadConversionReport, renderConversionReport } from "../src/reports/conversion.ts";
import { loadCostDigest, renderCostDigest } from "../src/reports/cost.ts";
import { funnelWindows, loadFunnelDigest, renderFunnelDigest } from "../src/reports/funnel.ts";
import { liftWindow, loadHoldoutReport, renderHoldoutReport } from "../src/reports/holdout.ts";
import { loadScorecard, renderScorecard, scorecardWindows, type ScorecardData } from "../src/reports/scorecard.ts";
import { insertContact, uid } from "./delivery-fakes.ts";

const db = env.DB;
/** A Monday, so the scorecard's day covers Friday to Sunday and the funnel digest's week is the scorecard's. */
const NOW = new Date("2022-11-14T12:00:00.000Z");
const ESP = "gate-esp";
const GENERIC = "1".repeat(64);
const SAAS = "2".repeat(64);
const flags = flagReader({ "ops:daily_scorecard": "true" });

interface Touch {
  sentAt: string;
  template: "tpl-generic" | "tpl-saas";
  cohort: string;
  account: string;
  persona?: string;
  deliveredAt?: string;
  bouncedAt?: string;
  complainedAt?: string;
  followUpAt?: string;
  reply?: { at: string; intent: string };
}

async function ledgerSend(row: { contactId: string; account: string; step: number | null; path: string; provider?: string; sentAt: string; template?: string; sha?: string; cohort?: string; deliveredAt?: string; bouncedAt?: string; complainedAt?: string }): Promise<void> {
  const messageId = uid("pm");
  const provider = row.provider ?? ESP;
  await db
    .prepare(
      `INSERT INTO outreach_sends (id, contact_id, account_key, template_id, template_sha256, cohort, subject, sequence_step, send_path, provider, provider_message_id,
         sent_at, delivered_at, bounced_at, complained_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Flaky builds at Globex', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .bind(uid("os"), row.contactId, row.account, row.template ?? null, row.sha ?? null, row.cohort ?? null, row.step, row.path, provider, messageId, row.sentAt, row.deliveredAt ?? null, row.bouncedAt ?? null, row.complainedAt ?? null)
    .run();
  // The send function writes this funnel event beside every ledger row; measurement health matches them.
  await sentEvent(provider, messageId, row.sentAt);
}

async function sentEvent(provider: string, messageId: string, at: string): Promise<void> {
  await db
    .prepare("INSERT INTO funnel_events (id, event_type, source, metadata, occurred_at) VALUES (?1, 'outreach_sent', 'agent', ?2, ?3)")
    .bind(uid("fe"), JSON.stringify({ provider, provider_message_id: messageId }), at)
    .run();
}

async function inbound(contactId: string, at: string, intent: string, status = "responded", draftId: string | null = null): Promise<void> {
  await db
    .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification, intent, status, contact_id, draft_id) VALUES (?1, 'gate-mailbox', ?2, 'someone@prospect.example', ?3, 'reply', ?4, ?5, ?6, ?7)")
    .bind(uid("in"), uid("msg"), at, intent, status, contactId, draftId)
    .run();
}

async function touch(t: Touch): Promise<string> {
  const contact = await insertContact(db, { accountKey: t.account });
  if (t.persona) await db.prepare("INSERT INTO account_contacts (account_key, contact_id, persona) VALUES (?1, ?2, ?3)").bind(t.account, contact.id, t.persona).run();
  const sha = t.template === "tpl-generic" ? GENERIC : SAAS;
  await ledgerSend({ contactId: contact.id, account: t.account, step: 1, path: "cold", sentAt: t.sentAt, template: t.template, sha, cohort: t.cohort, ...(t.deliveredAt ? { deliveredAt: t.deliveredAt } : {}), ...(t.bouncedAt ? { bouncedAt: t.bouncedAt } : {}), ...(t.complainedAt ? { complainedAt: t.complainedAt } : {}) });
  if (t.followUpAt) await ledgerSend({ contactId: contact.id, account: t.account, step: 2, path: "sequence", sentAt: t.followUpAt, deliveredAt: t.followUpAt });
  if (t.reply) {
    await inbound(contact.id, t.reply.at, t.reply.intent);
    await creditReply(db, { contactId: contact.id, intent: t.reply.intent, classification: "reply", receivedAt: t.reply.at });
  }
  return contact.id;
}

const many = async (count: number, t: Touch) => {
  for (let i = 0; i < count; i++) await touch(t);
};

async function seed(): Promise<void> {
  await resetOutreachTables(db);
  await db.batch(["funnel_events", "execution_runs", "events", "signal_events"].map((table) => db.prepare(`DELETE FROM ${table}`)));
  await db.prepare("INSERT INTO templates (id, kind, status, subject, body_sha256) VALUES ('tpl-generic', 'cold_intro', 'approved', 'Flaky builds at {{account_name}}', ?1)").bind(GENERIC).run();
  await db.prepare("INSERT INTO templates (id, kind, status, subject, body_sha256, segments) VALUES ('tpl-saas', 'cold_intro', 'approved', 'Quarantine for {{account_name}}', ?1, '[\"saas\"]')").bind(SAAS).run();
  await db.prepare("INSERT INTO accounts (account_key, name, segment) VALUES ('globex.example', 'Globex', 'saas'), ('initech.example', 'Initech', 'fintech')").run();

  // Old first touches, inside the holdout window only: one positive (a referral).
  await touch({ sentAt: "2022-09-01T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "globex.example", reply: { at: "2022-09-05T10:00:00.000Z", intent: "referral" } });
  await many(2, { sentAt: "2022-09-01T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "globex.example" });
  // A: 20 October, four generic touches, one interested reply.
  await touch({ sentAt: "2022-10-20T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "globex.example", persona: "platform-champion", deliveredAt: "2022-10-20T10:01:00.000Z", reply: { at: "2022-10-22T10:00:00.000Z", intent: "interested" } });
  await many(3, { sentAt: "2022-10-20T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "globex.example", deliveredAt: "2022-10-20T10:01:00.000Z" });
  // B: 30 October, six segment-routed touches: one bounced, a question after step 2, a decline after step 2, one more follow-up.
  await touch({ sentAt: "2022-10-30T10:00:00.000Z", template: "tpl-saas", cohort: "segment_routed", account: "initech.example", bouncedAt: "2022-10-30T10:02:00.000Z" });
  await touch({ sentAt: "2022-10-30T10:00:00.000Z", template: "tpl-saas", cohort: "segment_routed", account: "initech.example", persona: "economic-buyer", deliveredAt: "2022-10-30T10:01:00.000Z", followUpAt: "2022-11-02T10:00:00.000Z", reply: { at: "2022-11-02T15:00:00.000Z", intent: "question" } });
  await touch({ sentAt: "2022-10-30T10:00:00.000Z", template: "tpl-saas", cohort: "segment_routed", account: "initech.example", deliveredAt: "2022-10-30T10:01:00.000Z", followUpAt: "2022-11-02T10:00:00.000Z", reply: { at: "2022-11-09T09:00:00.000Z", intent: "not_a_fit" } });
  await touch({ sentAt: "2022-10-30T10:00:00.000Z", template: "tpl-saas", cohort: "segment_routed", account: "initech.example", deliveredAt: "2022-10-30T10:01:00.000Z", followUpAt: "2022-11-02T10:00:00.000Z" });
  await many(2, { sentAt: "2022-10-30T10:00:00.000Z", template: "tpl-saas", cohort: "segment_routed", account: "initech.example", deliveredAt: "2022-10-30T10:01:00.000Z" });
  // C: 8 November, five signalled touches: a warm reply answered in 3 hours, a complaint, one never delivered, two follow-ups on the 11th.
  const warm = await touch({ sentAt: "2022-11-08T10:00:00.000Z", template: "tpl-generic", cohort: "signalled", account: "globex.example", deliveredAt: "2022-11-08T10:01:00.000Z" });
  await inbound(warm, "2022-11-10T09:00:00.000Z", "warm", "responded", "dr-gate-answer");
  await db.prepare("INSERT INTO drafts (id, contact_id, kind, status, sent_at) VALUES ('dr-gate-answer', ?1, 'reply', 'sent', '2022-11-10T12:00:00.000Z')").bind(warm).run();
  await creditReply(db, { contactId: warm, intent: "warm", classification: "reply", receivedAt: "2022-11-10T09:00:00.000Z" });
  await touch({ sentAt: "2022-11-08T10:00:00.000Z", template: "tpl-generic", cohort: "signalled", account: "globex.example", deliveredAt: "2022-11-08T10:01:00.000Z", complainedAt: "2022-11-09T08:00:00.000Z", followUpAt: "2022-11-11T10:00:00.000Z" });
  await touch({ sentAt: "2022-11-08T10:00:00.000Z", template: "tpl-generic", cohort: "signalled", account: "globex.example", deliveredAt: "2022-11-08T10:01:00.000Z", followUpAt: "2022-11-11T10:00:00.000Z" });
  await touch({ sentAt: "2022-11-08T10:00:00.000Z", template: "tpl-generic", cohort: "signalled", account: "globex.example", deliveredAt: "2022-11-08T10:01:00.000Z" });
  await touch({ sentAt: "2022-11-08T10:00:00.000Z", template: "tpl-generic", cohort: "signalled", account: "globex.example" });
  // G: 9 November, ten generic touches at an account with no segment, all delivered.
  await many(10, { sentAt: "2022-11-09T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "hooli.example", deliveredAt: "2022-11-09T10:01:00.000Z" });
  // D: Saturday 12 November, two generic touches, one interested reply on Sunday.
  await touch({ sentAt: "2022-11-12T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "umbrella.example", deliveredAt: "2022-11-12T10:01:00.000Z", reply: { at: "2022-11-13T10:00:00.000Z", intent: "interested" } });
  await touch({ sentAt: "2022-11-12T10:00:00.000Z", template: "tpl-generic", cohort: "generic", account: "umbrella.example", deliveredAt: "2022-11-12T10:01:00.000Z" });
  // E: this Monday morning, one first touch.
  await touch({ sentAt: "2022-11-14T08:00:00.000Z", template: "tpl-saas", cohort: "segment_routed", account: "initech.example" });
  // A reply sent from the mailbox is not outreach, and a message the ledger lost still counts as provider evidence.
  const replyContact = await insertContact(db);
  await ledgerSend({ contactId: replyContact.id, account: replyContact.accountKey, step: 0, path: "reply", provider: "gate-mailbox", sentAt: "2022-11-12T11:00:00.000Z" });
  await sentEvent(ESP, "lost-message", "2022-11-10T10:00:00.000Z");
  // A cold send recorded with no step: outreach, so it counts in delivery, but it is neither a first touch nor a follow-up.
  const unnumbered = await insertContact(db);
  await ledgerSend({ contactId: unnumbered.id, account: unnumbered.accountKey, step: null, path: "cold", sentAt: "2022-11-12T12:00:00.000Z" });

  // The holdout: five held on 20 October, one of whom wrote in interested on their own.
  for (let i = 0; i < 5; i++) {
    const c = await insertContact(db);
    await db.prepare("INSERT INTO outreach_holdout (contact_id, cohort, held_at) VALUES (?1, '2022-10-20', '2022-10-20T13:00:00.000Z')").bind(c.id).run();
    if (i === 0) await inbound(c.id, "2022-10-25T10:00:00.000Z", "interested");
  }

  // Spend and failed runs since Friday, and some outside it.
  const cost = (job: string | null, provider: string, micro: number, at: string) =>
    db.prepare("INSERT INTO cost_events (provider, capability, cost_micro_cents, job, created_at) VALUES (?1, 'call', ?2, ?3, ?4)").bind(provider, micro, job, at).run();
  await cost("replies_triage", "model", 300_000, "2022-11-12T09:00:00.000Z");
  await cost("cold_batch", "model", 120_000, "2022-11-11T13:00:00.000Z");
  await cost(null, ESP, 4_000, "2022-11-11T13:00:00.000Z");
  await cost("cold_batch", "model", 999_000, "2022-11-10T13:00:00.000Z");
  const run = (task: string, status: string, trigger: string, at: string) =>
    db.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(uid("run"), task, trigger, status, at).run();
  await run("sequence_sweep", "failed", "cron", "2022-11-12T08:30:00.000Z");
  await run("cold_batch", "failed", "rerun", "2022-11-13T13:00:00.000Z");
  await run("operator_chat", "failed", "chat", "2022-11-12T08:30:00.000Z");
  await run("cold_batch", "failed", "cron", "2022-11-10T13:00:00.000Z");

  // A reply owed for six hours, and a reply draft waiting for approval.
  const owed = await insertContact(db);
  await inbound(owed.id, "2022-11-14T06:00:00.000Z", "interested", "new");
  await db.prepare("INSERT INTO drafts (id, contact_id, kind, status) VALUES ('dr-gate-pending', ?1, 'reply', 'pending_approval')").bind(owed.id).run();
}

let scorecard: ScorecardData;

beforeAll(async () => {
  await seed();
  scorecard = await loadScorecard(db, flags, NOW);
});

describe("the daily scorecard", () => {
  it("shows exactly what the metric functions compute for its windows", async () => {
    const w = scorecardWindows(NOW);
    expect(scorecard.funnel).toEqual({ sends: await countSends(db, w.weekToDate), replies: await countReplies(db, w.weekToDate) });
    expect(scorecard.sends).toEqual({ day: await countSends(db, w.day), week: await countSends(db, w.week) });
    expect(scorecard.delivery).toEqual(await deliveryHealth(db, w.week));
    expect(scorecard.replies).toEqual({ day: await countReplies(db, w.day), week: await countReplies(db, w.week), depth: await replyDepth(db, w.week) });
    expect(scorecard.sla).toEqual({ owed: await replySla(db, NOW), answered: await replyResponseTimes(db, w.month) });
    expect(scorecard.spend).toEqual(await spendByJob(db, w.day));
    expect(scorecard.failed).toEqual(await failedJobs(db, w.day));
    expect(scorecard.cohorts).toEqual(await firstTouchOutcomesBy(db, w.month, "cohort"));
    expect(scorecard.health).toEqual(await measurementHealth(db, NOW));
  });

  it("shows the numbers the data set was built to produce", () => {
    expect(scorecard.windows.day).toEqual({ from: "2022-11-11T00:00:00.000Z", to: "2022-11-14T00:00:00.000Z" });
    expect(scorecard.funnel).toEqual({ sends: { firstTouches: 1, followUps: 0, unnumbered: 0 }, replies: { humanReplies: 0, positiveReplies: 0 } });
    expect(scorecard.sends).toEqual({ day: { firstTouches: 2, followUps: 2, unnumbered: 1 }, week: { firstTouches: 17, followUps: 2, unnumbered: 1 } });
    expect(scorecard.delivery).toEqual({ sends: 20, delivered: 18, hardBounces: 0, complaints: 1, hardBounceRate: 0, complaintRate: 1 / 18, deliveredCoverage: 18 / 20 });
    const week = scorecard.sends?.week;
    expect(week && week.firstTouches + week.followUps + week.unnumbered).toBe(scorecard.delivery?.sends);
    expect(scorecard.replies).toEqual({
      day: { humanReplies: 1, positiveReplies: 1 },
      week: { humanReplies: 3, positiveReplies: 1 },
      depth: [
        { step: 1, humanReplies: 2 },
        { step: 2, humanReplies: 1 },
      ],
    });
    expect(scorecard.sla).toEqual({ owed: { waiting: 1, oldestHours: 6 }, answered: { answered: 1, medianHours: 3 } });
    expect(scorecard.spend).toEqual({ totalMicroCents: 424_000, jobs: [{ job: "replies_triage", microCents: 300_000 }, { job: "cold_batch", microCents: 120_000 }, { job: `provider:${ESP}`, microCents: 4_000 }] });
    expect(scorecard.failed).toEqual([{ job: "cold_batch", failures: 1 }, { job: "sequence_sweep", failures: 1 }]);
    expect(scorecard.cohorts).toEqual([
      { key: "generic", sends: 16, bounced: 0, humanReplies: 2, positiveReplies: 2 },
      { key: "segment_routed", sends: 6, bounced: 1, humanReplies: 2, positiveReplies: 1 },
      { key: "signalled", sends: 5, bounced: 0, humanReplies: 1, positiveReplies: 0 },
    ]);
    expect(scorecard.health).toMatchObject({ ledger: { evidence: 23, matched: 22 }, blocksReplyConclusions: false, blocksProductConclusions: false, reasons: [] });
    expect(scorecard.queue).toMatchObject({ pendingDrafts: [{ kind: "reply", drafts: 1 }], owedReplies: 1 });
    expect(scorecard.flagsOn).toEqual(["ops:daily_scorecard"]);
  });

  it("prints those numbers, says what is not measured yet, and flags what needs attention", () => {
    const text = renderScorecard(scorecard);
    expect(text).toContain("GTM scorecard for 2022-11-11 to 2022-11-13 (UTC)");
    expect(text).toContain("Week to date (from 2022-11-14): 1 first touch, 0 positive replies. Sign-ups, activations, new paying customers, meetings and quotas: not measured yet.");
    expect(text).toContain("Sends: 2 first touches, 2 follow-ups (7 days: 17 and 2); unnumbered: 1 (7 days: 1)");
    expect(text).toContain("Delivery, 7 days: 20 sends, 18 delivered, 0 hard bounces (0%), 1 complaint (5.5%); events cover 90%");
    expect(text).toContain("Replies: 1 human, 1 positive (7 days: 3 human, 1 positive); over 7 days, after step 1: 2, step 2: 1");
    expect(text).toContain("Reply SLA: 1 waiting over 4h, oldest 6h; median time to answer 3h over 30 days (1 answered)");
    expect(text).toContain("Spend: $0.42");
    expect(text).toContain("Failed jobs: 2");
    expect(text).toContain("Convert, 30 days: meetings booked and held, sign-ups, activations and paid: not measured yet");
    expect(text).toContain("Cohorts, first touches in 30 days (positive of sent): generic 2 of 16 (12.5%), segment_routed 1 of 6 (16.6%), signalled 0 of 5 (0%)");
    expect(text).toContain("Measurement: ok (the ledger holds 95.6% of 23 sent messages)");
    expect(text).toContain("Waiting on you: 1 draft pending approval (1 reply)");
    expect(text).toContain("Flags on: ops:daily_scorecard");
    expect(text).toContain("- complaints at 5.5% of delivered mail over 7 days, at or over 0.1%");
    expect(text).toContain("- delivery events cover 90% of sends, under 95%");
    expect(text).toContain("- 1 reply waiting on you past the 4h SLA");
    expect(text).toContain("- 2 failed job runs");
    expect(text).not.toMatch(/\b0 meetings\b|\b0 sign-ups\b/);
  });
});

describe("the funnel digest", () => {
  it("agrees with the metric functions and with the scorecard's 7-day numbers", async () => {
    const d = await loadFunnelDigest(db, NOW);
    const w = funnelWindows(NOW);
    expect(w.week).toEqual(scorecardWindows(NOW).week);
    expect(d.sends).toEqual(await countSends(db, w.week));
    expect(d.replies).toEqual(await countReplies(db, w.week));
    expect(d.delivery).toEqual(await deliveryHealth(db, w.week));
    expect(d.matured).toEqual(await maturedTotals(db, w.matured, NOW));
    // The digest's reply rate is the matured-samples definition: the same rows experiments judge on.
    const samples = await maturedSamples(db, w.matured, NOW);
    expect(d.matured).toEqual(samples.reduce((t, s) => ({ sends: t.sends + s.sends, humanReplies: t.humanReplies + s.humanReplies, positiveReplies: t.positiveReplies + s.positiveReplies }), { sends: 0, humanReplies: 0, positiveReplies: 0 }));
    expect(d.sends).toEqual(scorecard.sends?.week);
    expect(d.replies).toEqual(scorecard.replies?.week);
    expect(d.delivery).toEqual(scorecard.delivery);
    expect(d.holdout?.lift).toEqual(await holdoutLift(db, liftWindow(NOW), NOW, { measureSignups: false }));
    expect(d.matured).toEqual({ sends: 5, humanReplies: 2, positiveReplies: 1 });

    const text = renderFunnelDigest(d);
    expect(text).toContain("Funnel digest for 2022-11-07 to 2022-11-13 (UTC)");
    expect(text).toContain("Sends: 17 first touches, 2 follow-ups, 1 unnumbered");
    expect(text).toContain("Replies received: 3 human, 1 positive");
    expect(text).toContain("Matured reply rate, first touches sent 2022-10-28 to 2022-11-03 (not bounced, current template copy): 2 of 5 (40%) replied, 1 of 5 (20%) positive");
    expect(text).toContain("Holdout: positive reply lift +3.1 points (not sufficient: 5 held, 100 needed; 13 written to, 100 needed)");
    expect(text).toContain("Needs attention: nothing");
  });
});

describe("the conversion report", () => {
  it("agrees with the metric functions and with the scorecard's cohorts for the same window", async () => {
    const window = conversionWindow(NOW);
    expect(window).toEqual(scorecardWindows(NOW).month);
    const d = await loadConversionReport(db, window, NOW);
    const total = await firstTouchOutcomes(db, window);
    expect(d.total).toEqual(total);
    expect(d.total.sends).toBe((await countSends(db, window)).firstTouches);
    expect(d.total).toEqual({ sends: 27, bounced: 1, humanReplies: 5, positiveReplies: 3 });
    for (const dimension of OUTCOME_DIMENSIONS) {
      const shown = d.dimensions.find((x) => x.dimension === dimension)?.slices.map(({ dimension: _d, directional: _x, ...s }) => s);
      const expected = await firstTouchOutcomesBy(db, window, dimension);
      expect(new Set(shown?.map((s) => JSON.stringify(s))), dimension).toEqual(new Set(expected.map((s) => JSON.stringify(s))));
    }
    const cohorts = d.dimensions.find((x) => x.dimension === "cohort")?.slices ?? [];
    for (const c of scorecard.cohorts ?? []) expect(cohorts.find((s) => s.key === c.key)).toMatchObject(c);

    const text = renderConversionReport(d);
    expect(text).toContain("27 first touches: 1 bounced, 5 replied (18.5%), 3 positive (11.1%)");
    expect(text).toContain("No slice is named yet: none has 30 sends and a positive reply.");
    expect(text).toContain("- tpl-generic: 2 positive, 3 replied, of 21 sent, directional");
    expect(text).toContain("- tpl-saas: 1 positive, 2 replied, of 6 sent (1 bounced), directional");
    expect(text).toContain("- Quarantine for account_name: 1 positive, 2 replied, of 6 sent (1 bounced), directional");
    expect(text).not.toContain("Flaky builds at Globex");
  });
});

describe("the holdout lift report", () => {
  it("shows exactly holdoutLift for its window", async () => {
    const d = await loadHoldoutReport(db, NOW);
    expect(d.window).toEqual({ from: "2022-08-16T00:00:00.000Z", to: "2022-11-04T00:00:00.000Z" });
    expect(d.lift).toEqual(await holdoutLift(db, d.window, NOW, { measureSignups: false }));
    expect(d.lift.held).toMatchObject({ contacts: 5, positives: 1 });
    expect(d.lift.treated).toMatchObject({ contacts: 13, positives: 3 });
    const text = renderHoldoutReport(d);
    expect(text).toContain("Held out: 5 contacts, positive replies 1 of 5 (20%)");
    expect(text).toContain("Written to: 13 contacts, positive replies 3 of 13 (23%)");
    expect(text).toContain("Positive reply lift: +3.1 points (not sufficient: 5 held, 100 needed; 13 written to, 100 needed)");
    expect(text).toContain("Sign-up lift: not measured yet");
    expect(text).toContain("biases lift low");
  });
});

describe("the cost digest", () => {
  it("shows the scorecard's spend for the same day", async () => {
    const d = await loadCostDigest(db, NOW);
    expect(d.window).toEqual(scorecard.windows.day);
    expect(d.spend).toEqual(scorecard.spend);
    expect(renderCostDigest(d)).toContain("Spend for 2022-11-11 to 2022-11-13 (UTC): $0.42");
  });
});

describe("no report counts anything itself", () => {
  const sources = import.meta.glob<string>("../src/reports/*.ts", { query: "?raw", import: "default", eager: true });

  it("has no SQL and no database access in any report module", () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(8);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/\.(prepare|batch|first|run|exec|raw)\(|(?<!Promise)\.all\(|\bselect\s+[\w*(]|\bfrom\s+[a-z_]+\s+(where|join|group|order)\b|outreach_sends|cost_events|execution_runs|inbound_emails|funnel_events/i);
    }
  });

  it("takes every number in the reports from the metrics module", () => {
    for (const name of ["scorecard", "funnel", "conversion", "holdout", "cost"]) {
      const source = sources[`../src/reports/${name}.ts`] ?? "";
      expect(source, name).toMatch(/from "\.\.\/metrics\/index\.ts"/);
    }
  });
});
