// GTM-agents: the event spine's router for product events (source "product").
//
// For each event, re-read from the payload the webhook stored:
//   - user.deleted: the erasure (erasure.ts), tombstone first;
//   - custom.<name>: recorded only; no playbook subscribes to custom events yet;
//   - anything else: the person is resolved (identity.ts, tombstones first: an erased person is
//     refused and nothing is written), then moved by the lifecycle writer:
//       user.signed_up                signed_up, with the attribution (set once)
//       user.activated                activated (recovered, for an at-risk customer whose
//                                     subscription is still active)
//       usage.limit_reached           limit_reached (likewise recovered)
//       billing.subscribed            subscribed, MRR from the amount and interval, else the
//                                     plan's list price
//       billing.subscription_changed  canceled, payment_failed or recovered when the status says
//                                     so, else subscription_changed up or down by list price
//       billing.subscription_canceled canceled, MRR 0, the reason kept as an enum only
//       billing.payment_failed        payment_failed
//       org.created, billing.topup_purchased, org.api_key_created, feedback.submitted
//                                     no state change; fields and usage only
//     Any of these but user.signed_up proves the person has an account, so a contact still before
//     sign-up is signed up first (events can arrive out of order, and a user may predate the
//     bridge). feedback.submitted is filed for the ship loop as full-taint text.
// Product usage is kept on the person's own lifecycle row. Nothing here writes copy, and nothing
// reads one person's usage into anything sent to anyone else.
// A side effect that fails makes the route throw, so the spine retries it; every effect is claimed,
// so the retry repeats nothing that finished.
import type { LifecycleState } from "../data/enums.ts";
import { writeAudit } from "../events/audit.ts";
import { dropPayload, type EventRouter, type RouteContext, type StoredEvent } from "../events/spine.ts";
import { applyLifecycleEvent, type LifecyclePatch } from "../lifecycle/apply.ts";
import { cancelReason } from "../lifecycle/effects.ts";
import { LIFECYCLE_FLAGS } from "../lifecycle/flags.ts";
import type { LifecycleEvent } from "../lifecycle/states.ts";
import { readSwitch } from "../sending/flags.ts";
import { addressHash, normalizeAddress } from "../sending/suppression.ts";
import { listPrice, monthlyCents, planDirection, type PriceList } from "../billing/mrr.ts";
import { count, label, parseEnvelope, type ProductEnvelope } from "./envelope.ts";
import { eraseIfTombstoned, eraseProductUser } from "./erasure.ts";
import { fileFeedback } from "./feedback.ts";
import { resolveProductUser } from "./identity.ts";

export const PRODUCT_SOURCE = "product";

/** Types that prove the person already has an account in the product. */
const IMPLIES_ACCOUNT: ReadonlySet<string> = new Set([
  "org.created",
  "user.activated",
  "usage.limit_reached",
  "billing.subscribed",
  "billing.subscription_changed",
  "billing.subscription_canceled",
  "billing.payment_failed",
  "billing.topup_purchased",
  "org.api_key_created",
  "feedback.submitted",
]);

export interface ProductRouterOptions {
  /** Monthly list price in cents per plan name: the MRR fallback, and what makes a plan change an upgrade. */
  prices?: PriceList;
}

interface Row {
  state: LifecycleState | null;
  subscription_status: string | null;
}

const lower = (value: string | null) => value?.toLowerCase() ?? null;

/** The lifecycle event and fields one envelope calls for, given the person's row. Pure. */
export function productTransition(envelope: ProductEnvelope, row: Row, prices: PriceList | undefined): { event: LifecycleEvent | null; patch: LifecyclePatch; reason?: string } {
  const data = envelope.data;
  const activity = !envelope.type.startsWith("billing.");
  const patch: LifecyclePatch = {
    ...(envelope.user ? { product_user_id: envelope.user.id } : {}),
    ...(envelope.org ? { product_org_id: envelope.org.id, ...(label(envelope.org.plan_tier) ? { plan_tier: label(envelope.org.plan_tier) } : {}) } : {}),
    ...(activity ? { last_active_at: envelope.occurred_at } : {}),
  };
  const recovering = row.state === "at_risk" && lower(row.subscription_status) === "active";
  switch (envelope.type) {
    case "user.signed_up":
      return { event: { kind: "signed_up" }, patch: { ...patch, ...(label(data.plan) ? { plan_tier: label(data.plan) } : {}) } };
    case "org.created":
      return { event: null, patch: { ...patch, ...(label(data.plan) ? { plan_tier: label(data.plan) } : {}) } };
    case "user.activated": {
      const activations = count(data.count);
      const usage = { ...(label(data.event) ? { activation_event: label(data.event) as string } : {}), ...(activations !== null ? { activations } : {}) };
      return { event: recovering ? { kind: "recovered" } : { kind: "activated" }, patch: { ...patch, usage } };
    }
    case "usage.limit_reached": {
      const used = count(data.used);
      const usage = { ...(label(data.limit) ? { limit_name: label(data.limit) as string } : {}), ...(used !== null ? { limit_used: used } : {}), ...(label(data.period) ? { limit_period: label(data.period) as string } : {}) };
      return { event: recovering ? { kind: "recovered" } : { kind: "limit_reached" }, patch: { ...patch, usage } };
    }
    case "billing.subscribed": {
      const plan = label(data.plan);
      const mrr = monthlyCents(data.amount, data.interval) ?? listPrice(prices, plan);
      return { event: { kind: "subscribed" }, patch: { ...patch, ...(plan ? { plan_tier: plan } : {}), subscription_status: "active", ...(mrr !== null ? { mrr_cents: mrr } : {}) } };
    }
    case "billing.subscription_changed": {
      const to = label(data.to_plan);
      const status = lower(label(data.status));
      const mrr = listPrice(prices, to);
      const fields: LifecyclePatch = { ...patch, ...(to ? { plan_tier: to } : {}), ...(status ? { subscription_status: status } : {}) };
      if (status === "canceled" || status === "cancelled") return { event: { kind: "canceled" }, patch: { ...fields, subscription_status: "canceled", mrr_cents: 0 } };
      if (status === "past_due" || status === "unpaid") return { event: { kind: "payment_failed" }, patch: fields };
      const withMrr = { ...fields, ...(mrr !== null ? { mrr_cents: mrr } : {}) };
      const wasFailing = lower(row.subscription_status) === "past_due" || lower(row.subscription_status) === "unpaid";
      if ((status === "active" || status === "trialing") && row.state === "at_risk" && wasFailing) return { event: { kind: "recovered" }, patch: withMrr };
      const direction = planDirection(prices, label(data.from_plan), to);
      return { event: direction ? { kind: "subscription_changed", direction } : null, patch: withMrr };
    }
    case "billing.subscription_canceled":
      return { event: { kind: "canceled" }, patch: { ...patch, subscription_status: "canceled", mrr_cents: 0 }, reason: cancelReason(data.reason) };
    case "billing.payment_failed":
      return { event: { kind: "payment_failed" }, patch: { ...patch, subscription_status: "past_due" } };
    case "billing.topup_purchased":
      return { event: null, patch: { ...patch, usage: { ...(label(data.sku) ? { last_topup_sku: label(data.sku) as string } : {}), last_topup_at: envelope.occurred_at } } };
    case "org.api_key_created":
      return { event: null, patch: { ...patch, usage: { api_key_created_at: envelope.occurred_at } } };
    default:
      return { event: null, patch };
  }
}

async function readRow(db: D1Database, contactId: string): Promise<Row> {
  const row = await db.prepare("SELECT state, subscription_status FROM contact_lifecycle WHERE contact_id = ?1").bind(contactId).first<Row>();
  return row ?? { state: null, subscription_status: null };
}

/** Route one product envelope. Throws when something must be retried. */
export async function routeProductEnvelope<E>(ctx: RouteContext<E>, event: Pick<StoredEvent, "id" | "payload_key">, envelope: ProductEnvelope, options: ProductRouterOptions): Promise<{ contactId: string | null; outcome: string }> {
  const { db, now } = ctx;
  if (envelope.type === "user.deleted") {
    if (!envelope.user?.email_sha256) return { contactId: null, outcome: "invalid" };
    await eraseProductUser({ db, bucket: ctx.bucket, now }, { userId: envelope.user.id, emailSha256: envelope.user.email_sha256, erasedAt: envelope.occurred_at, eventKey: event.id, source: "product" });
    return { contactId: null, outcome: "erased" };
  }
  if (envelope.type.startsWith("custom.")) return { contactId: null, outcome: "recorded" };
  const user = envelope.user;
  if (!user?.email) return { contactId: null, outcome: "invalid" };

  const resolved = await resolveProductUser(db, { userId: user.id, email: user.email, name: user.name, ref: envelope.ref }, { now, refTokens: await readSwitch(ctx.flags, LIFECYCLE_FLAGS.refTokens) });
  if (resolved.kind === "erased") {
    // Nothing the erased person sent is kept: not the payload, not whom it named.
    await dropPayload({ db, bucket: ctx.bucket }, event);
    await writeAudit(db, { agentId: "lifecycle", action: "product_event_refused_erased", details: { event: event.id, type: envelope.type }, now });
    return { contactId: null, outcome: "refused" };
  }
  if (resolved.kind === "skipped") return { contactId: null, outcome: `skipped: ${resolved.reason}` };
  const contactId = resolved.contactId;
  const deps = { db, now };
  const failed: string[] = [];
  const attribution: LifecyclePatch =
    resolved.method === "linked" ? {} : { attribution_method: resolved.method, attributed_campaign_id: resolved.campaignId, ...(envelope.ref ? { signup_ref: envelope.ref } : {}) };

  let row = await readRow(db, contactId);
  // Always applied, not only while the contact is before sign-up: the call is once per cause, and a
  // retry finishes the side effects (outreach stop, funnel, deal) an earlier attempt left undone.
  if (envelope.type !== "user.signed_up" && IMPLIES_ACCOUNT.has(envelope.type)) {
    const signup = await applyLifecycleEvent(deps, contactId, { kind: "signed_up" }, {
      eventKey: `${event.id}:signup`,
      occurredAt: envelope.occurred_at,
      source: "product",
      patch: { product_user_id: user.id, ...attribution },
    });
    failed.push(...signup.effectsFailed);
    row = await readRow(db, contactId);
  }
  const plan = productTransition(envelope, row, options.prices);
  const result = await applyLifecycleEvent(deps, contactId, plan.event, {
    eventKey: event.id,
    occurredAt: envelope.occurred_at,
    source: "product",
    patch: envelope.type === "user.signed_up" ? { ...plan.patch, ...attribution } : plan.patch,
    ...(plan.reason ? { reason: plan.reason } : {}),
  });
  failed.push(...result.effectsFailed);
  if (envelope.type === "feedback.submitted" && typeof envelope.data.text === "string") {
    await fileFeedback(db, { text: envelope.data.text, authorSha256: await addressHash(normalizeAddress(user.email) ?? user.email), productUserId: user.id, contactId, createdAt: envelope.occurred_at });
  }
  if (failed.length > 0) throw new Error(`lifecycle side effects did not finish (${[...new Set(failed)].join(", ")})`);
  if (await eraseIfTombstoned({ db, bucket: ctx.bucket, now }, { contactId, userId: user.id, source: "product" })) {
    await dropPayload({ db, bucket: ctx.bucket }, event);
    return { contactId: null, outcome: "refused" };
  }
  if (resolved.created) await writeAudit(db, { agentId: "lifecycle", action: "contact_created_from_product", details: { contactId, method: resolved.method }, now });
  return { contactId, outcome: result.applied ? "applied" : result.reason };
}

/**
 * The spine router for product events. Routes only while lifecycle:enabled is on, except an
 * erasure: erasing a person is a compliance action and never waits on an opt-in flag.
 */
export function createProductRouter<E>(options: ProductRouterOptions = {}): EventRouter<E> {
  return {
    flags: (event) => (event.type === "user.deleted" ? [] : [LIFECYCLE_FLAGS.enabled]),
    async route(event, payload, ctx) {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return { contactId: null, outcome: "invalid" };
      }
      const parsed = parseEnvelope(raw);
      // The webhook validated it before recording; a payload that no longer parses will never route.
      if (!parsed.ok) return { contactId: null, outcome: "invalid" };
      return routeProductEnvelope(ctx, event, parsed.envelope, options);
    },
  };
}
