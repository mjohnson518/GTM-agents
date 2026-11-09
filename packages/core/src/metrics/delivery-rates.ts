// GTM-agents: the one definition of each delivery rate, and the ledger counts every rate is taken from.
//
// Every bounce and complaint figure in the system comes from this file: the warm-up ramp, the bounce
// monitor, campaign readiness, the daily scorecard and the funnel digest. Thresholds are policy and
// stay with each caller; the numerator, the denominator and the window come from here, and a test
// fails the build if a module outside metrics/ counts bounces or divides by them itself.
//
// The counts (deliveryCounts) cover outreach, the cold and sequence paths, in a window:
//   - sends: outreach sent in the window (sent_at);
//   - delivered, hard bounces, complaints: delivery events that arrived in the window (delivered_at,
//     bounced_at, complained_at, which the provider webhook sets; only a hard bounce sets bounced_at).
// Events count by when they arrived, so a bounce that comes in today for a message sent last week
// counts today: a gate reacts to bounces as they arrive.
//
// Two bounce rates, because they answer different questions:
//   - hardBounceRate: hard bounces over sends. How much of what goes out bounces. The bounce monitor,
//     campaign readiness and the reports read it;
//   - hardBounceShareOfOutcomes: hard bounces over delivered plus hard-bounced mail. Of the mail the
//     provider reported an outcome for, how much bounced. The warm-up ramp reads it before it raises
//     volume, so mail whose outcome has not been reported yet never dilutes the rate it advances on.
// The complaint rate is complaints over delivered mail. A rate is null when its denominator is zero:
// no data is not a 0% rate.
//
// Windows. Reports read closed spans of full days ([from, to), window.ts). Gates read everything
// recorded since a point in time (sinceWindow, trailingDays), so an event written while a check runs,
// or stamped a moment ahead of the checking job's clock, still counts against it.
import { n, outreachSql } from "./sql.ts";
import { DAY_MS, metricWindow, type MetricWindow } from "./window.ts";

/** The open end of a gate window: later than any timestamp the system writes. */
const END_OF_TIME = new Date("9999-12-31T23:59:59.999Z");

/** Everything recorded at or after `start`: [start, end of time). What the gates read. */
export function sinceWindow(start: Date): MetricWindow {
  return metricWindow(start, END_OF_TIME);
}

/** The `days` before `now`, and anything recorded since: a gate's trailing window. */
export function trailingDays(now: Date, days: number): MetricWindow {
  return sinceWindow(new Date(now.getTime() - days * DAY_MS));
}

export interface DeliveryCounts {
  /** Outreach sent in the window. */
  sends: number;
  /** Delivered events that arrived in the window. */
  delivered: number;
  /** Hard bounce events that arrived in the window. */
  hardBounces: number;
  /** Complaint events that arrived in the window. */
  complaints: number;
}

/** Outreach sends and delivery events in the window, from the send ledger. Throws on a database error. */
export async function deliveryCounts(db: D1Database, window: MetricWindow): Promise<DeliveryCounts> {
  const inWindow = (column: string) => `(os.${column} >= ?1 AND os.${column} < ?2)`;
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN ${inWindow("sent_at")} THEN 1 ELSE 0 END) AS sends,
              SUM(CASE WHEN ${inWindow("delivered_at")} THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN ${inWindow("bounced_at")} THEN 1 ELSE 0 END) AS bounced,
              SUM(CASE WHEN ${inWindow("complained_at")} THEN 1 ELSE 0 END) AS complained
         FROM outreach_sends os
        WHERE ${outreachSql("os")}
          AND (${inWindow("sent_at")} OR ${inWindow("delivered_at")} OR ${inWindow("bounced_at")} OR ${inWindow("complained_at")})`,
    )
    .bind(window.from, window.to)
    .first<{ sends: number | null; delivered: number | null; bounced: number | null; complained: number | null }>();
  return { sends: n(row?.sends), delivered: n(row?.delivered), hardBounces: n(row?.bounced), complaints: n(row?.complained) };
}

/** The most delivered events on any one UTC day in the window, or 0. Throws on a database error. */
export async function peakDayDelivered(db: D1Database, window: MetricWindow): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS delivered FROM outreach_sends os
        WHERE ${outreachSql("os")} AND os.delivered_at >= ?1 AND os.delivered_at < ?2
        GROUP BY substr(os.delivered_at, 1, 10) ORDER BY delivered DESC LIMIT 1`,
    )
    .bind(window.from, window.to)
    .first<{ delivered: number | null }>();
  return n(row?.delivered);
}

/** Hard bounces over sends, or null with no sends. Pure. */
export function hardBounceRate(c: Pick<DeliveryCounts, "sends" | "hardBounces">): number | null {
  return c.sends > 0 ? c.hardBounces / c.sends : null;
}

/** Hard bounces over delivered plus hard-bounced mail, or null with neither. Pure. */
export function hardBounceShareOfOutcomes(c: Pick<DeliveryCounts, "delivered" | "hardBounces">): number | null {
  const outcomes = c.delivered + c.hardBounces;
  return outcomes > 0 ? c.hardBounces / outcomes : null;
}

/** Complaints over delivered mail, or null with nothing delivered. Pure. */
export function complaintRate(c: Pick<DeliveryCounts, "delivered" | "complaints">): number | null {
  return c.delivered > 0 ? c.complaints / c.delivered : null;
}
