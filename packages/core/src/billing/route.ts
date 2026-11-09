// GTM-agents: the event spine's router for billing events (source "billing"), from any adapter
// behind the BillingProvider port.
//
// The stored payload is the adapter's mapped event with the customer's address replaced by its
// hashes, so blob storage never holds it. For each event:
//   1. who: the billing customer row for (provider, customer id) names the contact once it is
//      linked; otherwise the address hashes find an existing contact (exact address, then any
//      +tag of the same mailbox). Billing resolves contacts and never creates one;
//   2. erased people are refused: a tombstone on the address (from the event or the customer row)
//      or on the contact's own address stops the event before anything is written;
//   3. what it means, against the customer row as it was before this event (only real status
//      changes count, and an event older than the last one seen changes no status):
//        checkout_completed            signed_up (a contact before sign-up), which stops their
//                                      cold outreach
//        subscription_created          subscribed when active; signed_up when trialing
//        subscription_updated          subscribed when it turns active from trialing or incomplete;
//                                      recovered when active after past due; payment_failed on
//                                      past_due or unpaid; canceled; otherwise a plan change up or
//                                      down by MRR, or no state change
//        subscription_canceled         canceled, MRR 0
//        payment_failed                payment_failed
//      MRR is the amount by its interval, else the plan's list price (mrr.ts);
//   4. the lifecycle writer applies it, claimed under the event's row id, so a redelivered or
//      re-routed event never moves anyone twice;
//   5. the customer row is written last (link, address hash, plan, status, last event time).
// A side effect that fails makes the route throw, so the spine retries; only unfinished work runs
// again.
import { erasedCustomerMarker } from "../data/erasure.ts";
import { writeAudit } from "../events/audit.ts";
import { dropPayload, type EventRouter, type RouteContext, type StoredEvent } from "../events/spine.ts";
import { applyLifecycleEvent, type LifecyclePatch } from "../lifecycle/apply.ts";
import { LIFECYCLE_FLAGS } from "../lifecycle/flags.ts";
import { isPreSignup, type LifecycleEvent } from "../lifecycle/states.ts";
import type { BillingEvent } from "../ports/business.ts";
import { label } from "../product-bridge/envelope.ts";
import { isErased } from "../product-bridge/identity.ts";
import type { LifecycleState } from "../data/enums.ts";
import { listPrice, monthlyCents, mrrDirection, type PriceList } from "./mrr.ts";

export const BILLING_SOURCE = "billing";

/** The statuses billing_customers.status may hold. */
export const BILLING_STATUSES = ["created", "checkout_pending", "trialing", "active", "past_due", "unpaid", "incomplete", "canceled"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** A vendor status in the stored set, or null for one the core does not know (the stored status is then kept). Pure. */
export function normalizeStatus(raw: unknown): BillingStatus | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "cancelled" || value === "incomplete_expired" || value === "ended") return "canceled";
  return (BILLING_STATUSES as readonly string[]).includes(value) ? (value as BillingStatus) : null;
}

/** What the spine stores for a billing event: the mapped event without an address, and the address's hashes. */
export interface StoredBillingEvent {
  provider: string;
  event: Exclude<BillingEvent, { type: "ignored" }>;
  emailSha256: string | null;
  mailboxSha256: string | null;
}

export interface BillingRouterOptions {
  /** Monthly list price in cents per plan name, when an event carries no amount. */
  prices?: PriceList;
}

interface CustomerRow {
  contact_id: string | null;
  email_sha256: string | null;
  plan: string | null;
  status: BillingStatus;
  last_event_at: string;
}

interface Decision {
  event: LifecycleEvent | null;
  patch: LifecyclePatch;
  status: BillingStatus | null;
}

/** What one billing event means, given the customer row before it and the contact's state. Pure. */
export function billingTransition(event: StoredBillingEvent["event"], before: Pick<CustomerRow, "status" | "last_event_at"> | null, state: LifecycleState | null, currentMrr: number | null, prices: PriceList | undefined): Decision {
  const stale = before !== null && event.at < before.last_event_at;
  const plan = "plan" in event ? label(event.plan) : null;
  // A failed payment's amount is what failed, not what recurs.
  const fields = event as { amount?: unknown; interval?: unknown };
  const mrr = event.type === "payment_failed" ? null : (monthlyCents(fields.amount, fields.interval ?? "month") ?? listPrice(prices, plan));
  const patch: LifecyclePatch = { ...(plan ? { plan_tier: plan } : {}) };
  switch (event.type) {
    case "checkout_completed":
      return { event: isPreSignup(state) ? { kind: "signed_up" } : null, patch, status: before ? null : "created" };
    case "payment_failed":
      return { event: stale ? null : { kind: "payment_failed" }, patch: stale ? {} : { subscription_status: "past_due" }, status: stale ? null : "past_due" };
    case "subscription_canceled":
      return { event: stale ? null : { kind: "canceled" }, patch: stale ? patch : { ...patch, subscription_status: "canceled", mrr_cents: 0 }, status: stale ? null : "canceled" };
    default: {
      const status = normalizeStatus(event.status);
      if (stale || status === null) return { event: null, patch, status: null };
      const fields: LifecyclePatch = { ...patch, subscription_status: status, ...(mrr !== null && status !== "canceled" ? { mrr_cents: mrr } : {}) };
      const prior = before?.status ?? null;
      if (status === "canceled") return { event: { kind: "canceled" }, patch: { ...fields, mrr_cents: 0 }, status };
      if (status === "past_due" || status === "unpaid") return { event: prior === status ? null : { kind: "payment_failed" }, patch: fields, status };
      if (status === "trialing" || status === "incomplete") return { event: isPreSignup(state) ? { kind: "signed_up" } : null, patch: { ...fields, mrr_cents: undefined }, status };
      // Active from here on.
      if (prior === "past_due" || prior === "unpaid") return { event: state === "at_risk" ? { kind: "recovered" } : { kind: "subscribed" }, patch: fields, status };
      if (event.type === "subscription_created" || prior !== "active" || !(state === "paying" || state === "expanding" || state === "at_risk")) return { event: { kind: "subscribed" }, patch: fields, status };
      // Still active: a real change is a plan or price change.
      const direction = mrrDirection(currentMrr, mrr);
      return { event: direction ? { kind: "subscription_changed", direction } : null, patch: fields, status };
    }
  }
}

function parseStored(payload: string): StoredBillingEvent | null {
  try {
    const value = JSON.parse(payload) as StoredBillingEvent;
    const e = value?.event;
    if (!value || typeof value.provider !== "string" || !e || typeof e !== "object") return null;
    if (!["checkout_completed", "subscription_created", "subscription_updated", "subscription_canceled", "payment_failed"].includes(e.type)) return null;
    if (typeof e.customerId !== "string" || e.customerId.length === 0 || typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return null;
    return value;
  } catch {
    return null;
  }
}

/** Route one stored billing event. Throws when something must be retried. */
export async function routeBillingEvent<E>(ctx: RouteContext<E>, stored: Pick<StoredEvent, "id" | "payload_key">, value: StoredBillingEvent, options: BillingRouterOptions): Promise<{ contactId: string | null; outcome: string }> {
  const { db, now } = ctx;
  const event = value.event;
  const before = await db
    .prepare("SELECT contact_id, email_sha256, plan, status, last_event_at FROM billing_customers WHERE provider = ?1 AND provider_customer_id = ?2")
    .bind(value.provider, event.customerId)
    .first<CustomerRow>();
  const hashes = { emailSha256: value.emailSha256 ?? before?.email_sha256 ?? null, mailboxSha256: value.mailboxSha256 };
  const refuse = async () => {
    await dropPayload({ db, bucket: ctx.bucket }, stored);
    await writeAudit(db, { agentId: "billing", action: "billing_event_refused_erased", details: { event: stored.id, type: event.type }, now });
    return { contactId: null, outcome: "refused" };
  };
  if ((hashes.emailSha256 || hashes.mailboxSha256) && (await isErased(db, hashes))) return refuse();
  // A customer id that belonged to an erased person is refused even on an event with no address:
  // the erasure left a marker of it (data/erasure.ts).
  if (!before) {
    const marker = await erasedCustomerMarker(value.provider, event.customerId);
    if (await db.prepare("SELECT 1 AS hit FROM billing_customers WHERE provider = ?1 AND provider_customer_id = ?2").bind(value.provider, marker).first()) return refuse();
  }
  let contact: { id: string; email_sha256: string; mailbox_sha256: string } | null = null;
  if (before?.contact_id) contact = await db.prepare("SELECT id, email_sha256, mailbox_sha256 FROM contacts WHERE id = ?1").bind(before.contact_id).first();
  // Later events often carry no address: the hash the customer row keeps from an earlier one finds
  // the contact once they exist (a sign-up after the checkout, for example).
  const exact = value.emailSha256 ?? before?.email_sha256 ?? null;
  const mailbox = value.mailboxSha256 ?? exact;
  if (!contact && exact) {
    contact = await db
      .prepare("SELECT id, email_sha256, mailbox_sha256 FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 ORDER BY (email_sha256 = ?1) DESC, created_at LIMIT 1")
      .bind(exact, mailbox)
      .first();
  }
  if (contact && (await isErased(db, { emailSha256: contact.email_sha256, mailboxSha256: contact.mailbox_sha256 }))) return refuse();

  let outcome = "unresolved";
  const decisionStatus = { value: null as BillingStatus | null };
  if (contact) {
    const contactId = contact.id;
    const readRow = () => db.prepare("SELECT state, mrr_cents FROM contact_lifecycle WHERE contact_id = ?1").bind(contactId).first<{ state: LifecycleState; mrr_cents: number }>();
    const failed: string[] = [];
    // Any billing event proves the person is a customer of the product: a contact still before
    // sign-up is signed up first, which also stops their cold outreach. Always applied (once per
    // cause), so a retry finishes the side effects an earlier attempt left undone.
    const signup = await applyLifecycleEvent({ db, now }, contactId, { kind: "signed_up" }, { eventKey: `${stored.id}:signup`, occurredAt: event.at, source: "billing" });
    failed.push(...signup.effectsFailed);
    const row = await readRow();
    const decision = billingTransition(event, before ? { status: before.status, last_event_at: before.last_event_at } : null, row?.state ?? null, row?.mrr_cents ?? null, options.prices);
    decisionStatus.value = decision.status;
    const result = await applyLifecycleEvent({ db, now }, contactId, decision.event, { eventKey: stored.id, occurredAt: event.at, source: "billing", patch: decision.patch, ...(decision.event?.kind === "canceled" ? { reason: "unspecified" } : {}) });
    failed.push(...result.effectsFailed);
    if (failed.length > 0) throw new Error(`lifecycle side effects did not finish (${[...new Set(failed)].join(", ")})`);
    outcome = result.applied ? `applied ${result.to ?? "fields"}` : result.reason;
  } else {
    decisionStatus.value = billingTransition(event, before ? { status: before.status, last_event_at: before.last_event_at } : null, null, null, options.prices).status;
    await writeAudit(db, { agentId: "billing", action: "billing_event_unresolved", details: { event: stored.id, type: event.type }, now });
  }

  const at = now.toISOString();
  const subscriptionId = "subscriptionId" in event && typeof event.subscriptionId === "string" ? event.subscriptionId : null;
  const plan = "plan" in event ? label(event.plan) : null;
  await db
    .prepare(
      `INSERT INTO billing_customers (id, provider, provider_customer_id, provider_subscription_id, contact_id, email_sha256, plan, status, last_checkout_at, last_event_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, 'created'), ?9, ?10, ?11)
       ON CONFLICT (provider, provider_customer_id) DO UPDATE SET
         provider_subscription_id = COALESCE(excluded.provider_subscription_id, billing_customers.provider_subscription_id),
         contact_id = COALESCE(billing_customers.contact_id, excluded.contact_id),
         email_sha256 = COALESCE(billing_customers.email_sha256, excluded.email_sha256),
         plan = COALESCE(excluded.plan, billing_customers.plan),
         status = COALESCE(?8, billing_customers.status),
         last_checkout_at = COALESCE(excluded.last_checkout_at, billing_customers.last_checkout_at),
         last_event_at = MAX(billing_customers.last_event_at, excluded.last_event_at)`,
    )
    .bind(
      crypto.randomUUID(),
      value.provider,
      event.customerId,
      subscriptionId,
      contact?.id ?? null,
      value.emailSha256,
      plan,
      decisionStatus.value,
      event.type === "checkout_completed" ? event.at : null,
      new Date(event.at).toISOString(),
      at,
    )
    .run();
  return { contactId: contact?.id ?? null, outcome };
}

/** The spine router for billing events. Routes only while billing:enabled and lifecycle:enabled are both on. */
export function createBillingRouter<E>(options: BillingRouterOptions = {}): EventRouter<E> {
  return {
    flags: [LIFECYCLE_FLAGS.enabled, LIFECYCLE_FLAGS.billing],
    async route(event, payload, ctx) {
      const value = parseStored(payload);
      if (!value) return { contactId: null, outcome: "invalid" };
      return routeBillingEvent(ctx, event, value, options);
    },
  };
}
