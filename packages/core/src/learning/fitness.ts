// GTM-agents: the daily fitness score: one weighted number for how well the system is doing, its
// seven dimensions, and their trends. No model call.
//
// Every input comes from packages/core/src/metrics/ (fitnessInputs); this file only scores them,
// each dimension from 0 to 1, or null when its data is missing or too thin:
//   outreach   0.20  the matured positive reply rate against the target, averaged with the quality
//                    gate's pass rate (whichever of the two is known)
//   research   0.10  the agent review's mean grade over the last 7 days
//   pipeline   0.10  open deals touched in 14 days, averaged with meetings booked per 100 first
//                    touches against the target
//   efficiency 0.10  job runs that did not fail, averaged with the share of today's spend limit left
//   discovery  0.15  candidates promoted among those decided in 7 days
//   activation 0.15  activations per sign-up against the target, only with 5 or more sign-ups
//   revenue    0.20  new paying customers in 28 days against the weekly target, only when the
//                    deployment sets one
// The composite is the weighted mean of the known dimensions. A trend is the least-squares slope of
// a dimension's daily scores; under MIN_TREND_POINTS days it is "insufficient".
import { readBudgetSettings } from "../budget/gate.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { DAY_MS, fitnessInputs, perHundred, replyRate, type FitnessInputs } from "../metrics/index.ts";

export const FITNESS_WEIGHTS = Object.freeze({ outreach: 0.2, research: 0.1, pipeline: 0.1, efficiency: 0.1, discovery: 0.15, activation: 0.15, revenue: 0.2 });
export type FitnessDimension = keyof typeof FITNESS_WEIGHTS;
export const FITNESS_DIMENSIONS = Object.keys(FITNESS_WEIGHTS) as FitnessDimension[];

export const MIN_ACTIVATION_SIGNUPS = 5;
export const MIN_TREND_POINTS = 3;
/** A slope (per day) beyond this is improving or declining. */
export const TREND_THRESHOLD = 0.02;

export interface FitnessTargets {
  /** The positive reply rate that scores 1. */
  positiveReplyRate: number;
  /** Meetings booked per 100 first touches that score 1. */
  meetingsPer100: number;
  /** The activation rate that scores 1. */
  activationRate: number;
  /** New paying customers a week that score 1; null leaves revenue unscored. */
  newPayingPerWeek: number | null;
}

export const DEFAULT_FITNESS_TARGETS: Readonly<FitnessTargets> = Object.freeze({ positiveReplyRate: 0.05, meetingsPer100: 2, activationRate: 0.4, newPayingPerWeek: null });

export type FitnessScores = Record<FitnessDimension, number | null>;

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const mean = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
};
const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

/** Score each dimension. Pure. */
export function scoreFitness(inputs: FitnessInputs, targets: FitnessTargets, dailyLimitCents: number | null): FitnessScores {
  const ft = inputs.firstTouches;
  const rate = ft && ft.sends >= 20 ? replyRate(ft.positiveReplies, ft.sends) : null;
  const replyScore = rate === null ? null : clamp(rate / targets.positiveReplyRate);
  const qualityScore = inputs.quality && inputs.quality.checked >= 5 ? clamp(inputs.quality.passed / inputs.quality.checked) : null;
  const freshness = inputs.deals && inputs.deals.open > 0 ? clamp(inputs.deals.fresh / inputs.deals.open) : null;
  const per100 = inputs.meetings && inputs.meetings.sends >= 20 ? perHundred(inputs.meetings.booked, inputs.meetings.sends) : null;
  const meetings = per100 === null ? null : clamp(per100 / targets.meetingsPer100);
  const runs = inputs.runs && inputs.runs.finished > 0 ? clamp(1 - inputs.runs.failed / inputs.runs.finished) : null;
  const headroom = inputs.spend && dailyLimitCents && dailyLimitCents > 0 ? clamp(1 - inputs.spend.todayCents / dailyLimitCents) : null;
  const p = inputs.product;
  return {
    outreach: round(mean([replyScore, qualityScore])),
    research: round(inputs.review?.meanGrade ?? null),
    pipeline: round(mean([freshness, meetings])),
    efficiency: round(mean([runs, headroom])),
    discovery: round(inputs.discovery && inputs.discovery.decided >= 5 ? clamp(inputs.discovery.promoted / inputs.discovery.decided) : null),
    activation: round(p && p.signups >= MIN_ACTIVATION_SIGNUPS ? clamp(p.activations / p.signups / targets.activationRate) : null),
    revenue: round(p && targets.newPayingPerWeek && targets.newPayingPerWeek > 0 ? clamp(p.newPaying / (targets.newPayingPerWeek * 4)) : null),
  };
}

/** The weighted mean of the known dimensions, or null when none is known. Pure. */
export function compositeScore(scores: FitnessScores): number | null {
  let weight = 0;
  let total = 0;
  for (const d of FITNESS_DIMENSIONS) {
    const s = scores[d];
    if (s === null) continue;
    weight += FITNESS_WEIGHTS[d];
    total += FITNESS_WEIGHTS[d] * s;
  }
  return weight > 0 ? Math.round((total / weight) * 1000) / 1000 : null;
}

/** The least-squares slope of equally spaced values. Pure. */
export function regressionSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  return den === 0 ? 0 : num / den;
}

export interface FitnessRunResult {
  day: string;
  composite: number | null;
  scores: FitnessScores;
}

/** Score today and store it (one row per day; a rerun replaces the day). Throws on a database error. */
export async function runFitness(deps: { db: D1Database; flags: FlagReader; now: Date; targets?: Partial<FitnessTargets> }): Promise<FitnessRunResult> {
  const targets = { ...DEFAULT_FITNESS_TARGETS, ...(deps.targets ?? {}) };
  const inputs = await fitnessInputs(deps.db, deps.now);
  let dailyLimit: number | null;
  try {
    dailyLimit = (await readBudgetSettings(deps.flags)).dailyLimitCents;
  } catch {
    dailyLimit = null;
  }
  const scores = scoreFitness(inputs, targets, dailyLimit);
  const composite = compositeScore(scores);
  const day = deps.now.toISOString().slice(0, 10);
  if (composite !== null) {
    await deps.db
      .prepare(
        `INSERT INTO fitness_scores (date, components, composite_score, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (date) DO UPDATE SET components = excluded.components, composite_score = excluded.composite_score`,
      )
      .bind(day, JSON.stringify({ scores, inputs, targets }), composite, deps.now.toISOString())
      .run();
  }
  return { day, composite, scores };
}

export interface FitnessTrendPoint {
  day: string;
  score: number | null;
  dimensions: Record<string, number | null>;
}

/**
 * The daily scores of the last `days` days, oldest first, one point per day (null on a day with no
 * score). This is the dashboard's `fitness.trend` result. Throws on a database error.
 */
export async function fitnessTrend(db: D1Database, now: Date, days = 30): Promise<FitnessTrendPoint[]> {
  const span = Math.max(1, Math.min(365, Math.floor(days)));
  const first = new Date(now.getTime() - (span - 1) * DAY_MS).toISOString().slice(0, 10);
  const { results } = await db
    .prepare("SELECT date, components, composite_score FROM fitness_scores WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC")
    .bind(first, now.toISOString().slice(0, 10))
    .all<{ date: string; components: string; composite_score: number }>();
  const byDay = new Map(results.map((r) => [r.date, r]));
  const out: FitnessTrendPoint[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(day);
    let dimensions: Record<string, number | null> = Object.fromEntries(FITNESS_DIMENSIONS.map((d) => [d, null]));
    if (row) {
      try {
        const parsed = JSON.parse(row.components) as { scores?: Record<string, unknown> };
        dimensions = Object.fromEntries(FITNESS_DIMENSIONS.map((d) => [d, typeof parsed.scores?.[d] === "number" ? parsed.scores[d] : null]));
      } catch {
        // A malformed row shows as unknown dimensions.
      }
    }
    out.push({ day, score: row ? row.composite_score : null, dimensions });
  }
  return out;
}

export type TrendDirection = "improving" | "declining" | "flat" | "insufficient";
export interface DimensionTrend {
  dimension: FitnessDimension;
  direction: TrendDirection;
  slope: number;
  points: number;
}

/** Each dimension's trend over the points given. Pure. */
export function dimensionTrends(points: readonly FitnessTrendPoint[]): DimensionTrend[] {
  return FITNESS_DIMENSIONS.map((dimension) => {
    const values = points.map((p) => p.dimensions[dimension]).filter((v): v is number => typeof v === "number");
    if (values.length < MIN_TREND_POINTS) return { dimension, direction: "insufficient" as const, slope: 0, points: values.length };
    const slope = Math.round(regressionSlope(values) * 10000) / 10000;
    return { dimension, direction: slope > TREND_THRESHOLD ? "improving" : slope < -TREND_THRESHOLD ? "declining" : "flat", slope, points: values.length };
  });
}
