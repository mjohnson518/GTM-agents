// GTM-agents: the one definition of each product outcome: sign-ups, activations, new paying
// customers, and monthly recurring revenue.
//
//   - A sign-up, an activation and a new paying customer are each a funnel event (funnel_events)
//     the lifecycle module writes, at most once per contact for each, the first time the contact
//     enters signed_up, activated, or a paying state (paying or expanding). A second activation
//     after a stall, an upgrade, a recovery from at risk or a returning churned customer is never a
//     new outcome. Only the product bridge (source "product") and the billing webhook (source
//     "webhook") write them. Funnel rows outlive an erased contact (their contact_id is cleared), so
//     counts stay honest after an erasure.
//   - First-touch attribution, the same rule a reply follows (attribution.ts): the outcome is
//     credited to the contact's latest first touch (step 1 on the cold or sequence path) sent in the
//     ATTRIBUTION_WINDOW_DAYS before it. The lifecycle module looks it up when it writes the funnel
//     row (firstTouchForOutcome) and records the send in the row's metadata, so the credit survives
//     an erasure. An outcome with no such send counts, but not as "from outreach".
//   - Experiment credit: the outcome also records the experiment arm of the last send the contact
//     received in the same window (experimentArmForOutcome): recording only, once per contact and
//     outcome, because the funnel row is.
//   - Monthly recurring revenue is the sum of contact_lifecycle.mrr_cents over contacts in a
//     paying state (paying, expanding, at_risk), and paying customers is how many there are.
// Every function throws on a database error, so a report shows the section as unreadable, never a
// zero.
import { PAYING_STATES } from "../lifecycle/states.ts";
import { ATTRIBUTION_WINDOW_DAYS } from "./attribution.ts";
import { firstTouchSql, n, sqlList } from "./sql.ts";
import { DAY_MS, type MetricWindow } from "./window.ts";

/** The funnel event types that are product outcomes. */
export const PRODUCT_OUTCOMES = ["signed_up", "activated", "subscribed"] as const;
export type ProductOutcome = (typeof PRODUCT_OUTCOMES)[number];

/** The funnel sources a product outcome may come from: the product bridge and the billing webhook. */
export const PRODUCT_OUTCOME_SOURCES: readonly string[] = Object.freeze(["product", "webhook"]);

function alias(a: string): string {
  if (!/^[a-z]{1,8}$/.test(a)) throw new Error(`"${a}" is not a table alias`);
  return a;
}

/** A funnel row (alias `a`) that is this product outcome. */
export const productOutcomeSql = (a: string, outcome: ProductOutcome): string => {
  if (!(PRODUCT_OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`"${outcome}" is not a product outcome`);
  return `(${alias(a)}.event_type = '${outcome}' AND ${alias(a)}.source IN (${sqlList(PRODUCT_OUTCOME_SOURCES)}))`;
};

/** A sign-up (funnel row, alias `a`). Holdout lift reads sign-ups through this. */
export const signupSql = (a: string): string => productOutcomeSql(a, "signed_up");

export interface ProductOutcomeCounts {
  signups: number;
  activations: number;
  newPaying: number;
  /** Of those, how many were credited to a first touch. */
  fromOutreach: { signups: number; activations: number; newPaying: number };
}

/** Sign-ups, activations and new paying customers that occurred in the window. */
export async function countProductOutcomes(db: D1Database, window: MetricWindow): Promise<ProductOutcomeCounts> {
  const credited = "json_valid(f.metadata) AND json_extract(f.metadata, '$.first_touch') IS NOT NULL";
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN ${productOutcomeSql("f", "signed_up")} THEN 1 ELSE 0 END) AS signups,
              SUM(CASE WHEN ${productOutcomeSql("f", "activated")} THEN 1 ELSE 0 END) AS activations,
              SUM(CASE WHEN ${productOutcomeSql("f", "subscribed")} THEN 1 ELSE 0 END) AS paying,
              SUM(CASE WHEN ${productOutcomeSql("f", "signed_up")} AND ${credited} THEN 1 ELSE 0 END) AS signups_credited,
              SUM(CASE WHEN ${productOutcomeSql("f", "activated")} AND ${credited} THEN 1 ELSE 0 END) AS activations_credited,
              SUM(CASE WHEN ${productOutcomeSql("f", "subscribed")} AND ${credited} THEN 1 ELSE 0 END) AS paying_credited
         FROM funnel_events f
        WHERE f.event_type IN (${sqlList(PRODUCT_OUTCOMES)}) AND f.occurred_at >= ?1 AND f.occurred_at < ?2`,
    )
    .bind(window.from, window.to)
    .first<Record<string, number | null>>();
  return {
    signups: n(row?.signups),
    activations: n(row?.activations),
    newPaying: n(row?.paying),
    fromOutreach: { signups: n(row?.signups_credited), activations: n(row?.activations_credited), newPaying: n(row?.paying_credited) },
  };
}

export interface FirstTouchCredit {
  sendId: string;
  campaignId: string | null;
  templateId: string | null;
}

/** The first touch an outcome at `at` is credited to, or null. */
export async function firstTouchForOutcome(db: D1Database, contactId: string, at: string): Promise<FirstTouchCredit | null> {
  const since = new Date(Date.parse(at) - ATTRIBUTION_WINDOW_DAYS * DAY_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT os.id, os.campaign_id, os.template_id FROM outreach_sends os
        WHERE os.contact_id = ?1 AND ${firstTouchSql("os")} AND os.sent_at <= ?2 AND os.sent_at > ?3
        ORDER BY os.sent_at DESC LIMIT 1`,
    )
    .bind(contactId, at, since)
    .first<{ id: string; campaign_id: string | null; template_id: string | null }>();
  return row ? { sendId: row.id, campaignId: row.campaign_id, templateId: row.template_id } : null;
}

/** The experiment arm of the last send the contact received in the attribution window before `at`, or null. */
export async function experimentArmForOutcome(db: D1Database, contactId: string, at: string): Promise<{ experimentId: string; arm: string } | null> {
  const since = new Date(Date.parse(at) - ATTRIBUTION_WINDOW_DAYS * DAY_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT os.experiment_id, os.experiment_arm FROM outreach_sends os
        WHERE os.contact_id = ?1 AND os.experiment_id IS NOT NULL AND os.experiment_arm IS NOT NULL AND os.sent_at <= ?2 AND os.sent_at > ?3
        ORDER BY os.sent_at DESC LIMIT 1`,
    )
    .bind(contactId, at, since)
    .first<{ experiment_id: string; experiment_arm: string }>();
  return row ? { experimentId: row.experiment_id, arm: row.experiment_arm } : null;
}

export interface Mrr {
  mrrCents: number;
  paying: number;
}

/** Monthly recurring revenue now: the sum over contacts in a paying state, and how many there are. */
export async function currentMrr(db: D1Database): Promise<Mrr> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(mrr_cents), 0) AS mrr, COUNT(*) AS paying FROM contact_lifecycle WHERE state IN (${sqlList(PAYING_STATES)})`)
    .first<{ mrr: number | null; paying: number | null }>();
  return { mrrCents: n(row?.mrr), paying: n(row?.paying) };
}
