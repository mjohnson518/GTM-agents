// GTM-agents: tests for promotion: the ladder, the cold batch's outcome gate from the one definition
// of each metric, eval coverage from the writer registry, and the weekly review that only proposes,
// at most once every 14 days. Every value is synthetic.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyEvidence, loadEvidence, recordDraftDecision, type ClassEvidence } from "../src/autonomy/evidence.ts";
import { PERMANENT_HUMAN } from "../src/autonomy/levels.ts";
import { AUTOMATIC_PATHS, decidePromotion, loadColdBatchOutcome, outcomeBlock, runAutonomyReview, type OutcomeEvidence } from "../src/autonomy/promotion.ts";
import { evalGap, OUTBOUND_WRITERS, writersFor } from "../src/autonomy/writers.ts";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/define-config.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["chat-1"], allowedUserIds: ["user-1"] } });
const NOW = new Date("2026-11-04T17:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const ev = (actionClass: string, fields: Partial<ClassEvidence>): ClassEvidence => ({ ...emptyEvidence(actionClass), ...fields });
const counts = (sends: number, positiveReplies: number, bounced = 0) => ({ sends, bounced, humanReplies: positiveReplies, positiveReplies });
/** Why the ladder declined, or "proposed". */
const why = (input: Parameters<typeof decidePromotion>[0]): string => {
  const decision = decidePromotion(input);
  return decision.propose ? "proposed" : decision.reason;
};
const goodOutcome: OutcomeEvidence = { recent: counts(220, 11, 2), baseline: counts(300, 12) };

async function events(actionClass: string, outcome: string, count: number, daysAgo = 5): Promise<void> {
  const statement = db.prepare("INSERT INTO autonomy_events (id, action_class, outcome, created_at) VALUES (?1, ?2, ?3, ?4)");
  const rows = Array.from({ length: count }, (_, i) => statement.bind(`ae-${actionClass}-${outcome}-${daysAgo}-${i}-${crypto.randomUUID().slice(0, 4)}`, actionClass, outcome, ago(daysAgo)));
  for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM autonomy_events"),
    db.prepare("DELETE FROM autonomy_level_changes"),
    db.prepare("DELETE FROM autonomy_proposals"),
    db.prepare("DELETE FROM outreach_sends"),
    db.prepare("DELETE FROM drafts"),
    db.prepare("DELETE FROM event_effects"),
  ]);
});

describe("the ladder", () => {
  it("proposes level 2 after 30 decisions in 60 days, 90% approved as written, at most 5% rejected, no recent incident", () => {
    expect(decidePromotion({ actionClass: "reply_send", level: 1, evidence: ev("reply_send", { approvedUnchanged: 28, approvedEdited: 1, rejected: 1 }) })).toMatchObject({ propose: true, from: 1, to: 2 });
    expect(why({ actionClass: "reply_send", level: 1, evidence: ev("reply_send", { approvedUnchanged: 29 }) })).toMatch(/30 needed/);
    expect(why({ actionClass: "reply_send", level: 1, evidence: ev("reply_send", { approvedUnchanged: 26, approvedEdited: 4 }) })).toMatch(/approved as written/);
    expect(why({ actionClass: "reply_send", level: 1, evidence: ev("reply_send", { approvedUnchanged: 37, rejected: 3 }) })).toMatch(/rejected/);
    expect(why({ actionClass: "reply_send", level: 1, evidence: ev("reply_send", { approvedUnchanged: 40, incidents: 1, incidentsRecent: 1 }) })).toMatch(/incidents/);
  });

  it("proposes level 3 after 60 automatic sends with no incident and no rejection in 60 days", () => {
    expect(decidePromotion({ actionClass: "reply_demo_link", level: 2, evidence: ev("reply_demo_link", { autoSent: 60 }) })).toMatchObject({ propose: true, from: 2, to: 3 });
    expect(decidePromotion({ actionClass: "reply_demo_link", level: 2, evidence: ev("reply_demo_link", { autoSent: 59 }) }).propose).toBe(false);
    expect(decidePromotion({ actionClass: "reply_demo_link", level: 2, evidence: ev("reply_demo_link", { autoSent: 80, rejected: 1 }) }).propose).toBe(false);
    expect(decidePromotion({ actionClass: "reply_demo_link", level: 2, evidence: ev("reply_demo_link", { autoSent: 80, incidents: 1 }) }).propose).toBe(false);
    expect(decidePromotion({ actionClass: "reply_demo_link", level: 3, evidence: ev("reply_demo_link", { autoSent: 500 }) }).propose).toBe(false);
  });

  it("needs four released batches and the outcome gate for the cold batch", () => {
    const four = ev("cold_batch", { approvedUnchanged: 4 });
    expect(decidePromotion({ actionClass: "cold_batch", level: 1, evidence: four, outcome: goodOutcome })).toMatchObject({ propose: true, to: 2 });
    expect(decidePromotion({ actionClass: "cold_batch", level: 1, evidence: ev("cold_batch", { approvedUnchanged: 3 }), outcome: goodOutcome }).propose).toBe(false);
    expect(why({ actionClass: "cold_batch", level: 1, evidence: four, outcome: null })).toMatch(/could not be read/);
  });

  it("never proposes a permanently human-only class, a class at 0, or one nothing acts on", () => {
    const lots = ev("x", { approvedUnchanged: 500, autoSent: 500 });
    for (const actionClass of PERMANENT_HUMAN) expect(decidePromotion({ actionClass, level: 1, evidence: { ...lots, actionClass } })).toMatchObject({ propose: false, reason: "permanently human-only" });
    expect(decidePromotion({ actionClass: "reply_send", level: 0, evidence: lots }).propose).toBe(false);
    expect(why({ actionClass: "post_meeting_followup", level: 1, evidence: lots })).toMatch(/nothing acts/);
  });
});

describe("the outcome gate", () => {
  it("compares matured first touches with the baseline, with 200 sends each and hard bounces under 2%", () => {
    expect(outcomeBlock(goodOutcome)).toBeNull();
    expect(outcomeBlock({ recent: counts(199, 20), baseline: counts(300, 1) })).toMatch(/too few/);
    expect(outcomeBlock({ recent: counts(200, 20, 4), baseline: counts(300, 1) })).toMatch(/hard bounce rate 2\.0%/);
    expect(outcomeBlock({ recent: counts(200, 9), baseline: counts(200, 10) })).toMatch(/below the baseline/);
    expect(outcomeBlock({ recent: counts(200, 10), baseline: counts(200, 10) })).toBeNull();
  });

  it("reads both windows from the send ledger", async () => {
    const statement = db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sequence_step, sent_at, bounced_at, positive_reply_at) VALUES (?1, 'cold', 'test-ledger', 1, ?2, ?3, ?4)");
    const rows: D1PreparedStatement[] = [];
    for (let i = 0; i < 210; i++) rows.push(statement.bind(`os-recent-${i}`, ago(20), i < 2 ? ago(19) : null, i < 12 ? ago(18) : null));
    for (let i = 0; i < 205; i++) rows.push(statement.bind(`os-base-${i}`, ago(80), null, i < 10 ? ago(79) : null));
    for (let i = 0; i < 30; i++) rows.push(statement.bind(`os-young-${i}`, ago(5), ago(4), null));
    for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
    const outcome = await loadColdBatchOutcome(db, NOW);
    expect(outcome.recent).toMatchObject({ sends: 210, bounced: 2, positiveReplies: 12 });
    expect(outcome.baseline).toMatchObject({ sends: 205, positiveReplies: 10 });
    expect(outcomeBlock(outcome)).toBeNull();
  });
});

describe("eval coverage", () => {
  it("lists a writer with an eval for every class something acts on", () => {
    for (const actionClass of Object.keys(AUTOMATIC_PATHS)) {
      expect(writersFor(actionClass).length, actionClass).toBeGreaterThan(0);
      expect(evalGap(actionClass), actionClass).toBeNull();
    }
  });

  it("blocks a class with no registered writer, or a writer without an eval", () => {
    expect(evalGap("ship_notification")).toMatch(/no outbound writer is registered/);
    expect(evalGap("other")).toMatch(/no eval covers operator-agent-drafts/);
    expect(new Set(OUTBOUND_WRITERS.map((w) => w.id)).size).toBe(OUTBOUND_WRITERS.length);
  });
});

describe("evidence", () => {
  it("counts every outcome per class over 60 days, incidents over 30 and 60", async () => {
    await events("reply_send", "approved_unchanged", 3);
    await events("reply_send", "approved_edited", 1);
    await events("reply_send", "rejected", 1, 70);
    await events("reply_send", "incident", 1, 40);
    await events("reply_send", "auto_sent", 2);
    const e = (await loadEvidence(db, NOW)).get("reply_send");
    expect(e).toMatchObject({ approvedUnchanged: 3, approvedEdited: 1, rejected: 0, autoSent: 2, incidents: 1, incidentsRecent: 0 });
  });

  it("records a person's decision on a meeting draft, once per content, and skips replies", async () => {
    await db
      .prepare(
        `INSERT INTO drafts (id, kind, recipient_email, subject, body, status, approved_digest, action_class) VALUES
          ('dr-recap', 'recap', 'jane@globex.example', 'Following up', 'Thanks for your time.', 'approved', ?1, 'post_meeting_followup'),
          ('dr-rebook', 'check_in', 'sam@globex.example', 'Finding another time', 'Would another time work?', 'rejected', NULL, 'rebook'),
          ('dr-reply', 'reply', 'kim@globex.example', 'Re: hi', 'Hello', 'approved', ?1, 'reply_send')`,
      )
      .bind("e".repeat(64))
      .run();
    await recordDraftDecision(db, "dr-recap", "approved", NOW);
    await recordDraftDecision(db, "dr-recap", "approved", NOW);
    await recordDraftDecision(db, "dr-rebook", "rejected", NOW);
    await recordDraftDecision(db, "dr-reply", "approved", NOW);
    const rows = (await db.prepare("SELECT action_class, outcome, subject_id FROM autonomy_events ORDER BY action_class").all()).results;
    expect(rows).toEqual([
      { action_class: "post_meeting_followup", outcome: "approved_unchanged", subject_id: "dr-recap" },
      { action_class: "rebook", outcome: "rejected", subject_id: "dr-rebook" },
    ]);
  });
});

describe("the weekly review", () => {
  it("proposes with the evidence and the command, and changes no level", async () => {
    await events("reply_send", "approved_unchanged", 30);
    const operator = recordingOperator();
    const kv = memoryKv();
    const result = await runAutonomyReview({ db, flags: { get: (k) => kv.get(k) }, config, operator: operator.channel, now: NOW, log: silentLogger });
    expect(result.proposals.map((p) => [p.actionClass, p.from, p.to, p.origin])).toEqual([["reply_send", 1, 2, "review"]]);
    expect(result.notified).toBe(true);
    expect(operator.messages[0]?.text).toMatch(/Propose reply_send level 1 to level 2: 30 decisions/);
    expect(operator.messages[0]?.text).toMatch(/autonomy-confirm-[0-9a-f]{10}-[0-9a-f]{6}/);
    expect(kv.map.size).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_level_changes").first()).toEqual({ n: 0 });
  });

  it("repeats the same proposal at most every 14 days", async () => {
    await events("reply_send", "approved_unchanged", 30);
    const flags = flagReader();
    expect((await runAutonomyReview({ db, flags, config, now: NOW })).proposals).toHaveLength(1);
    expect((await runAutonomyReview({ db, flags, config, now: new Date(NOW.getTime() + 7 * DAY) })).proposals).toHaveLength(0);
    expect((await runAutonomyReview({ db, flags, config, now: new Date(NOW.getTime() + 15 * DAY) })).proposals).toHaveLength(1);
  });

  it("withdraws a proposal the operator was never shown, so next week proposes it again", async () => {
    await events("reply_send", "approved_unchanged", 30);
    const operator = recordingOperator();
    operator.channel.notify = () => Promise.reject(new Error("channel down"));
    expect((await runAutonomyReview({ db, flags: flagReader(), config, operator: operator.channel, now: NOW })).proposals).toHaveLength(0);
    expect((await runAutonomyReview({ db, flags: flagReader(), config, now: new Date(NOW.getTime() + 7 * DAY) })).proposals).toHaveLength(1);
  });

  it("skips a class whose level cannot be read", async () => {
    await events("reply_send", "approved_unchanged", 30);
    const result = await runAutonomyReview({ db, flags: flagReader({}, ["autonomy:reply_send"]), config, now: NOW });
    expect(result.proposals).toHaveLength(0);
    expect(result.skipped.find((s) => s.actionClass === "reply_send")?.reason).toMatch(/could not be read/);
  });
});
