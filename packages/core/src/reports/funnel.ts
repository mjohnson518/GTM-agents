// GTM-agents: the weekly funnel digest, Monday mornings.
//
// Over the seven full days before today (the scorecard's 7-day window): sends, replies received and
// delivery health. The reply rate is the matured one (maturedTotals: first touches sent 10 to 17 days
// ago, not bounced, from each template's current copy, exactly the rows experiments judge on),
// because a rate on yesterday's sends would read low for no reason. Two flags, each only at a volume of FUNNEL_MIN_VOLUME or more: a reply rate under 3%, and
// hard bounces over 2%. One line of holdout lift. The filter funnel: candidates rejected, left
// borderline or found to be duplicates over the same week, by reason code, with the sources and
// queries that lost the most. Every number is a metric function (metrics/).
import {
  DAY_MS,
  MATURITY_DAYS,
  countReplies,
  countSends,
  daysBefore,
  deliveryHealth,
  fullDaysBefore,
  maturedTotals,
  rejectionsByReason,
  replyRate,
  startOfUtcDay,
  windowLabel,
  type DeliveryHealth,
  type MetricWindow,
  type MaturedTotals,
  type RejectionCounts,
  type ReplyCounts,
  type SendCounts,
} from "../metrics/index.ts";
import { NOT_MEASURED, UNREADABLE, label, pct, plural, ratio } from "./format.ts";
import { liftLine, loadHoldoutReport, type HoldoutReportData } from "./holdout.ts";

/** Flags need at least this many sends behind them. */
export const FUNNEL_MIN_VOLUME = 50;
/** A reply rate under this is flagged. */
export const FUNNEL_REPLY_RATE_FLOOR = 0.03;
/** A hard bounce rate over this is flagged. */
export const FUNNEL_BOUNCE_RATE_CEILING = 0.02;
/** Source and query lines listed under the rejections, largest first. */
export const FUNNEL_REJECTION_SOURCES = 5;

export interface FunnelWindows {
  week: MetricWindow;
  /** First touches old enough for their whole sequence: sent MATURITY_DAYS to MATURITY_DAYS + 7 days ago. */
  matured: MetricWindow;
}

/** The digest's windows at `now`. Pure. */
export function funnelWindows(now: Date): FunnelWindows {
  return { week: fullDaysBefore(now, 7), matured: daysBefore(new Date(startOfUtcDay(now).getTime() - MATURITY_DAYS * DAY_MS), 7) };
}

export interface FunnelData {
  windows: FunnelWindows;
  sends: SendCounts | null;
  replies: ReplyCounts | null;
  delivery: DeliveryHealth | null;
  matured: MaturedTotals | null;
  holdout: HoldoutReportData | null;
  rejections: RejectionCounts | null;
}

async function section<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** Load every section. Never throws. */
export async function loadFunnelDigest(db: D1Database, now: Date): Promise<FunnelData> {
  const windows = funnelWindows(now);
  const [sends, replies, delivery, matured, holdout, rejections] = await Promise.all([
    section(() => countSends(db, windows.week)),
    section(() => countReplies(db, windows.week)),
    section(() => deliveryHealth(db, windows.week)),
    section(() => maturedTotals(db, windows.matured, now)),
    section(() => loadHoldoutReport(db, now)),
    section(() => rejectionsByReason(db, windows.week)),
  ]);
  return { windows, sends, replies, delivery, matured, holdout, rejections };
}

export interface FunnelFlags {
  replyRate: boolean;
  bounces: boolean;
}

/** Which thresholds the digest crosses. Pure. */
export function funnelFlags(d: FunnelData): FunnelFlags {
  const m = d.matured;
  const x = d.delivery;
  return {
    replyRate: m !== null && m.sends >= FUNNEL_MIN_VOLUME && (replyRate(m.humanReplies, m.sends) ?? 1) < FUNNEL_REPLY_RATE_FLOOR,
    bounces: x !== null && x.sends >= FUNNEL_MIN_VOLUME && x.hardBounceRate !== null && x.hardBounceRate > FUNNEL_BOUNCE_RATE_CEILING,
  };
}

/** Render the digest. Pure. */
export function renderFunnelDigest(d: FunnelData): string {
  const attention: string[] = [];
  const lines = [`Funnel digest for ${windowLabel(d.windows.week)} (UTC)`, ""];
  lines.push(
    d.sends
      ? `Sends: ${plural(d.sends.firstTouches, "first touch", "first touches")}, ${plural(d.sends.followUps, "follow-up", "follow-ups")}${d.sends.unnumbered > 0 ? `, ${d.sends.unnumbered} unnumbered` : ""}`
      : `Sends: ${UNREADABLE}`,
  );
  lines.push(d.replies ? `Replies received: ${d.replies.humanReplies} human, ${d.replies.positiveReplies} positive` : `Replies: ${UNREADABLE}`);
  if (d.delivery) {
    const x = d.delivery;
    lines.push(`Delivery: ${plural(x.sends, "send", "sends")}, ${x.delivered} delivered, hard bounces ${pct(x.hardBounceRate)}, complaints ${pct(x.complaintRate)}; events cover ${pct(x.deliveredCoverage)}`);
  } else lines.push(`Delivery: ${UNREADABLE}`);
  if (d.matured) {
    const m = d.matured;
    lines.push(
      m.sends === 0
        ? `Matured reply rate: no matured first touches were sent ${windowLabel(d.windows.matured)}, the most recent week old enough to judge`
        : `Matured reply rate, first touches sent ${windowLabel(d.windows.matured)} (not bounced, current template copy): ${ratio(m.humanReplies, m.sends)} replied, ${ratio(m.positiveReplies, m.sends)} positive`,
    );
  } else lines.push(`Reply rate: ${UNREADABLE}`);
  lines.push(d.holdout ? liftLine(d.holdout) : `Holdout: ${UNREADABLE}`);
  lines.push(`Meetings, sign-ups, activations and paid: ${NOT_MEASURED}.`);
  lines.push(...rejectionLines(d.rejections));

  const flags = funnelFlags(d);
  if (flags.replyRate && d.matured) attention.push(`reply rate ${pct(replyRate(d.matured.humanReplies, d.matured.sends))} is under ${pct(FUNNEL_REPLY_RATE_FLOOR)} (${d.matured.sends} matured first touches)`);
  if (flags.bounces && d.delivery) attention.push(`hard bounces at ${pct(d.delivery.hardBounceRate)} are over ${pct(FUNNEL_BOUNCE_RATE_CEILING)} (${d.delivery.sends} sends)`);
  for (const [name, value] of [["sends", d.sends], ["replies", d.replies], ["delivery", d.delivery], ["reply rate", d.matured], ["holdout", d.holdout], ["rejections", d.rejections]] as const) {
    if (value === null) attention.push(`the ${name} section ${UNREADABLE}`);
  }
  lines.push("", attention.length > 0 ? "Needs attention:" : "Needs attention: nothing");
  for (const a of attention) lines.push(`- ${a}`);
  return lines.join("\n");
}

/** The filter funnel lines: totals by reason, then the sources and queries that lost the most. Pure. */
function rejectionLines(r: RejectionCounts | null): string[] {
  if (!r) return [`Rejections: ${UNREADABLE}`];
  if (r.total === 0) return ["Rejections: no candidate was rejected, left borderline or found a duplicate"];
  const lines = [`Rejections: ${plural(r.total, "candidate", "candidates")}, by reason: ${r.byReason.map((x) => `${label(x.reason)} ${x.count}`).join(", ")}`];
  for (const x of r.bySource.slice(0, FUNNEL_REJECTION_SOURCES)) {
    const query = x.queryId === null ? "no query" : `query ${label(x.query ?? x.queryId)}`;
    lines.push(`- ${label(x.source)}, ${query}: ${x.count} ${label(x.reason)}`);
  }
  if (r.bySource.length > FUNNEL_REJECTION_SOURCES) lines.push(`- ${plural(r.bySource.length - FUNNEL_REJECTION_SOURCES, "more source line", "more source lines")} left out`);
  return lines;
}
