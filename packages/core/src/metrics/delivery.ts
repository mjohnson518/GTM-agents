// GTM-agents: delivery health for outreach (cold and sequence mail) over a window, from the send
// ledger, the way the bounce monitor and the warm-up ramp read it.
//
//   - sends: outreach sent in the window;
//   - delivered, hard bounces, complaints: delivery events that arrived in the window, from the
//     ledger's delivered_at, bounced_at and complained_at (the provider webhook sets them; only a
//     hard bounce sets bounced_at);
//   - hard bounce rate: hard bounces over sends, the bounce monitor's definition (the monitor reads
//     a rolling window ending now, the reports full UTC days, so their windows can differ);
//   - complaint rate: complaints over delivered mail, as the ramp counts it;
//   - delivered coverage: delivered plus hard-bounced over sends, the share the provider reported an
//     outcome for. Under 95%, events are missing (is the provider webhook arriving?) and the two rates
//     above cannot be trusted. A bounce is an outcome, so a high bounce rate never lowers coverage.
// Rates are null when their denominator is zero: no data is not a 0% rate.
import { BOUNCE_WARN_RATE } from "../sending/bounce-monitor.ts";
import { RAMP_MAX_COMPLAINT_RATE } from "../sending/ramp.ts";
import { n, outreachSql } from "./sql.ts";
import type { MetricWindow } from "./window.ts";

/** Flag hard bounces at or above this share of sends. The bounce monitor warns at the same rate. */
export const HARD_BOUNCE_ALERT_RATE = BOUNCE_WARN_RATE;
/** Flag complaints at or above this share of delivered mail. The ramp will not advance past it. */
export const COMPLAINT_ALERT_RATE = RAMP_MAX_COMPLAINT_RATE;
/** Delivered events must cover at least this share of sends for the rates to be trusted. */
export const MIN_DELIVERED_COVERAGE = 0.95;

export interface DeliveryHealth {
  sends: number;
  delivered: number;
  hardBounces: number;
  complaints: number;
  /** hardBounces / sends, or null with no sends. */
  hardBounceRate: number | null;
  /** complaints / delivered, or null with nothing delivered. */
  complaintRate: number | null;
  /** (delivered + hardBounces) / sends (at most 1): the share of sends the provider reported an outcome for. Null with no sends. */
  deliveredCoverage: number | null;
}

/** Delivery health for outreach in the window. Throws on a database error. */
export async function deliveryHealth(db: D1Database, window: MetricWindow): Promise<DeliveryHealth> {
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
  const sends = n(row?.sends);
  const delivered = n(row?.delivered);
  const hardBounces = n(row?.bounced);
  const complaints = n(row?.complained);
  return {
    sends,
    delivered,
    hardBounces,
    complaints,
    hardBounceRate: sends > 0 ? hardBounces / sends : null,
    complaintRate: delivered > 0 ? complaints / delivered : null,
    deliveredCoverage: sends > 0 ? Math.min(1, (delivered + hardBounces) / sends) : null,
  };
}

export interface DeliveryAlerts {
  hardBounces: boolean;
  complaints: boolean;
  /** Delivered events cover under MIN_DELIVERED_COVERAGE of sends. */
  coverage: boolean;
}

/** Which delivery thresholds the health crosses. Pure. */
export function deliveryAlerts(h: DeliveryHealth): DeliveryAlerts {
  return {
    hardBounces: h.hardBounceRate !== null && h.hardBounceRate >= HARD_BOUNCE_ALERT_RATE,
    complaints: h.complaintRate !== null && h.complaintRate >= COMPLAINT_ALERT_RATE,
    coverage: h.deliveredCoverage !== null && h.deliveredCoverage < MIN_DELIVERED_COVERAGE,
  };
}
