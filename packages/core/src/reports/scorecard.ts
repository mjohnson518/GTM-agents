// GTM-agents: the daily scorecard: one operator message with the numbers that say whether the loop
// is working. No model call; every number comes from a metric function (metrics/), so the scorecard
// can never disagree with another report about the same window.
//
// Windows, all ending at midnight UTC today unless they say otherwise:
//   - the day: since the previous report. Yesterday, or Friday to Sunday on a Monday, because the
//     job runs on weekdays;
//   - 7 days: the seven full days before today;
//   - 30 days: the thirty full days before today (cohorts, time to answer);
//   - week to date: Monday 00:00 UTC until now.
// Lines, in order: the week-to-date funnel; sends; delivery over 7 days, flagged at hard bounces of
// 2% or more, complaints of 0.1% or more, or delivered events covering under 95% of sends; replies
// and positives with how deep the sequence was; the reply SLA; spend per job; failed jobs; the
// convert stage; cohorts; measurement health; everything waiting on the operator; the flags that are
// on; then what needs attention. Meetings, sign-ups, activations, paid customers and quotas belong
// to later milestones, and their lines say "not measured yet", never a zero.
//
// Each section loads on its own: a failed read shows that section as "could not be read" and is
// listed under what needs attention, and the rest of the message still goes. Measurement health
// that cannot be read holds every conclusion (fail closed).
import { FLAGS } from "../flags/registry.ts";
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";
import {
  COMPLAINT_ALERT_RATE,
  HARD_BOUNCE_ALERT_RATE,
  MIN_DELIVERED_COVERAGE,
  REPLY_SLA_HOURS,
  countReplies,
  countSends,
  deliveryAlerts,
  deliveryHealth,
  failedJobs,
  firstTouchOutcomesBy,
  fullDaysBefore,
  measurementHealth,
  metricWindow,
  operatorQueue,
  replyDepth,
  replyResponseTimes,
  replySla,
  spendByJob,
  startOfUtcDay,
  unreadableHealth,
  weekToDate,
  windowLabel,
  DAY_MS,
  type DeliveryHealth,
  type JobFailures,
  type MeasurementHealth,
  type MetricWindow,
  type OperatorQueue,
  type OutcomeSlice,
  type ReplyCounts,
  type ReplyDepth,
  type ReplySla,
  type ResponseTimes,
  type SendCounts,
  type Spend,
} from "../metrics/index.ts";
import { NOT_MEASURED, UNREADABLE, dollars, fitMessage, label, pct, plural, ratio } from "./format.ts";

const MAX_JOB_LINES = 6;
const MAX_FAILED_LINES = 5;

export interface ScorecardWindows {
  /** Since the previous report. */
  day: MetricWindow;
  week: MetricWindow;
  month: MetricWindow;
  weekToDate: MetricWindow;
}

/** The previous report's span: yesterday, or Friday to Sunday on a Monday. Pure. */
export function reportDay(now: Date): MetricWindow {
  const today = startOfUtcDay(now);
  const days = today.getUTCDay() === 1 ? 3 : 1;
  return metricWindow(new Date(today.getTime() - days * DAY_MS), today);
}

/** Every window the scorecard reads. Pure. */
export function scorecardWindows(now: Date): ScorecardWindows {
  return { day: reportDay(now), week: fullDaysBefore(now, 7), month: fullDaysBefore(now, 30), weekToDate: weekToDate(now) };
}

export interface ScorecardData {
  windows: ScorecardWindows;
  /** Each section is null when it could not be read. */
  funnel: { sends: SendCounts; replies: ReplyCounts } | null;
  sends: { day: SendCounts; week: SendCounts } | null;
  delivery: DeliveryHealth | null;
  replies: { day: ReplyCounts; week: ReplyCounts; depth: ReplyDepth[] } | null;
  sla: { owed: ReplySla; answered: ResponseTimes } | null;
  spend: Spend | null;
  failed: JobFailures[] | null;
  cohorts: OutcomeSlice[] | null;
  /** Never null: health that cannot be read is a health that blocks. */
  health: MeasurementHealth;
  queue: OperatorQueue | null;
  flagsOn: string[] | null;
}

async function section<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** The boolean flags (no placeholders in the key) that are on. Throws when a flag cannot be read. */
export async function flagsOn(flags: FlagReader): Promise<string[]> {
  const keys = FLAGS.filter((f) => f.kind === "boolean" && !f.key.includes("<")).map((f) => f.key);
  const values = await Promise.all(keys.map((key) => flags.get(key)));
  return keys.filter((_, i) => isFlagOn(values[i] ?? null));
}

/** Load every section. Never throws. */
export async function loadScorecard(db: D1Database, flags: FlagReader, now: Date): Promise<ScorecardData> {
  const w = scorecardWindows(now);
  const [funnel, sends, delivery, replies, sla, spend, failed, cohorts, health, queue, on] = await Promise.all([
    section(async () => ({ sends: await countSends(db, w.weekToDate), replies: await countReplies(db, w.weekToDate) })),
    section(async () => ({ day: await countSends(db, w.day), week: await countSends(db, w.week) })),
    section(() => deliveryHealth(db, w.week)),
    section(async () => ({ day: await countReplies(db, w.day), week: await countReplies(db, w.week), depth: await replyDepth(db, w.week) })),
    section(async () => ({ owed: await replySla(db, now), answered: await replyResponseTimes(db, w.month) })),
    section(() => spendByJob(db, w.day)),
    section(() => failedJobs(db, w.day)),
    section(() => firstTouchOutcomesBy(db, w.month, "cohort")),
    section(() => measurementHealth(db, now)),
    section(() => operatorQueue(db, now)),
    section(() => flagsOn(flags)),
  ]);
  return { windows: w, funnel, sends, delivery, replies, sla, spend, failed, cohorts, health: health ?? unreadableHealth(), queue, flagsOn: on };
}

/** The measurement line, shared with the other reports. Pure. */
export function healthLine(h: MeasurementHealth): string {
  if (h.reasons.length > 0) return `Measurement: conclusions held (${h.reasons.join("; ")})`;
  const ledger = h.ledger?.coverage === null || h.ledger === null ? "too few sends in 7 days to judge ledger coverage" : `the ledger holds ${pct(h.ledger.coverage)} of ${h.ledger.evidence} sent messages`;
  return `Measurement: ok (${ledger})`;
}

/** Render the scorecard. Pure. */
export function renderScorecard(d: ScorecardData): string {
  const attention: string[] = [];
  const unreadable = (name: string) => attention.push(`the ${name} section ${UNREADABLE}`);
  const lines: string[] = [`GTM scorecard for ${windowLabel(d.windows.day)} (UTC)`, ""];

  if (d.funnel) {
    lines.push(
      `Week to date (from ${d.windows.weekToDate.from.slice(0, 10)}): ${plural(d.funnel.sends.firstTouches, "first touch", "first touches")}, ${plural(d.funnel.replies.positiveReplies, "positive reply", "positive replies")}. Sign-ups, activations, new paying customers, meetings and quotas: ${NOT_MEASURED}.`,
    );
  } else {
    lines.push(`Week to date: ${UNREADABLE}`);
    unreadable("week-to-date");
  }

  if (d.sends) {
    const unnumbered = d.sends.day.unnumbered + d.sends.week.unnumbered > 0 ? `; unnumbered: ${d.sends.day.unnumbered} (7 days: ${d.sends.week.unnumbered})` : "";
    lines.push(`Sends: ${plural(d.sends.day.firstTouches, "first touch", "first touches")}, ${plural(d.sends.day.followUps, "follow-up", "follow-ups")} (7 days: ${d.sends.week.firstTouches} and ${d.sends.week.followUps})${unnumbered}`);
  } else {
    lines.push(`Sends: ${UNREADABLE}`);
    unreadable("sends");
  }

  if (d.delivery) {
    const x = d.delivery;
    const alerts = deliveryAlerts(x);
    lines.push(
      x.sends === 0 && x.delivered === 0
        ? "Delivery, 7 days: no outreach sent"
        : `Delivery, 7 days: ${plural(x.sends, "send", "sends")}, ${x.delivered} delivered, ${plural(x.hardBounces, "hard bounce", "hard bounces")} (${pct(x.hardBounceRate)}), ${plural(x.complaints, "complaint", "complaints")} (${pct(x.complaintRate)}); events cover ${pct(x.deliveredCoverage)}`,
    );
    if (alerts.hardBounces) attention.push(`hard bounces at ${pct(x.hardBounceRate)} of sends over 7 days, at or over ${pct(HARD_BOUNCE_ALERT_RATE)}`);
    if (alerts.complaints) attention.push(`complaints at ${pct(x.complaintRate)} of delivered mail over 7 days, at or over ${pct(COMPLAINT_ALERT_RATE)}`);
    if (alerts.coverage) {
      attention.push(
        x.delivered === 0
          ? "no delivered events in 7 days: is the email provider's webhook arriving? The bounce and complaint rates cannot be trusted"
          : `delivery events cover ${pct(x.deliveredCoverage)} of sends, under ${pct(MIN_DELIVERED_COVERAGE)}: the bounce and complaint rates cannot be trusted`,
      );
    }
  } else {
    lines.push(`Delivery: ${UNREADABLE}`);
    unreadable("delivery");
  }

  if (d.replies) {
    const depth = d.replies.depth.length > 0 ? `; over 7 days, after step ${d.replies.depth.map((r) => `${r.step}: ${r.humanReplies}`).join(", step ")}` : "";
    lines.push(
      `Replies: ${d.replies.day.humanReplies} human, ${d.replies.day.positiveReplies} positive (7 days: ${d.replies.week.humanReplies} human, ${d.replies.week.positiveReplies} positive)${depth}`,
    );
  } else {
    lines.push(`Replies: ${UNREADABLE}`);
    unreadable("replies");
  }

  if (d.sla) {
    const owed = d.sla.owed;
    const answered = d.sla.answered.medianHours === null ? "none answered in 30 days" : `median time to answer ${d.sla.answered.medianHours}h over 30 days (${d.sla.answered.answered} answered)`;
    lines.push(`Reply SLA: ${owed.waiting} waiting over ${REPLY_SLA_HOURS}h${owed.waiting > 0 && owed.oldestHours !== null ? `, oldest ${owed.oldestHours}h` : ""}; ${answered}`);
    if (owed.waiting > 0) attention.push(`${plural(owed.waiting, "reply", "replies")} waiting on you past the ${REPLY_SLA_HOURS}h SLA (/replies lists them)`);
  } else {
    lines.push(`Reply SLA: ${UNREADABLE}`);
    unreadable("reply SLA");
  }

  if (d.spend) {
    lines.push(`Spend: ${dollars(d.spend.totalMicroCents)}`);
    for (const j of d.spend.jobs.slice(0, MAX_JOB_LINES)) lines.push(`  ${label(j.job)}: ${dollars(j.microCents)}`);
    if (d.spend.jobs.length > MAX_JOB_LINES) lines.push(`  and ${plural(d.spend.jobs.length - MAX_JOB_LINES, "more job", "more jobs")}`);
  } else {
    lines.push(`Spend: ${UNREADABLE}`);
    unreadable("spend");
  }

  if (d.failed) {
    const total = d.failed.reduce((sum, f) => sum + f.failures, 0);
    lines.push(`Failed jobs: ${total}`);
    for (const f of d.failed.slice(0, MAX_FAILED_LINES)) lines.push(`  ${label(f.job)}: ${f.failures}`);
    if (total > 0) attention.push(`${plural(total, "failed job run", "failed job runs")}`);
  } else {
    lines.push(`Failed jobs: ${UNREADABLE}`);
    unreadable("failed jobs");
  }

  lines.push(`Convert, 30 days: meetings booked and held, sign-ups, activations and paid: ${NOT_MEASURED}`);

  if (d.cohorts) {
    lines.push(
      d.cohorts.length === 0
        ? "Cohorts, first touches in 30 days: none sent"
        : `Cohorts, first touches in 30 days (positive of sent): ${d.cohorts.map((c) => `${label(c.key)} ${ratio(c.positiveReplies, c.sends)}`).join(", ")}`,
    );
  } else {
    lines.push(`Cohorts: ${UNREADABLE}`);
    unreadable("cohorts");
  }

  lines.push(healthLine(d.health));
  if (d.health.reasons.length > 0) attention.push("measurement is incomplete, so reply and product conclusions are held");

  if (d.queue) {
    const q = d.queue;
    const drafts = q.pendingDrafts.reduce((sum, p) => sum + p.drafts, 0);
    const byKind = q.pendingDrafts.length > 0 ? ` (${q.pendingDrafts.map((p) => `${p.drafts} ${label(p.kind)}`).join(", ")})` : "";
    lines.push(
      `Waiting on you: ${plural(drafts, "draft", "drafts")} pending approval${byKind}, ${plural(q.manifests.coldBatches, "cold batch", "cold batches")} and ${plural(q.manifests.sequences, "follow-up release", "follow-up releases")} to release, ${plural(q.owedReplies, "owed reply", "owed replies")}, ${plural(q.manualTouches, "manual touch", "manual touches")}`,
    );
  } else {
    lines.push(`Waiting on you: ${UNREADABLE}`);
    unreadable("waiting-on-you");
  }

  if (d.flagsOn) lines.push(`Flags on: ${d.flagsOn.length > 0 ? d.flagsOn.join(", ") : "none"}`);
  else {
    lines.push(`Flags on: ${UNREADABLE}`);
    unreadable("flags");
  }

  lines.push("", attention.length > 0 ? "Needs attention:" : "Needs attention: nothing");
  for (const a of attention) lines.push(`- ${a}`);
  return fitMessage(lines);
}
