// GTM-agents: the conversion report: what the last 30 days of first touches earned, sliced by
// template, subject, cohort, segment and persona.
//
// Every number is firstTouchOutcomesBy (metrics/) over the thirty full days before today, the same
// window and the same function the scorecard's cohort line uses, so the two always agree. A slice is
// the first touches sent in the window with that value, and what came of them by now: hard bounces,
// human replies and positive replies (the one definition in metrics/positive-reply.ts).
//
// It is honest about sample size. A slice under MIN_SLICE_SENDS sends is labelled directional and is
// never named the leader. Nothing is named while measurement health holds reply conclusions. The
// subject slice is the subject line as written in the template (or a subject test's variant), never
// a rendered subject, which would carry names from outside. The report reads and proposes nothing:
// targeting and copy changes stay with the operator.
import {
  MATURITY_DAYS,
  UNKNOWN_SLICE,
  OUTCOME_DIMENSIONS,
  firstTouchOutcomes,
  firstTouchOutcomesBy,
  fullDaysBefore,
  replyRate,
  measurementHealth,
  unreadableHealth,
  windowLabel,
  type MeasurementHealth,
  type MetricWindow,
  type OutcomeCounts,
  type OutcomeDimension,
  type OutcomeSlice,
} from "../metrics/index.ts";
import { NOT_MEASURED, fitMessage, label, pct, plural } from "./format.ts";

/** Under this many sends a slice is directional: shown, never named the leader. */
export const MIN_SLICE_SENDS = 30;
export const CONVERSION_DAYS = 30;
const SLICES_SHOWN = 5;
const SLICES_SHOWN_ONE_DIMENSION = 15;

export interface RankedSlice extends OutcomeSlice {
  dimension: OutcomeDimension;
  directional: boolean;
}

export interface ConversionData {
  window: MetricWindow;
  total: OutcomeCounts;
  /** Each requested dimension's slices, best first. */
  dimensions: Array<{ dimension: OutcomeDimension; slices: RankedSlice[] }>;
  health: MeasurementHealth;
}

/** The report's window at `now`: the thirty full days before today. Pure. */
export function conversionWindow(now: Date): MetricWindow {
  return fullDaysBefore(now, CONVERSION_DAYS);
}

// A slice with no sends has no rate: it ranks below any measured rate, a real 0% included.
const rate = (count: number, sends: number) => replyRate(count, sends) ?? -1;

/** Best first: positive rate, then human reply rate, then volume, then name. Pure. */
export function compareSlices(a: OutcomeSlice, b: OutcomeSlice): number {
  return (
    rate(b.positiveReplies, b.sends) - rate(a.positiveReplies, a.sends) ||
    rate(b.humanReplies, b.sends) - rate(a.humanReplies, a.sends) ||
    b.sends - a.sends ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** One dimension's slices, labelled directional or not, best first. Pure. */
export function rankSlices(dimension: OutcomeDimension, slices: readonly OutcomeSlice[]): RankedSlice[] {
  return slices.map((s) => ({ ...s, dimension, directional: s.sends < MIN_SLICE_SENDS })).sort(compareSlices);
}

/** Load the report for `window`, every dimension or just one. Throws on a database error. */
export async function loadConversionReport(db: D1Database, window: MetricWindow, now: Date, only?: OutcomeDimension): Promise<ConversionData> {
  const dimensions = only ? [only] : [...OUTCOME_DIMENSIONS];
  const total = await firstTouchOutcomes(db, window);
  const sliced = [];
  for (const dimension of dimensions) sliced.push({ dimension, slices: rankSlices(dimension, await firstTouchOutcomesBy(db, window, dimension)) });
  let health: MeasurementHealth;
  try {
    health = await measurementHealth(db, now);
  } catch {
    health = unreadableHealth();
  }
  return { window, total, dimensions: sliced, health };
}

/** The slice that may be named the leader: a known value with enough sends and a positive reply, healthy measurement; or null. Pure. */
export function leader(data: ConversionData): RankedSlice | null {
  if (data.health.blocksReplyConclusions) return null;
  const candidates = data.dimensions.flatMap((d) => d.slices).filter((s) => !s.directional && s.positiveReplies > 0 && s.key !== UNKNOWN_SLICE);
  return [...candidates].sort(compareSlices)[0] ?? null;
}

/** Render the report. Pure. */
export function renderConversionReport(data: ConversionData): string {
  const only = data.dimensions.length === 1 ? data.dimensions[0]?.dimension : undefined;
  const t = data.total;
  const lines = [`Conversion${only ? ` by ${only}` : ""}, first touches sent ${windowLabel(data.window)} (UTC)`, ""];
  if (t.sends === 0) {
    lines.push(`No first touches were sent in these ${CONVERSION_DAYS} days.`);
    return lines.join("\n");
  }
  lines.push(`${plural(t.sends, "first touch", "first touches")}: ${t.bounced} bounced, ${t.humanReplies} replied (${pct(rate(t.humanReplies, t.sends))}), ${t.positiveReplies} positive (${pct(rate(t.positiveReplies, t.sends))})`);
  const top = leader(data);
  if (data.health.blocksReplyConclusions) lines.push(`No slice is named: conclusions are held (${data.health.reasons.join("; ")}).`);
  else if (top) lines.push(`Leading: ${top.dimension} ${label(top.key)}, ${top.positiveReplies} positive of ${top.sends} sent (${pct(rate(top.positiveReplies, top.sends))}).`);
  else lines.push(`No slice is named yet: none has ${MIN_SLICE_SENDS} sends and a positive reply.`);
  for (const d of data.dimensions) {
    lines.push("", `By ${d.dimension}:`);
    for (const s of d.slices.slice(0, only ? SLICES_SHOWN_ONE_DIMENSION : SLICES_SHOWN)) {
      lines.push(`- ${label(s.key)}: ${s.positiveReplies} positive, ${s.humanReplies} replied, of ${s.sends} sent${s.bounced > 0 ? ` (${s.bounced} bounced)` : ""}${s.directional ? ", directional" : ""}`);
    }
    const hidden = d.slices.length - (only ? SLICES_SHOWN_ONE_DIMENSION : SLICES_SHOWN);
    if (hidden > 0) lines.push(`- and ${plural(hidden, "more slice", "more slices")}`);
  }
  lines.push(
    "",
    `Positive means interested, question or referral (meetings are ${NOT_MEASURED}). Opt-outs and automatic replies never count as replies. A slice under ${MIN_SLICE_SENDS} sends is directional. First touches younger than ${MATURITY_DAYS} days are still collecting replies. Segment and persona are as recorded today.`,
  );
  return fitMessage(lines);
}
