// GTM-agents: the holdout lift report: positive reply rate (and, once product events exist, sign-up
// rate) for contacts outreach wrote to against contacts the cold batch held out.
//
// The numbers are holdoutLift (metrics/) over contacts who entered between LIFT_LOOKBACK_DAYS and
// MATURITY_DAYS ago, so every one has had time to answer. The verdict is liftVerdict: sufficient only
// with 100 or more held contacts and healthy measurement. The report always says that spillover
// within accounts biases lift low.
import {
  DAY_MS,
  MATURITY_DAYS,
  MIN_HELD,
  holdoutLift,
  liftVerdict,
  measurementHealth,
  metricWindow,
  startOfUtcDay,
  unreadableHealth,
  windowLabel,
  type HoldoutLift,
  type LiftVerdict,
  type MeasurementHealth,
  type MetricWindow,
} from "../metrics/index.ts";
import { NOT_MEASURED, pct, ratio } from "./format.ts";

/** Contacts who entered at most this many days ago are compared. */
export const LIFT_LOOKBACK_DAYS = 90;

export interface HoldoutReportData {
  window: MetricWindow;
  lift: HoldoutLift;
  verdict: LiftVerdict;
  health: MeasurementHealth;
}

/** Entries between LIFT_LOOKBACK_DAYS and MATURITY_DAYS before today. Pure. */
export function liftWindow(now: Date): MetricWindow {
  const today = startOfUtcDay(now).getTime();
  return metricWindow(new Date(today - LIFT_LOOKBACK_DAYS * DAY_MS), new Date(today - MATURITY_DAYS * DAY_MS));
}

/** Load the lift and its verdict. Throws on a database error in the lift itself. */
export async function loadHoldoutReport(db: D1Database, now: Date, window: MetricWindow = liftWindow(now)): Promise<HoldoutReportData> {
  let health: MeasurementHealth;
  try {
    health = await measurementHealth(db, now);
  } catch {
    health = unreadableHealth();
  }
  const lift = await holdoutLift(db, window, now, { measureSignups: health.productEventsSeen === true });
  return { window, lift, verdict: liftVerdict(lift, health), health };
}

/** "+1.2 points", "-0.4 points", or "n/a". Pure. */
export function points(diff: number | null): string {
  if (diff === null || !Number.isFinite(diff)) return "n/a";
  const p = Math.round(diff * 1000) / 10;
  return `${p > 0 ? "+" : ""}${p.toFixed(1)} points`;
}

/** One line for the funnel digest. Pure. */
export function liftLine(d: HoldoutReportData): string {
  const verdict = d.verdict.positiveSufficient ? "sufficient" : `not sufficient: ${d.verdict.reasons.join("; ") || "no data"}`;
  return `Holdout: positive reply lift ${points(d.lift.positiveLift)} (${verdict})`;
}

/** Render the report. Pure. */
export function renderHoldoutReport(d: HoldoutReportData): string {
  const { held, treated } = d.lift;
  const lines = [
    `Holdout lift, contacts who entered ${windowLabel(d.window)} (UTC)`,
    "",
    `Held out: ${held.contacts} contacts, positive replies ${ratio(held.positives, held.contacts)}`,
    `Written to: ${treated.contacts} contacts, positive replies ${ratio(treated.positives, treated.contacts)}`,
    `Positive reply lift: ${points(d.lift.positiveLift)} (${d.verdict.positiveSufficient ? "sufficient" : `not sufficient: ${d.verdict.reasons.join("; ") || "no data"}`})`,
  ];
  if (held.signups === null || treated.signups === null) {
    lines.push(`Sign-up lift: ${NOT_MEASURED} (${d.health.productEventsSeen === null ? "whether product events exist could not be read" : "no product events yet"})`);
  } else {
    lines.push(
      `Sign-ups within 30 days: held ${pct(held.signupRate)}, written to ${pct(treated.signupRate)}; lift ${points(d.lift.signupLift)} (${d.verdict.signupSufficient ? "sufficient" : "not sufficient"})`,
    );
  }
  lines.push(
    "",
    `A lift is sufficient with ${MIN_HELD} or more contacts in each group and healthy measurement. Spillover within accounts (a held contact's colleague was written to and passed it on) biases lift low.`,
  );
  return lines.join("\n");
}
