// GTM-agents: holdout lift: what outreach changed, against contacts who got nothing.
//
// The cold batch holds a share of each day's picks out as a no-send control (outreach_holdout),
// drawn from the same ranked range as the contacts it writes to. Over a window of entry times:
//   - held: contacts held out in the window (held_at);
//   - treated: contacts whose first touch was sent in the window (their earliest one there),
//     leaving out anyone also in the holdout;
//   - positive: a positive reply from the contact (positive-reply.ts: interested, question or
//     referral, on mail that is a reply) received after the entry and within
//     ATTRIBUTION_WINDOW_DAYS of it. Both groups are measured from inbound mail the same way, so a
//     held contact who writes in on their own counts just as a treated one does;
//   - signed up: a sign-up (product.ts, the one definition) within SIGNUP_WINDOW_DAYS of the
//     entry. Measured only once product events exist; until then it is null, never a zero;
//   - lift: treated rate minus held rate, in absolute terms.
// A lift is sufficient only with MIN_HELD or more contacts in each group and healthy measurement. Spillover
// within an account (a held contact's colleague was written to and passed it on) makes the held
// group look better than no outreach, so lift reads low, never high.
import { ATTRIBUTION_WINDOW_DAYS } from "./attribution.ts";
import type { MeasurementHealth } from "./health.ts";
import { signupSql } from "./product.ts";
import { firstTouchSql, inboundPositiveSql, n } from "./sql.ts";
import type { MetricWindow } from "./window.ts";

/** A lift needs at least this many held contacts to be called sufficient. */
export const MIN_HELD = 100;
/** A sign-up counts when it came this many days after the entry, at most. */
export const SIGNUP_WINDOW_DAYS = 30;

export interface ArmOutcome {
  contacts: number;
  positives: number;
  /** positives / contacts, or null with no contacts. */
  positiveRate: number | null;
  /** Null until product events exist. */
  signups: number | null;
  signupRate: number | null;
}

export interface HoldoutLift {
  held: ArmOutcome;
  treated: ArmOutcome;
  /** treated.positiveRate - held.positiveRate, or null when either is unknown. */
  positiveLift: number | null;
  /** treated.signupRate - held.signupRate, or null when sign-ups are not measured. */
  signupLift: number | null;
}

const rate = (count: number, total: number): number | null => (total > 0 ? count / total : null);
const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

/**
 * Lift over contacts entering in the window, with outcomes up to `now`. With `measureSignups`
 * false (no product events yet), sign-ups are null. Throws on a database error.
 */
export async function holdoutLift(db: D1Database, window: MetricWindow, now: Date, options: { measureSignups: boolean }): Promise<HoldoutLift> {
  const at = now.toISOString();
  // ?1 window start, ?2 window end, ?3 now, ?4 attribution days, ?5 sign-up days.
  const outcome = (entry: string) => `
    SUM(CASE WHEN EXISTS (
      SELECT 1 FROM inbound_emails i
       WHERE i.contact_id = arm.contact_id AND ${inboundPositiveSql("i")}
         AND i.received_at > ${entry} AND i.received_at <= ?3
         AND i.received_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ${entry}, '+' || ?4 || ' days')) THEN 1 ELSE 0 END) AS positives,
    SUM(CASE WHEN EXISTS (
      SELECT 1 FROM funnel_events f
       WHERE f.contact_id = arm.contact_id AND ${signupSql("f")}
         AND f.occurred_at > ${entry} AND f.occurred_at <= ?3
         AND f.occurred_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ${entry}, '+' || ?5 || ' days')) THEN 1 ELSE 0 END) AS signups`;
  const [held, treated] = await db.batch<{ contacts: number | null; positives: number | null; signups: number | null }>([
    db
      .prepare(
        `SELECT COUNT(*) AS contacts, ${outcome("arm.entered_at")}
           FROM (SELECT oh.contact_id, oh.held_at AS entered_at FROM outreach_holdout oh WHERE oh.held_at >= ?1 AND oh.held_at < ?2) arm`,
      )
      .bind(window.from, window.to, at, ATTRIBUTION_WINDOW_DAYS, SIGNUP_WINDOW_DAYS),
    db
      .prepare(
        `SELECT COUNT(*) AS contacts, ${outcome("arm.entered_at")}
           FROM (SELECT os.contact_id, MIN(os.sent_at) AS entered_at FROM outreach_sends os
                  WHERE ${firstTouchSql("os")} AND os.contact_id IS NOT NULL AND os.sent_at >= ?1 AND os.sent_at < ?2
                    AND NOT EXISTS (SELECT 1 FROM outreach_holdout oh WHERE oh.contact_id = os.contact_id)
                  GROUP BY os.contact_id) arm`,
      )
      .bind(window.from, window.to, at, ATTRIBUTION_WINDOW_DAYS, SIGNUP_WINDOW_DAYS),
  ]);
  const arm = (row: { contacts: number | null; positives: number | null; signups: number | null } | undefined): ArmOutcome => {
    const contacts = n(row?.contacts);
    const positives = n(row?.positives);
    const signups = options.measureSignups ? n(row?.signups) : null;
    return { contacts, positives, positiveRate: rate(positives, contacts), signups, signupRate: signups === null ? null : rate(signups, contacts) };
  };
  const h = arm(held?.results[0]);
  const t = arm(treated?.results[0]);
  return { held: h, treated: t, positiveLift: diff(t.positiveRate, h.positiveRate), signupLift: diff(t.signupRate, h.signupRate) };
}

export interface LiftVerdict {
  /** The positive-reply lift may be read as a result. */
  positiveSufficient: boolean;
  /** The sign-up lift may be read as a result. */
  signupSufficient: boolean;
  /** Why not, for the operator. */
  reasons: string[];
}

/** Whether a lift may be read as a result: enough held contacts and healthy measurement. Pure. */
export function liftVerdict(lift: HoldoutLift, health: MeasurementHealth): LiftVerdict {
  const reasons: string[] = [];
  const enough = lift.held.contacts >= MIN_HELD && lift.treated.contacts >= MIN_HELD;
  if (lift.held.contacts < MIN_HELD) reasons.push(`${lift.held.contacts} held, ${MIN_HELD} needed`);
  if (lift.treated.contacts < MIN_HELD) reasons.push(`${lift.treated.contacts} written to, ${MIN_HELD} needed`);
  if (health.blocksReplyConclusions) reasons.push("measurement health blocks reply conclusions");
  const positiveSufficient = enough && !health.blocksReplyConclusions && lift.positiveLift !== null;
  const signupSufficient = enough && !health.blocksProductConclusions && lift.signupLift !== null;
  if (lift.signupLift !== null && health.blocksProductConclusions) reasons.push("measurement health blocks product conclusions");
  return { positiveSufficient, signupSufficient, reasons };
}
