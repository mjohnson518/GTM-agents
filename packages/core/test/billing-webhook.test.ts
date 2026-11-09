// GTM-agents: POST /api/webhooks/billing through the BillingProvider port, with a fake provider:
// the signature is checked before anything else, effects are claimed per event, contacts are only
// ever resolved (never created), erased people are refused, and payments move the lifecycle, the
// deal mirror and MRR. No vendor is involved; every person and company is invented.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBillingProvider, fakeBillingWebhook } from "../src/billing/testing.ts";
import { billingTransition, normalizeStatus } from "../src/billing/route.ts";
import { monthlyCents, mrrDirection, planDirection } from "../src/billing/mrr.ts";
import { eraseContact } from "../src/data/erasure.ts";
import type { BillingEvent } from "../src/ports/business.ts";
import { BILLING_SECRET, PRICES, bucket, call, count, db, dealsOf, lifecycleWorker, person, resetLifecycle, state, testEnv, uid } from "./lifecycle-fixtures.ts";

const provider = fakeBillingProvider({ webhookSecret: BILLING_SECRET });
const { worker } = lifecycleWorker({ billing: () => provider });

const at = (offsetMinutes = 0) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();
const send = async (event: BillingEvent, options: { tamper?: boolean; unsigned?: boolean; signedAt?: Date; flags?: Record<string, string> } = {}) =>
  call(worker, await fakeBillingWebhook(event, { secret: BILLING_SECRET, ...options, ...(options.signedAt ? { at: options.signedAt } : {}) }), testEnv(options.flags ? { flags: options.flags } : {}));
const sub = (type: "subscription_created" | "subscription_updated" | "subscription_canceled", customerId: string, status: string, extra: Partial<BillingEvent> = {}): BillingEvent =>
  ({ type, customerId, subscriptionId: `sub_${customerId}`, status, at: at(), providerEventId: uid("bevt"), ...extra }) as BillingEvent;

beforeEach(resetLifecycle);

describe("the billing webhook's answers", () => {
  it("answers 503 without an adapter, and when billing or the lifecycle is off, recording nothing", async () => {
    const { worker: bare } = lifecycleWorker();
    const event: BillingEvent = { type: "checkout_completed", customerId: "cus_1", email: "ada@acme.example", at: at(), providerEventId: uid("bevt") };
    expect((await call(bare, await fakeBillingWebhook(event, { secret: BILLING_SECRET }), testEnv())).status).toBe(503);
    expect((await send(event, { flags: { "lifecycle:enabled": "true" } })).status).toBe(503);
    expect((await send(event, { flags: { "billing:enabled": "true" } })).status).toBe(503);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
  });

  it("answers 401 to an unsigned, tampered or stale webhook before reading the database, 400 to an unmappable one", async () => {
    const event: BillingEvent = { type: "checkout_completed", customerId: "cus_1", email: "ada@acme.example", at: at(), providerEventId: uid("bevt") };
    const read = provider.bodiesRead;
    expect((await send(event, { unsigned: true })).status).toBe(401);
    expect(provider.bodiesRead).toBe(read);
    expect((await send(event, { tamper: true })).status).toBe(401);
    expect((await send(event, { signedAt: new Date(Date.now() - 6 * 60_000) })).status).toBe(401);
    const bad = await fakeBillingWebhook({ type: "checkout_completed" } as BillingEvent, { secret: BILLING_SECRET });
    const garbled = new Request(bad.url, { method: "POST", headers: bad.headers, body: "{}" });
    expect((await call(worker, garbled, testEnv())).status).toBe(401);
    expect((await call(worker, await fakeBillingWebhook({ customerId: "cus_x" } as unknown as BillingEvent, { secret: BILLING_SECRET }), testEnv())).status).toBe(400);
    expect((await send({ type: "checkout_completed", customerId: "", at: at(), providerEventId: uid("bevt") })).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(0);
  });

  it("acknowledges an ignored event without recording it, and a redelivery as a duplicate", async () => {
    const ignored = await send({ type: "ignored", providerEventId: uid("bevt"), reason: "invoice.created" });
    expect(await ignored.json()).toEqual({ ok: true, ignored: true });
    const event: BillingEvent = { type: "checkout_completed", customerId: "cus_dup", email: "nobody@acme.example", at: at(), providerEventId: "bevt_dup" };
    expect(await (await send(event)).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await send(event)).json()).toEqual({ ok: true, duplicate: true });
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE source = 'billing'")).toBe(1);
  });

  it("stores the event without the customer's address, only its hashes", async () => {
    await send({ type: "checkout_completed", customerId: "cus_priv", email: "Private@Acme.example", at: at(), providerEventId: "bevt_priv" });
    const key = (await db.prepare("SELECT payload_key FROM events WHERE id = 'billing:fake-billing:bevt_priv'").first<{ payload_key: string }>())?.payload_key ?? "";
    const stored = (await (await bucket.get(key))?.text()) ?? "";
    expect(stored).not.toMatch(/private@acme/i);
    expect((JSON.parse(stored) as { emailSha256: string }).emailSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("billing effects", () => {
  it("links a checkout to an existing contact and signs them up; an unknown address creates no contact", async () => {
    const ada = await person({ email: "ada@globex.example" });
    await send({ type: "checkout_completed", customerId: "cus_ada", email: "ADA@globex.example", plan: "pro", at: at(), providerEventId: uid("bevt") });
    expect((await state(ada.id))?.state).toBe("signed_up");
    expect(await db.prepare("SELECT contact_id, status FROM billing_customers WHERE provider_customer_id = 'cus_ada'").first()).toEqual({ contact_id: ada.id, status: "created" });
    await send({ type: "checkout_completed", customerId: "cus_ghost", email: "ghost@nowhere.example", at: at(), providerEventId: uid("bevt") });
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE email = 'ghost@nowhere.example'")).toBe(0);
    expect(await db.prepare("SELECT contact_id FROM billing_customers WHERE provider_customer_id = 'cus_ghost'").first()).toEqual({ contact_id: null });
    expect(provider.checkoutLinks).toBe(0);
  });

  it("moves a customer through a subscription: paying with MRR, an upgrade, a failure, recovery, cancellation", async () => {
    const ada = await person({ email: "cfo@umbrella.example" });
    await send({ type: "checkout_completed", customerId: "cus_u", email: "cfo@umbrella.example", at: at(-10), providerEventId: uid("bevt") });
    await send(sub("subscription_created", "cus_u", "active", { plan: "pro", amount: 58800, interval: "year", at: at(-9) }));
    expect(await state(ada.id)).toMatchObject({ state: "paying", mrr_cents: 4900, plan_tier: "pro", subscription_status: "active" });
    expect((await dealsOf(ada.id)).map((d) => d.stage)).toEqual(["closed_won"]);
    await send(sub("subscription_updated", "cus_u", "active", { plan: "team", amount: 19900, at: at(-8) }));
    expect(await state(ada.id)).toMatchObject({ state: "expanding", mrr_cents: 19900 });
    // A renewal that changes nothing is not a change.
    await send(sub("subscription_updated", "cus_u", "active", { plan: "team", amount: 19900, at: at(-7) }));
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id)).toBe(3);
    await send({ type: "payment_failed", customerId: "cus_u", subscriptionId: "sub_cus_u", amount: 19900, currency: "usd", at: at(-6), providerEventId: uid("bevt") });
    expect(await state(ada.id)).toMatchObject({ state: "at_risk", subscription_status: "past_due" });
    await send(sub("subscription_updated", "cus_u", "past_due", { at: at(-5) }));
    expect((await state(ada.id))?.state).toBe("at_risk");
    await send(sub("subscription_updated", "cus_u", "active", { plan: "team", amount: 19900, at: at(-4) }));
    expect((await state(ada.id))?.state).toBe("paying");
    await send(sub("subscription_canceled", "cus_u", "canceled", { at: at(-3) }));
    expect(await state(ada.id)).toMatchObject({ state: "churned", mrr_cents: 0, subscription_status: "canceled" });
    expect(await db.prepare("SELECT status FROM billing_customers WHERE provider_customer_id = 'cus_u'").first()).toEqual({ status: "canceled" });
    expect((await dealsOf(ada.id)).map((d) => d.stage)).toEqual(["closed_won"]);
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND source = 'webhook' AND event_type = 'subscribed'", ada.id)).toBe(1);
  });

  it("finds a contact who appears after the checkout through the address hash the customer row kept", async () => {
    await send({ type: "checkout_completed", customerId: "cus_late", email: "late@hooli.example", at: at(-10), providerEventId: uid("bevt") });
    const late = await person({ email: "late@hooli.example" });
    await send(sub("subscription_created", "cus_late", "active", { plan: "pro", amount: 4900, at: at(-5) }));
    expect(await state(late.id)).toMatchObject({ state: "paying", mrr_cents: 4900 });
    expect(await db.prepare("SELECT contact_id FROM billing_customers WHERE provider_customer_id = 'cus_late'").first()).toEqual({ contact_id: late.id });
  });

  it("falls back to the plan's list price, and ignores an event older than the last one seen", async () => {
    const ada = await person({ email: "ops@initech.example" });
    await send({ type: "checkout_completed", customerId: "cus_i", email: "ops@initech.example", at: at(-10), providerEventId: uid("bevt") });
    await send(sub("subscription_created", "cus_i", "active", { plan: "Team", at: at(-5) }));
    expect(await state(ada.id)).toMatchObject({ state: "paying", mrr_cents: PRICES.team });
    await send(sub("subscription_canceled", "cus_i", "canceled", { at: at(-30) }));
    expect((await state(ada.id))?.state).toBe("paying");
  });

  it("refuses an erased person, writes nothing about them, and keeps none of their payload", async () => {
    const ada = await person({ email: "gone@vandelay.example" });
    await eraseContact(db, ada.email, { source: "operator" });
    const event: BillingEvent = { type: "checkout_completed", customerId: "cus_gone", email: "gone@vandelay.example", at: at(), providerEventId: "bevt_gone" };
    expect((await send(event)).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM billing_customers WHERE provider_customer_id = 'cus_gone'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE email = 'gone@vandelay.example'")).toBe(0);
    expect(await db.prepare("SELECT payload_key, routed_at IS NOT NULL AS routed FROM events WHERE id = 'billing:fake-billing:bevt_gone'").first()).toEqual({ payload_key: null, routed: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'billing_event_refused_erased'")).toBe(1);
  });
});

describe("an erased billing customer", () => {
  it("is refused on a later event that carries no address, and the customer id is not kept", async () => {
    const ada = await person({ email: "ada@erased-billing.example" });
    await send({ type: "checkout_completed", customerId: "cus_erased", email: "ada@erased-billing.example", at: at(-10), providerEventId: uid("bevt") });
    await send(sub("subscription_created", "cus_erased", "active", { plan: "pro", amount: 4900, at: at(-9) }));
    expect((await state(ada.id))?.state).toBe("paying");
    await eraseContact(db, ada.email, { source: "operator", bucket });
    expect(await count("SELECT COUNT(*) AS n FROM billing_customers WHERE provider_customer_id = 'cus_erased'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM billing_customers WHERE provider_customer_id LIKE 'erased:%' AND contact_id IS NULL AND plan IS NULL")).toBe(1);
    // The provider keeps reporting on the subscription, without an address.
    expect((await send(sub("subscription_updated", "cus_erased", "past_due", { at: at(-1) }))).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM billing_customers WHERE provider_customer_id = 'cus_erased'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'billing_event_refused_erased'")).toBe(1);
  });
});

describe("billing, pure", () => {
  it("normalizes vendor statuses, and keeps an unknown one unchanged", () => {
    expect(normalizeStatus("Active")).toBe("active");
    expect(normalizeStatus("cancelled")).toBe("canceled");
    expect(normalizeStatus("incomplete_expired")).toBe("canceled");
    expect(normalizeStatus("paused")).toBeNull();
    expect(billingTransition({ type: "subscription_updated", customerId: "c", subscriptionId: "s", status: "paused", at: "2026-11-01T00:00:00.000Z", providerEventId: "e" }, { status: "active", last_event_at: "2026-10-01T00:00:00.000Z" }, "paying", 4900, PRICES)).toMatchObject({ event: null, status: null });
  });

  it("turns amounts monthly and compares plans by list price", () => {
    expect(monthlyCents(58800, "year")).toBe(4900);
    expect(monthlyCents(1000, "week")).toBe(4333);
    expect(monthlyCents(4900, undefined)).toBe(4900);
    expect(monthlyCents(-1, "month")).toBeNull();
    expect(monthlyCents(4900, "fortnight")).toBeNull();
    expect(planDirection(PRICES, "pro", "TEAM")).toBe("up");
    expect(planDirection(PRICES, "team", "pro")).toBe("down");
    expect(planDirection(PRICES, "pro", "enterprise")).toBeNull();
    expect(mrrDirection(4900, 4900)).toBeNull();
  });
});
