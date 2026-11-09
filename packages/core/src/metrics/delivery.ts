// GTM-agents: delivery health for outreach (cold and sequence mail) over a report window, with the
// thresholds the reports flag at.
//
// The counts and the rates come from delivery-rates.ts, the one definition every bounce and
// complaint figure uses:
//   - sends: outreach sent in the window;
//   - delivered, hard bounces, complaints: delivery events that arrived in the window;
//   - hard bounce rate: hard bounces over sends (hardBounceRate), the rate the bounce monitor and
//     campaign readiness gate on. They read a trailing window ending now, the reports full UTC days,
//     so their windows can differ, never their definition;
//   - complaint rate: complaints over delivered mail (complaintRate), as the warm-up ramp counts it;
//   - delivered coverage: delivered plus hard-bounced over sends, the share the provider reported an
//     outcome for. Under 95%, events are missing (is the provider webhook arriving?) and the two rates
//     above cannot be trusted. A bounce is an outcome, so a high bounce rate never lowers coverage.
// Rates are null when their denominator is zero: no data is not a 0% rate.
import { BOUNCE_WARN_RATE } from "../sending/bounce-monitor.ts";
import { RAMP_MAX_COMPLAINT_RATE } from "../sending/ramp.ts";
import { complaintRate, deliveryCounts, hardBounceRate } from "./delivery-rates.ts";
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
  const counts = await deliveryCounts(db, window);
  return {
    ...counts,
    hardBounceRate: hardBounceRate(counts),
    complaintRate: complaintRate(counts),
    deliveredCoverage: counts.sends > 0 ? Math.min(1, (counts.delivered + counts.hardBounces) / counts.sends) : null,
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
