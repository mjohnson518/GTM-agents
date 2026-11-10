// GTM-agents: the billing-stripe adapter: the BillingProvider port over the Stripe API.
//
// It translates and decides nothing. Identity, erasure, status changes and MRR are core's
// (docs/LIFECYCLE.md). Specifically:
//   - parseWebhook verifies the Stripe-Signature header before it reads the body: a `t=` timestamp
//     within 5 minutes of now (either side), then an HMAC-SHA256 over "{t}.{raw body}" keyed with
//     the endpoint's signing secret, compared in constant time against every `v1=` signature in the
//     header (Stripe sends one per active secret while a rolled secret is still valid). Every other
//     scheme, `v0` among them, is ignored, so a request cannot downgrade the check. Only then is the
//     body parsed. A missing, malformed, stale or wrong signature is an AdapterError "auth"; a body
//     it cannot map is "invalid"; an unset STRIPE_WEBHOOK_SECRET is "unavailable";
//   - mapped events: checkout.session.completed, customer.subscription.created, .updated and
//     .deleted, and invoice.payment_failed. Every other event type is `ignored`, and so is a
//     checkout with no customer (a guest payment core cannot link to anyone). The event id becomes
//     providerEventId and event.created the event time;
//   - every mapped event carries livemode: true only when the event says `livemode: true`, so an
//     event from Stripe's test mode, or one that does not say, is marked livemode false. Whether a
//     test-mode event is routed is core's decision (billing:accept_test_events, off by default);
//   - amounts are integers in the currency's minor unit. A subscription's amount is the sum of unit
//     amount times quantity over its items, with their interval, when every item recurs on the same
//     interval once per period; items on mixed intervals or on a multi-period interval are turned
//     monthly and reported with interval "month"; an item with no unit amount (tiered or metered
//     prices) leaves the amount out, so core falls back to the plan's list price. Discounts and
//     taxes are not applied;
//   - the plan is the subscription's `plan` metadata, else the first item's price lookup key, else
//     its price id. The address is the one the payload carries (the checkout's customer details,
//     an invoice's customer_email, or an expanded customer), never looked up;
//   - getCustomerByEmail and listSubscriptions read the REST API with STRIPE_SECRET_KEY through
//     ctx.fetch. listSubscriptions reports each amount per month;
//   - createCheckoutLink creates a Checkout Session for a plan's price, with the effect key as the
//     Idempotency-Key. A checkout link is an offer, which is permanently human-only: core never calls
//     it on its own, and the tool that would (checkout_create) is classified humanOnly in core. It
//     needs options.checkoutPrices and options.checkoutSuccessUrl, and refuses without them.
// The API charges nothing per call, so no cost is recorded.
//
// Secrets: STRIPE_SECRET_KEY (reads and checkout links; a restricted key with read access to
// customers and subscriptions is enough without checkout links), STRIPE_WEBHOOK_SECRET (the
// endpoint's signing secret, for verifying webhooks).
// Options (adapters.billing-stripe.options):
//   apiBaseUrl          defaults to https://api.stripe.com
//   checkoutPrices      plan name to Stripe price id, for createCheckoutLink
//   checkoutSuccessUrl  the https URL a buyer returns to after paying
//   checkoutCancelUrl   optional, the https URL a buyer returns to after leaving the checkout
import { constantTimeEqual } from "@gtm-agents/core/http";
import { AdapterError, type AdapterContext, type AdapterErrorCode, type BillingEvent, type BillingInterval, type BillingProvider } from "@gtm-agents/core/ports";

export const NAME = "billing-stripe";
export const STRIPE_API = "https://api.stripe.com";
export const API_KEY_NAME = "STRIPE_SECRET_KEY";
export const WEBHOOK_SECRET_NAME = "STRIPE_WEBHOOK_SECRET";
export const SIGNATURE_HEADER = "stripe-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const INTERVALS: ReadonlySet<string> = new Set(["day", "week", "month", "year"]);
const MONTHS_PER: Readonly<Record<BillingInterval, number>> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };
/** Stripe object ids: a prefix and letters or digits. Anything else is never put in a URL. */
const OBJECT_ID = /^[A-Za-z0-9_]{1,128}$/;
const ADDRESS = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,255}$/;

interface StripeOptions {
  baseUrl: string;
  checkoutPrices: Record<string, string>;
  successUrl: string | null;
  cancelUrl: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const httpsUrl = (v: unknown): string | null => (typeof v === "string" && /^https:\/\/[^\s/@]+(?:\/\S*)?$/.test(v) ? v : null);

function readOptions(raw: Record<string, unknown>): StripeOptions {
  const base = typeof raw.apiBaseUrl === "string" && /^https:\/\/[^/\s]+/.test(raw.apiBaseUrl) ? raw.apiBaseUrl.replace(/\/+$/, "") : STRIPE_API;
  const prices: Record<string, string> = {};
  if (isRecord(raw.checkoutPrices)) {
    for (const [plan, id] of Object.entries(raw.checkoutPrices)) if (typeof id === "string" && OBJECT_ID.test(id)) prices[plan.trim().toLowerCase()] = id;
  }
  return { baseUrl: base, checkoutPrices: prices, successUrl: httpsUrl(raw.checkoutSuccessUrl), cancelUrl: httpsUrl(raw.checkoutCancelUrl) };
}

/** An id from a field that holds either an id or an expanded object with one. */
function idOf(value: unknown): string | undefined {
  const id = typeof value === "string" ? value : isRecord(value) ? value.id : undefined;
  return typeof id === "string" && OBJECT_ID.test(id) ? id : undefined;
}

/** A plan name fit to store: one line, printable, at most 100 characters. */
function planName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100);
  return text.length > 0 ? text : undefined;
}

function address(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return ADDRESS.test(trimmed) ? trimmed : undefined;
}

const minorUnits = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000_000 ? v : undefined);
const currencyOf = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toLowerCase() : undefined);

/** A subscription's amount, currency and interval from its items (see the header). Pure. */
export function subscriptionAmount(subscription: Record<string, unknown>): { amount?: number; currency?: string; interval?: BillingInterval } {
  const items = isRecord(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  let total = 0;
  let monthly = 0;
  let interval: BillingInterval | undefined;
  let uniform = true;
  let currency = currencyOf(subscription.currency);
  if (items.length === 0) return currency ? { currency } : {};
  for (const item of items) {
    if (!isRecord(item)) return currency ? { currency } : {};
    const price = isRecord(item.price) ? item.price : isRecord(item.plan) ? item.plan : {};
    currency ??= currencyOf(price.currency);
    const unit = minorUnits(price.unit_amount ?? price.amount);
    const quantity = item.quantity === undefined || item.quantity === null ? 1 : minorUnits(item.quantity);
    const recurring = isRecord(price.recurring) ? price.recurring : price;
    const rawInterval = typeof recurring.interval === "string" ? recurring.interval : "";
    const count = recurring.interval_count === undefined || recurring.interval_count === null ? 1 : recurring.interval_count;
    if (unit === undefined || quantity === undefined || !INTERVALS.has(rawInterval) || typeof count !== "number" || !Number.isInteger(count) || count < 1) return currency ? { currency } : {};
    const every = rawInterval as BillingInterval;
    const line = unit * quantity;
    total += line;
    monthly += (line * MONTHS_PER[every]) / count;
    if (interval === undefined) interval = every;
    if (every !== interval || count !== 1) uniform = false;
  }
  const out: { amount?: number; currency?: string; interval?: BillingInterval } = uniform && interval ? { amount: total, interval } : { amount: Math.round(monthly), interval: "month" };
  if (currency) out.currency = currency;
  return out;
}

/** The plan name of a subscription (see the header). Pure. */
export function subscriptionPlan(subscription: Record<string, unknown>): string | undefined {
  const fromMetadata = isRecord(subscription.metadata) ? planName(subscription.metadata.plan) : undefined;
  if (fromMetadata) return fromMetadata;
  const items = isRecord(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  const first: unknown = items[0];
  const price = isRecord(first) ? (isRecord(first.price) ? first.price : isRecord(first.plan) ? first.plan : null) : null;
  if (!price) return undefined;
  return planName(price.lookup_key) ?? planName(price.id);
}

/** The subscription's monthly amount in minor units, or undefined when an item has no usable price. Pure. */
export function monthlyAmount(subscription: Record<string, unknown>): number | undefined {
  const { amount, interval } = subscriptionAmount(subscription);
  if (amount === undefined || interval === undefined) return undefined;
  return Math.round(amount * MONTHS_PER[interval]);
}

function eventTime(created: unknown): string {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) throw new AdapterError("the event has no creation time", "invalid", false);
  return new Date(created * 1000).toISOString();
}

/** Map a verified Stripe event to the port's BillingEvent. Throws an "invalid" AdapterError for a payload it cannot read. Pure. */
export function mapStripeEvent(payload: unknown): BillingEvent {
  if (!isRecord(payload) || typeof payload.id !== "string" || !OBJECT_ID.test(payload.id) || typeof payload.type !== "string") {
    throw new AdapterError("the webhook body is not a Stripe event", "invalid", false);
  }
  const providerEventId = payload.id;
  const type = payload.type;
  const object = isRecord(payload.data) && isRecord(payload.data.object) ? payload.data.object : null;
  const handled = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed"];
  if (!handled.includes(type)) return { type: "ignored", providerEventId, reason: `not handled: ${type.replace(/[^a-z0-9._]/gi, "").slice(0, 80)}` };
  if (!object) throw new AdapterError("the event carries no object", "invalid", false);
  const at = eventTime(payload.created);
  const customerId = idOf(object.customer);
  // Live only when Stripe says so: a missing or malformed value counts as test mode.
  const livemode = payload.livemode === true;

  if (type === "checkout.session.completed") {
    if (!customerId) return { type: "ignored", providerEventId, reason: "a checkout with no customer" };
    const details = isRecord(object.customer_details) ? object.customer_details : {};
    const email = address(details.email) ?? address(object.customer_email) ?? (isRecord(object.customer) ? address(object.customer.email) : undefined);
    const plan = isRecord(object.metadata) ? planName(object.metadata.plan) : undefined;
    const amount = minorUnits(object.amount_total);
    const currency = currencyOf(object.currency);
    return { type: "checkout_completed", customerId, ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(amount !== undefined ? { amount } : {}), ...(currency ? { currency } : {}), at, providerEventId, livemode };
  }

  if (type === "invoice.payment_failed") {
    if (!customerId) throw new AdapterError("the invoice has no customer", "invalid", false);
    const parent = isRecord(object.parent) && isRecord(object.parent.subscription_details) ? object.parent.subscription_details : {};
    const subscriptionId = idOf(object.subscription) ?? idOf(parent.subscription);
    const email = address(object.customer_email);
    const amount = minorUnits(object.amount_due);
    const currency = currencyOf(object.currency);
    return { type: "payment_failed", customerId, ...(subscriptionId ? { subscriptionId } : {}), ...(email ? { email } : {}), ...(amount !== undefined ? { amount } : {}), ...(currency ? { currency } : {}), at, providerEventId, livemode };
  }

  const subscriptionId = idOf(object.id);
  if (!customerId || !subscriptionId) throw new AdapterError("the subscription has no id or customer", "invalid", false);
  const status = typeof object.status === "string" && /^[a-z_]{1,40}$/.test(object.status) ? object.status : type === "customer.subscription.deleted" ? "canceled" : "";
  if (!status) throw new AdapterError("the subscription has no status", "invalid", false);
  const email = isRecord(object.customer) ? address(object.customer.email) : undefined;
  const plan = subscriptionPlan(object);
  const priced = subscriptionAmount(object);
  const portType = type === "customer.subscription.created" ? "subscription_created" : type === "customer.subscription.updated" ? "subscription_updated" : "subscription_canceled";
  return {
    type: portType,
    customerId,
    subscriptionId,
    status,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(priced.amount !== undefined ? { amount: priced.amount } : {}),
    ...(priced.currency ? { currency: priced.currency } : {}),
    ...(priced.interval ? { interval: priced.interval } : {}),
    at,
    providerEventId,
    livemode,
  };
}

/** The timestamp and v1 signatures in a Stripe-Signature header, or null when it is malformed. Pure. */
export function parseSignatureHeader(header: string): { timestamp: string; signatures: string[] } | null {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
      timestamp = value;
    } else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp !== null && signatures.length > 0 ? { timestamp, signatures } : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Codes for an HTTP failure from the API. Pure. */
export function classifyStatus(status: number): { code: AdapterErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "unavailable", retryable: true };
  return { code: "invalid", retryable: false };
}

export function createAdapter(ctx: AdapterContext): BillingProvider {
  const options = readOptions(ctx.options);

  async function api(method: "GET" | "POST", path: string, init: { query?: URLSearchParams; form?: URLSearchParams; idempotencyKey?: string } = {}): Promise<unknown> {
    const key = ctx.optionalSecret(API_KEY_NAME);
    if (!key) throw new AdapterError(`${API_KEY_NAME} is not set`, "auth", false);
    const url = `${options.baseUrl}${path}${init.query ? `?${init.query.toString()}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (init.form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    let response: Response;
    try {
      response = await ctx.fetch(url, { method, headers, ...(init.form ? { body: init.form.toString() } : {}) });
    } catch (error) {
      throw new AdapterError("the billing API did not answer", "timeout", true, { cause: error });
    }
    if (!response.ok) {
      const { code, retryable } = classifyStatus(response.status);
      throw new AdapterError(`the billing API answered HTTP ${response.status}`, code, retryable);
    }
    const body = await response.json<unknown>().catch(() => null);
    if (!isRecord(body)) throw new AdapterError("the billing API answered with something that is not JSON", "unknown", true);
    return body;
  }

  const listData = (body: unknown): Record<string, unknown>[] => (isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : []);

  return {
    name: NAME,

    async parseWebhook(request) {
      const secret = ctx.optionalSecret(WEBHOOK_SECRET_NAME);
      if (!secret) throw new AdapterError(`${WEBHOOK_SECRET_NAME} is not set, so webhooks cannot be verified`, "unavailable", false);
      const parsed = parseSignatureHeader(request.headers.get(SIGNATURE_HEADER) ?? "");
      if (!parsed) throw new AdapterError("the webhook is not signed", "auth", false);
      if (Math.abs(ctx.now().getTime() / 1000 - Number(parsed.timestamp)) > WEBHOOK_TOLERANCE_SECONDS) throw new AdapterError("the webhook timestamp is outside the 5-minute window", "auth", false);
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) throw new AdapterError("the webhook body is too large", "invalid", false);
      const body = await request.text();
      if (encoder.encode(body).length > WEBHOOK_MAX_BYTES) throw new AdapterError("the webhook body is too large", "invalid", false);
      const expected = await hmacHex(secret, `${parsed.timestamp}.${body}`);
      let valid = false;
      for (const candidate of parsed.signatures) {
        // Every candidate is compared, so the time taken does not depend on which one matched.
        if (await constantTimeEqual(candidate, expected)) valid = true;
      }
      if (!valid) throw new AdapterError("the webhook signature does not match", "auth", false);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new AdapterError("the webhook body is not JSON", "invalid", false);
      }
      return mapStripeEvent(payload);
    },

    async getCustomerByEmail(email) {
      const wanted = address(email);
      if (!wanted) throw new AdapterError("not an address", "invalid", false);
      const query = new URLSearchParams({ email: wanted, limit: "1" });
      query.append("expand[]", "data.subscriptions");
      const body = await api("GET", "/v1/customers", { query });
      const customer = listData(body)[0];
      const customerId = customer ? idOf(customer.id) : undefined;
      if (!customer || !customerId) return null;
      const subscriptions = listData(customer.subscriptions);
      const current = subscriptions.find((s) => s.status !== "canceled") ?? subscriptions[0];
      const plan = current ? subscriptionPlan(current) : undefined;
      const status = current && typeof current.status === "string" ? current.status : undefined;
      return { customerId, ...(plan ? { plan } : {}), ...(status ? { status } : {}) };
    },

    async listSubscriptions(customerId) {
      if (!OBJECT_ID.test(customerId)) throw new AdapterError("not a customer id", "invalid", false);
      const body = await api("GET", "/v1/subscriptions", { query: new URLSearchParams({ customer: customerId, status: "all", limit: "100" }) });
      const out: Awaited<ReturnType<BillingProvider["listSubscriptions"]>> = [];
      for (const s of listData(body)) {
        const subscriptionId = idOf(s.id);
        if (!subscriptionId) continue;
        const amount = monthlyAmount(s);
        const currency = subscriptionAmount(s).currency;
        const items = isRecord(s.items) && Array.isArray(s.items.data) ? s.items.data : [];
        const first: unknown = items[0];
        const periodEnd = typeof s.current_period_end === "number" ? s.current_period_end : isRecord(first) && typeof first.current_period_end === "number" ? first.current_period_end : undefined;
        out.push({
          subscriptionId,
          plan: subscriptionPlan(s) ?? "unknown",
          status: typeof s.status === "string" ? s.status : "unknown",
          ...(amount !== undefined ? { amount } : {}),
          ...(currency ? { currency } : {}),
          ...(periodEnd !== undefined && periodEnd > 0 ? { renewsAt: new Date(periodEnd * 1000).toISOString() } : {}),
        });
      }
      return out;
    },

    async createCheckoutLink(args) {
      const price = options.checkoutPrices[args.plan.trim().toLowerCase()];
      if (!price) throw new AdapterError(`no checkout price is configured for plan ${planName(args.plan) ?? "(none)"}`, "invalid", false);
      if (!options.successUrl) throw new AdapterError("checkoutSuccessUrl is not configured", "invalid", false);
      const email = address(args.email);
      if (!email) throw new AdapterError("not an address", "invalid", false);
      if (!/^[\x21-\x7e]{1,255}$/.test(args.effectKey)) throw new AdapterError("the effect key cannot be an idempotency key", "invalid", false);
      const form = new URLSearchParams({ mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": "1", customer_email: email, success_url: options.successUrl });
      if (options.cancelUrl) form.set("cancel_url", options.cancelUrl);
      const body = await api("POST", "/v1/checkout/sessions", { form, idempotencyKey: args.effectKey });
      const url = isRecord(body) ? httpsUrl(body.url) : null;
      if (!url) throw new AdapterError("the checkout session has no URL", "unknown", false);
      const expires = isRecord(body) && typeof body.expires_at === "number" ? new Date(body.expires_at * 1000).toISOString() : undefined;
      return { url, ...(expires ? { expiresAt: expires } : {}) };
    },
  };
}
