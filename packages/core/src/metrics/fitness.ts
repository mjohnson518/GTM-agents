// GTM-agents: the raw inputs of the daily fitness score, each with one definition, read from the
// same metrics every report uses. The scoring (weights, targets, the trend) lives in
// packages/core/src/learning/fitness.ts and reads only what this file returns.
//
// Windows end at `now` unless noted:
//   - first touches: matured first touches (sent at least MATURITY_DAYS ago) in the 30 days before
//     maturity, and their positive replies (firstTouchOutcomes);
//   - quality: quality-gate verdicts on drafts and replies in the last 7 days, and how many passed;
//   - review: the agent review's grades over the last 7 days, A 1.0 down to F 0.0;
//   - deals: open deals, and how many were updated in the last 14 days;
//   - meetings: meetings booked in the last 30 days (countMeetings) and first touches sent in the
//     same 30 days;
//   - runs: scheduled job runs finished in the last 24 hours, and how many failed;
//   - spend: today's spend so far, in cents (spendByJob);
//   - discovery: candidates created in the last 7 days that reached a decision, and how many were
//     promoted;
//   - product: sign-ups, activations and new paying customers in the last 28 days
//     (countProductOutcomes).
// Each read that fails returns null for its part, never a zero: an unreadable input is unknown.
import { countMeetings } from "./meetings.ts";
import { MICRO_CENTS_PER_CENT, spendByJob } from "./operations.ts";
import { firstTouchOutcomes, maturedBefore } from "./outreach.ts";
import { countProductOutcomes } from "./product.ts";
import { n } from "./sql.ts";
import { DAY_MS, HOUR_MS, metricWindow, startOfUtcDay } from "./window.ts";

/** A grade's score: A is 1, F is 0. */
export const GRADE_SCORES: Readonly<Record<string, number>> = Object.freeze({ A: 1, B: 0.75, C: 0.5, D: 0.25, F: 0 });

export interface FitnessInputs {
  firstTouches: { sends: number; positiveReplies: number } | null;
  quality: { checked: number; passed: number } | null;
  review: { days: number; meanGrade: number | null } | null;
  deals: { open: number; fresh: number } | null;
  meetings: { booked: number; sends: number } | null;
  runs: { finished: number; failed: number } | null;
  spend: { todayCents: number } | null;
  discovery: { decided: number; promoted: number } | null;
  product: { signups: number; activations: number; newPaying: number } | null;
}

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Every fitness input as of `now`. Never throws: a part that cannot be read is null. */
export async function fitnessInputs(db: D1Database, now: Date): Promise<FitnessInputs> {
  const t = now.getTime();
  const matured = new Date(maturedBefore(now));
  const iso = (ms: number) => new Date(ms).toISOString();
  const [firstTouches, quality, review, deals, meetings, runs, spend, discovery, product] = await Promise.all([
    orNull(async () => {
      const c = await firstTouchOutcomes(db, metricWindow(new Date(matured.getTime() - 30 * DAY_MS), matured));
      return { sends: c.sends, positiveReplies: c.positiveReplies };
    }),
    orNull(async () => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS checked, SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END) AS passed
             FROM quality_checks WHERE subject_type IN ('draft', 'reply', 'followup') AND created_at >= ?1 AND created_at < ?2`,
        )
        .bind(iso(t - 7 * DAY_MS), iso(t))
        .first<{ checked: number | null; passed: number | null }>();
      return { checked: n(row?.checked), passed: n(row?.passed) };
    }),
    orNull(async () => {
      const { results } = await db
        .prepare("SELECT grade FROM agent_reviews WHERE day >= ?1 AND day < ?2")
        .bind(iso(t - 7 * DAY_MS).slice(0, 10), iso(t + DAY_MS).slice(0, 10))
        .all<{ grade: string }>();
      const scores = results.map((r) => GRADE_SCORES[r.grade]).filter((s): s is number => typeof s === "number");
      return { days: scores.length, meanGrade: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null };
    }),
    orNull(async () => {
      const row = await db
        .prepare("SELECT COUNT(*) AS open, SUM(CASE WHEN updated_at >= ?1 THEN 1 ELSE 0 END) AS fresh FROM deals WHERE stage NOT IN ('closed_won', 'closed_lost')")
        .bind(iso(t - 14 * DAY_MS))
        .first<{ open: number | null; fresh: number | null }>();
      return { open: n(row?.open), fresh: n(row?.fresh) };
    }),
    orNull(async () => {
      const window = metricWindow(new Date(t - 30 * DAY_MS), now);
      const [m, sent] = await Promise.all([countMeetings(db, window), firstTouchOutcomes(db, window)]);
      return { booked: m.booked, sends: sent.sends };
    }),
    orNull(async () => {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS finished, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM execution_runs
            WHERE status IN ('completed', 'failed') AND trigger IN ('cron', 'rerun', 'manual') AND started_at >= ?1 AND started_at < ?2`,
        )
        .bind(iso(t - 24 * HOUR_MS), iso(t))
        .first<{ finished: number | null; failed: number | null }>();
      return { finished: n(row?.finished), failed: n(row?.failed) };
    }),
    orNull(async () => {
      const s = await spendByJob(db, metricWindow(startOfUtcDay(now), now));
      return { todayCents: s.totalMicroCents / MICRO_CENTS_PER_CENT };
    }),
    orNull(async () => {
      const row = await db
        .prepare(
          `SELECT SUM(CASE WHEN status IN ('qualified', 'borderline', 'rejected', 'promoted') THEN 1 ELSE 0 END) AS decided,
                  SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END) AS promoted
             FROM candidates WHERE created_at >= ?1 AND created_at < ?2`,
        )
        .bind(iso(t - 7 * DAY_MS), iso(t))
        .first<{ decided: number | null; promoted: number | null }>();
      return { decided: n(row?.decided), promoted: n(row?.promoted) };
    }),
    orNull(async () => {
      const c = await countProductOutcomes(db, metricWindow(new Date(t - 28 * DAY_MS), now));
      return { signups: c.signups, activations: c.activations, newPaying: c.newPaying };
    }),
  ]);
  return { firstTouches, quality, review, deals, meetings, runs, spend, discovery, product };
}
