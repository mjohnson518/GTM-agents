// GTM-agents: contract and behavior tests for the billing-stripe adapter, against locally signed,
// synthetic webhooks and recorded, synthetic API responses. Every customer, address, id and secret
// is invented; nothing reaches the network.
import { AdapterError } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";
import { runBillingProviderContract, type SignOptions } from "../_contract/billing-provider.ts";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { API_KEY_NAME, WEBHOOK_SECRET_NAME, createAdapter, mapStripeEvent, monthlyAmount, parseSignatureHeader, subscriptionAmount, subscriptionPlan } from "./index.ts";
import manifest from "./manifest.json";

// Low-entropy on purpose, so no scanner mistakes them for real credentials.
const WEBHOOK_SECRET = "k".repeat(48);
const API_KEY = "a".repeat(48);
const SECRETS = { [WEBHOOK_SECRET_NAME]: WEBHOOK_SECRET, [API_KEY_NAME]: API_KEY };
const NOW = new Date("2026-11-04T12:00:00.000Z");
const CREATED = Math.floor(NOW.getTime() / 1000) - 30;
const AT = new Date(CREATED * 1000).toISOString();
const API = "https://api.stripe.com";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signed(body: string, options: SignOptions = {}): Promise<Request> {
  const t = String(Math.floor(NOW.getTime() / 1000) - (options.ageSeconds ?? 0));
  const signatures = await Promise.all((options.secrets ?? [WEBHOOK_SECRET]).map(async (s) => `v1=${await hmacHex(s, `${t}.${body}`)}`));
  // A v0 signature over the same payload with a known secret must never be what passes the check.
  const header = [`t=${t}`, ...signatures, `v0=${"0".repeat(64)}`].join(",");
  const sent = options.tamper ? body.replace("cus_test0001", "cus_test0002") : body;
  return new Request("https://agent.acme.example/api/webhooks/billing", {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.unsigned ? {} : { "stripe-signature": header }) },
    body: sent,
  });
}

const event = (id: string, type: string, object: Record<string, unknown>) => JSON.stringify({ id, object: "event", type, created: CREATED, livemode: false, data: { object } });
const proItem = (overrides: Record<string, unknown> = {}) => ({ id: "si_test0001", quantity: 1, price: { id: "price_test_pro", lookup_key: "pro", unit_amount: 4900, currency: "usd", recurring: { interval: "month", interval_count: 1 } }, ...overrides });
const subscription = (overrides: Record<string, unknown> = {}) => ({ id: "sub_test0001", object: "subscription", customer: "cus_test0001", status: "active", currency: "usd", items: { object: "list", data: [proItem()] }, metadata: {}, ...overrides });

const customerRoute: RecordedRoute = {
  method: "GET",
  url: /^https:\/\/api\.stripe\.com\/v1\/customers\?/,
  respond: (request) => {
    const email = new URL(request.url).searchParams.get("email");
    if (request.headers.get("authorization") !== `Bearer ${API_KEY}`) return json({ error: { type: "invalid_request_error" } }, { status: 401 });
    return email === "dana@globex.example"
      ? json({ object: "list", data: [{ id: "cus_test0001", object: "customer", email, subscriptions: { object: "list", data: [subscription({ status: "canceled", id: "sub_test0000" }), subscription()] } }] })
      : json({ object: "list", data: [] });
  },
};
const subscriptionsRoute: RecordedRoute = {
  method: "GET",
  url: `${API}/v1/subscriptions?customer=cus_test0001&status=all&limit=100`,
  respond: json({
    object: "list",
    data: [
      subscription({ items: { data: [proItem({ current_period_end: CREATED + 86_400 })] } }),
      subscription({ id: "sub_test0002", status: "trialing", metadata: { plan: "team" }, items: { data: [proItem({ price: { id: "price_test_team", unit_amount: 199_200, recurring: { interval: "year" } } })] } }),
    ],
  }),
};

runBillingProviderContract(createAdapter, {
  manifest,
  secrets: SECRETS,
  webhookSecretName: WEBHOOK_SECRET_NAME,
  apiKeyName: API_KEY_NAME,
  now: NOW,
  request: signed,
  multipleSignatures: true,
  events: [
    {
      name: "checkout.session.completed",
      body: event("evt_test0001", "checkout.session.completed", { id: "cs_test0001", object: "checkout.session", customer: "cus_test0001", customer_details: { email: "dana@globex.example" }, mode: "subscription", amount_total: 4900, currency: "USD", metadata: { plan: "pro" } }),
      expected: { type: "checkout_completed", customerId: "cus_test0001", email: "dana@globex.example", plan: "pro", amount: 4900, currency: "usd", at: AT, providerEventId: "evt_test0001" },
    },
    {
      name: "customer.subscription.created",
      body: event("evt_test0002", "customer.subscription.created", subscription()),
      expected: { type: "subscription_created", customerId: "cus_test0001", subscriptionId: "sub_test0001", status: "active", plan: "pro", amount: 4900, currency: "usd", interval: "month", at: AT, providerEventId: "evt_test0002" },
    },
    {
      name: "customer.subscription.updated, with an expanded customer",
      body: event("evt_test0003", "customer.subscription.updated", subscription({ status: "past_due", customer: { id: "cus_test0001", object: "customer", email: "dana@globex.example" }, items: { data: [proItem({ quantity: 3 })] } })),
      expected: { type: "subscription_updated", customerId: "cus_test0001", subscriptionId: "sub_test0001", status: "past_due", email: "dana@globex.example", plan: "pro", amount: 14_700, currency: "usd", interval: "month", at: AT, providerEventId: "evt_test0003" },
    },
    {
      name: "customer.subscription.deleted",
      body: event("evt_test0004", "customer.subscription.deleted", subscription({ status: "canceled" })),
      expected: { type: "subscription_canceled", customerId: "cus_test0001", subscriptionId: "sub_test0001", status: "canceled", plan: "pro", amount: 4900, currency: "usd", interval: "month", at: AT, providerEventId: "evt_test0004" },
    },
    {
      name: "invoice.payment_failed, with the subscription under the invoice's parent",
      body: event("evt_test0005", "invoice.payment_failed", { id: "in_test0001", object: "invoice", customer: "cus_test0001", customer_email: "dana@globex.example", amount_due: 4900, currency: "usd", parent: { type: "subscription_details", subscription_details: { subscription: "sub_test0001" } } }),
      expected: { type: "payment_failed", customerId: "cus_test0001", subscriptionId: "sub_test0001", email: "dana@globex.example", amount: 4900, currency: "usd", at: AT, providerEventId: "evt_test0005" },
    },
    {
      name: "an event type it does not handle",
      body: event("evt_test0006", "charge.refunded", { id: "ch_test0001", object: "charge" }),
      expected: { type: "ignored", providerEventId: "evt_test0006", reason: "not handled: charge.refunded" },
    },
    {
      name: "a guest checkout with no customer",
      body: event("evt_test0007", "checkout.session.completed", { id: "cs_test0002", object: "checkout.session", customer: null, mode: "payment", amount_total: 1500, currency: "usd" }),
      expected: { type: "ignored", providerEventId: "evt_test0007", reason: "a checkout with no customer" },
    },
  ],
  invalidBodies: ["not json", JSON.stringify({ object: "event" }), event("evt_test0008", "customer.subscription.updated", { id: "sub_test0001" }), JSON.stringify({ id: "evt_test0009", type: "invoice.payment_failed", data: { object: { customer: "cus_test0001" } } })],
  customer: { email: "dana@globex.example", routes: [customerRoute], expected: { customerId: "cus_test0001", plan: "pro", status: "active" } },
  unknownCustomer: { email: "sam@initech.example", routes: [customerRoute] },
  subscriptions: {
    customerId: "cus_test0001",
    routes: [subscriptionsRoute],
    expected: [
      { subscriptionId: "sub_test0001", plan: "pro", status: "active", amount: 4900, currency: "usd", renewsAt: new Date((CREATED + 86_400) * 1000).toISOString() },
      { subscriptionId: "sub_test0002", plan: "team", status: "trialing", amount: 16_600, currency: "usd" },
    ],
  },
  failures: [
    { name: "401 is auth", routes: [{ url: /\/v1\/subscriptions/, respond: json({ error: {} }, { status: 401 }) }], code: "auth", retryable: false },
    { name: "429 is rate limited", routes: [{ url: /\/v1\/subscriptions/, respond: json({ error: {} }, { status: 429 }) }], code: "rate_limited", retryable: true },
    { name: "503 is unavailable", routes: [{ url: /\/v1\/subscriptions/, respond: json({ error: {} }, { status: 503 }) }], code: "unavailable", retryable: true },
    { name: "a dropped connection is a time-out", routes: [{ url: /\/v1\/subscriptions/, respond: () => Promise.reject(new Error("connection reset")) }], code: "timeout", retryable: true },
  ],
});

describe("billing-stripe specifics", () => {
  it("reads only v1 signatures from the header, and refuses a duplicated timestamp", () => {
    expect(parseSignatureHeader(`t=1,v0=${"a".repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`t=1,t=2,v1=${"a".repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`v1=${"a".repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`t=12, v1=${"a".repeat(64)}, v1=${"b".repeat(64)}, v1=short`)).toEqual({ timestamp: "12", signatures: ["a".repeat(64), "b".repeat(64)] });
  });

  it("turns mixed or multi-period intervals monthly, and leaves out an amount it cannot price", () => {
    const yearly = { price: { unit_amount: 120_000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } };
    const quarterly = { price: { unit_amount: 30_000, currency: "usd", recurring: { interval: "month", interval_count: 3 } } };
    expect(subscriptionAmount({ items: { data: [yearly] } })).toEqual({ amount: 120_000, currency: "usd", interval: "year" });
    expect(subscriptionAmount({ items: { data: [quarterly] } })).toEqual({ amount: 10_000, currency: "usd", interval: "month" });
    expect(subscriptionAmount({ items: { data: [yearly, proItem()] } })).toEqual({ amount: 14_900, currency: "usd", interval: "month" });
    expect(subscriptionAmount({ currency: "usd", items: { data: [{ price: { unit_amount: null, recurring: { interval: "month" } } }] } })).toEqual({ currency: "usd" });
    expect(monthlyAmount({ items: { data: [yearly] } })).toBe(10_000);
  });

  it("names the plan from metadata, then the lookup key, then the price id", () => {
    expect(subscriptionPlan(subscription({ metadata: { plan: "team" } }))).toBe("team");
    expect(subscriptionPlan(subscription())).toBe("pro");
    expect(subscriptionPlan(subscription({ items: { data: [proItem({ price: { id: "price_test_x", unit_amount: 1 } })] } }))).toBe("price_test_x");
  });

  it("maps the older invoice shape, where the subscription sits on the invoice itself", () => {
    const mapped = mapStripeEvent(JSON.parse(event("evt_test0010", "invoice.payment_failed", { id: "in_test0002", customer: "cus_test0001", subscription: "sub_test0001", amount_due: 100, currency: "eur" })));
    expect(mapped).toMatchObject({ type: "payment_failed", subscriptionId: "sub_test0001", amount: 100, currency: "eur" });
  });

  it("creates a checkout link only for a configured plan, with the effect key as the idempotency key", async () => {
    const calls: Request[] = [];
    const recorded = recordedFetch([
      {
        method: "POST",
        url: `${API}/v1/checkout/sessions`,
        respond: (request) => {
          calls.push(request);
          return json({ id: "cs_test0003", url: "https://checkout.stripe.com/c/pay/cs_test0003", expires_at: CREATED + 86_400 });
        },
      },
    ]);
    const options = { checkoutPrices: { pro: "price_test_pro" }, checkoutSuccessUrl: "https://app.acme.example/welcome" };
    const adapter = createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch, now: NOW, options }));
    const link = await adapter.createCheckoutLink?.({ plan: "Pro", email: "dana@globex.example", effectKey: "offer:fu0000000001" });
    expect(link).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test0003", expiresAt: new Date((CREATED + 86_400) * 1000).toISOString() });
    expect(calls[0]?.headers.get("idempotency-key")).toBe("offer:fu0000000001");
    const form = new URLSearchParams(await calls[0]?.text());
    expect(form.get("line_items[0][price]")).toBe("price_test_pro");
    expect(form.get("customer_email")).toBe("dana@globex.example");
    const refused = await adapter.createCheckoutLink?.({ plan: "enterprise", email: "dana@globex.example", effectKey: "offer:fu0000000002" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AdapterError);
    expect((refused as AdapterError).code).toBe("invalid");
    expect(recorded.calls).toHaveLength(1);
  });
});
