// GTM-agents: tests for delivery health, the reply SLA, spend, failed jobs and the operator's queue.
// Every row is synthetic, and each test works in its own days of 2022.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  COMPLAINT_ALERT_RATE,
  HARD_BOUNCE_ALERT_RATE,
  daysBefore,
  deliveryAlerts,
  deliveryHealth,
  failedJobs,
  median,
  metricWindow,
  operatorQueue,
  replyResponseTimes,
  replySla,
  spendByJob,
} from "../src/metrics/index.ts";
import { bounceWindow } from "../src/sending/bounce-monitor.ts";
import { uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function sends(count: number, row: { sentAt: string; path?: string; deliveredAt?: string | null; bouncedAt?: string | null; complainedAt?: string | null }): Promise<void> {
  const statement = db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sequence_step, sent_at, delivered_at, bounced_at, complained_at) VALUES (?1, ?2, 'test-ledger', 1, ?3, ?4, ?5, ?6)");
  const rows = Array.from({ length: count }, () => statement.bind(uid("os"), row.path ?? "cold", row.sentAt, row.deliveredAt ?? null, row.bouncedAt ?? null, row.complainedAt ?? null));
  for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
}

describe("delivery health", () => {
  it("reads sends by send time and events by event time, as the bounce monitor does", async () => {
    const now = new Date("2022-06-15T09:00:00.000Z");
    const t = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
    await sends(90, { sentAt: t(3), deliveredAt: t(3) });
    await sends(3, { sentAt: t(3), bouncedAt: t(3) });
    await sends(1, { sentAt: t(3), deliveredAt: t(3), complainedAt: t(2) });
    await sends(6, { sentAt: t(3) });
    await sends(4, { sentAt: t(9), bouncedAt: t(2) });
    await sends(5, { sentAt: t(3), path: "reply", deliveredAt: t(3) });
    const h = await deliveryHealth(db, daysBefore(now, 7));
    expect(h).toEqual({ sends: 100, delivered: 91, hardBounces: 7, complaints: 1, hardBounceRate: 0.07, complaintRate: 1 / 91, deliveredCoverage: 0.98 });
    const monitor = await bounceWindow(db, 7, now);
    expect([h.sends, h.hardBounces]).toEqual([monitor.sent, monitor.bounced]);
    // A bounce is an outcome the provider reported, so a high bounce rate never lowers coverage.
    expect(deliveryAlerts(h)).toEqual({ hardBounces: true, complaints: true, coverage: false });
  });

  it("flags at the thresholds, and gives no rate without a denominator", async () => {
    const empty = await deliveryHealth(db, metricWindow(new Date("2001-01-01T00:00:00.000Z"), new Date("2001-01-02T00:00:00.000Z")));
    expect(empty).toMatchObject({ sends: 0, hardBounceRate: null, complaintRate: null, deliveredCoverage: null });
    expect(deliveryAlerts(empty)).toEqual({ hardBounces: false, complaints: false, coverage: false });
    const at = { sends: 100, delivered: 1000, hardBounces: 2, complaints: 1, hardBounceRate: HARD_BOUNCE_ALERT_RATE, complaintRate: COMPLAINT_ALERT_RATE, deliveredCoverage: 0.95 };
    expect(deliveryAlerts(at)).toEqual({ hardBounces: true, complaints: true, coverage: false });
    expect(deliveryAlerts({ ...at, hardBounceRate: 0.0199, complaintRate: 0.00099, deliveredCoverage: 0.949 })).toEqual({ hardBounces: false, complaints: false, coverage: true });
  });
});

describe("the reply SLA", () => {
  const inbound = (receivedAt: string, extra: { intent?: string | null; status?: string; contactId?: string | null; classification?: string; draftId?: string | null } = {}) =>
    db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, intent, status, contact_id, classification, draft_id) VALUES (?1, 'test', ?2, 'someone@prospect.example', ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(uid("in"), uid("msg"), receivedAt, extra.intent === undefined ? "interested" : extra.intent, extra.status ?? "new", extra.contactId ?? null, extra.classification ?? "reply", extra.draftId ?? null)
      .run();

  it("counts owed replies older than 4 hours inside the reply clock's window, with the oldest's age", async () => {
    const now = new Date("2022-07-20T12:00:00.000Z");
    const ago = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();
    await inbound(ago(5));
    await inbound(ago(30), { intent: "question", status: "draft_created" });
    await inbound(ago(3));
    await inbound(ago(6), { status: "responded" });
    await inbound(ago(6), { intent: "auto_reply" });
    await inbound(ago(24 * 20));
    expect(await replySla(db, now)).toEqual({ waiting: 2, oldestHours: 30 });
    expect(await replySla(db, new Date("2001-01-01T00:00:00.000Z"))).toEqual({ waiting: 0, oldestHours: null });
  });

  it("takes the median hours to answer replies that needed a person", async () => {
    const b = "2022-08-01T00:00:00.000Z";
    const answer = async (hours: number, intent = "interested", status = "sent") => {
      const draft = uid("dr");
      const received = new Date(Date.parse(b) + DAY).toISOString();
      await db.prepare("INSERT INTO drafts (id, kind, status, sent_at) VALUES (?1, 'reply', ?2, ?3)").bind(draft, status, new Date(Date.parse(received) + hours * HOUR).toISOString()).run();
      await inbound(received, { intent, status: "responded", draftId: draft });
    };
    await answer(1);
    await answer(2);
    await answer(10, "question");
    await answer(50, "noise");
    await answer(3, "interested", "rejected");
    expect(await replyResponseTimes(db, daysBefore(new Date(Date.parse(b) + 7 * DAY), 7))).toEqual({ answered: 3, medianHours: 2 });
    expect(median([])).toBeNull();
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("spend and failed jobs", () => {
  it("adds spend per job, shows provider costs outside a job by provider, and counts only failed job runs", async () => {
    const b = "2022-09-05T00:00:00.000Z";
    const w = metricWindow(new Date(b), new Date(Date.parse(b) + DAY));
    const cost = (job: string | null, provider: string, micro: number, created = b) =>
      db.prepare("INSERT INTO cost_events (provider, capability, cost_micro_cents, job, created_at) VALUES (?1, 'call', ?2, ?3, ?4)").bind(provider, micro, job, created).run();
    await cost("replies_triage", "model", 800_000);
    await cost("replies_triage", "model", 200_000);
    await cost("cold_batch", "model", 400_000);
    await cost(null, "esp", 50_000);
    await cost("cold_batch", "model", 999_999, "2022-09-04T23:59:59.999Z");
    expect(await spendByJob(db, w)).toEqual({
      totalMicroCents: 1_450_000,
      jobs: [
        { job: "replies_triage", microCents: 1_000_000 },
        { job: "cold_batch", microCents: 400_000 },
        { job: "provider:esp", microCents: 50_000 },
      ],
    });

    const run = (task: string, status: string, trigger = "cron", started = new Date(Date.parse(b) + HOUR).toISOString()) =>
      db.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(uid("run"), task, trigger, status, started).run();
    await run("sequence_sweep", "failed");
    await run("sequence_sweep", "failed", "rerun");
    await run("cold_batch", "failed", "manual");
    await run("cold_batch", "completed");
    await run("operator_chat", "failed", "chat");
    await run("cold_batch", "failed", "cron", "2022-09-06T00:00:00.000Z");
    expect(await failedJobs(db, w)).toEqual([
      { job: "sequence_sweep", failures: 2 },
      { job: "cold_batch", failures: 1 },
    ]);
  });
});

describe("the operator's queue", () => {
  it("counts pending drafts by kind, releasable manifests, owed replies and open manual touches", async () => {
    const now = new Date("2022-10-10T12:00:00.000Z");
    const before = await operatorQueue(db, now);
    const campaign = uid("cb");
    await db.prepare("INSERT INTO campaigns (id, name) VALUES (?1, 'Cold batch')").bind(campaign).run();
    for (const [kind, status] of [["reply", "pending_approval"], ["reply", "pending_approval"], ["cold_intro", "pending_approval"], ["cold_intro", "rejected"]]) {
      await db.prepare("INSERT INTO drafts (id, kind, status) VALUES (?1, ?2, ?3)").bind(uid("d"), kind, status).run();
    }
    const manifest = (kind: string, created: string, released: string | null = null) =>
      db.prepare("INSERT INTO approval_manifests (id, campaign_id, code, entries, draft_count, kind, created_at, released_at) VALUES (?1, ?2, 'abc123', '{}', 1, ?3, ?4, ?5)").bind(uid("m"), campaign, kind, created, released).run();
    await manifest("cold_batch", new Date(now.getTime() - 2 * DAY).toISOString());
    await manifest("cold_batch", new Date(now.getTime() - 20 * DAY).toISOString());
    await manifest("cold_batch", new Date(now.getTime() - DAY).toISOString(), now.toISOString());
    await manifest("sequence", new Date(now.getTime() - 10 * HOUR).toISOString());
    await manifest("sequence", new Date(now.getTime() - 4 * DAY).toISOString());
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, intent, status) VALUES (?1, 'test', ?2, 'x@prospect.example', ?3, 'warm', 'notified')")
      .bind(uid("in"), uid("msg"), new Date(now.getTime() - HOUR).toISOString())
      .run();
    const after = await operatorQueue(db, now);
    const pending = (q: typeof after, kind: string) => q.pendingDrafts.find((p) => p.kind === kind)?.drafts ?? 0;
    expect(pending(after, "reply") - pending(before, "reply")).toBe(2);
    expect(pending(after, "cold_intro") - pending(before, "cold_intro")).toBe(1);
    expect(after.manifests).toEqual({ coldBatches: before.manifests.coldBatches + 1, sequences: before.manifests.sequences + 1 });
    expect(after.owedReplies - before.owedReplies).toBe(1);
  });
});
