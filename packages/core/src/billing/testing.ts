// GTM-agents: a fake BillingProvider for tests: a signed webhook and an in-memory customer book.
//
// Import it from "@gtm-agents/core/billing/testing" in tests only. Its webhook is signed the way
// real billing providers sign theirs: a header `t=<unix seconds>,v1=<hex HMAC-SHA256(secret,
// "<t>.<body>")>`, a 5-minute tolerance and a constant-time compare, so tests can prove that core
// rejects a tampered, unsigned or replayed webhook before touching the database. The body is
// `{"event": <BillingEvent>}`. No vendor is involved.
import { constantTimeEqual } from "../http/auth.ts";
import type { BillingEvent, BillingProvider } from "../ports/business.ts";
import { AdapterError } from "../ports/types.ts";

export const FAKE_BILLING_SIGNATURE_HEADER = "x-test-billing-signature";
export const FAKE_BILLING_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FakeBillingProvider extends BillingProvider {
  /** Customers getCustomerByEmail and listSubscriptions answer from. */
  customers: Map<string, { customerId: string; plan?: string; status?: string }>;
  subscriptions: Map<string, Array<{ subscriptionId: string; plan: string; status: string; amount?: number; currency?: string; renewsAt?: string }>>;
  /** How many times parseWebhook read a body (a rejection before reading leaves it unchanged). */
  bodiesRead: number;
  /** Calls to createCheckoutLink. Core must never make one on its own. */
  checkoutLinks: number;
}

export function fakeBillingProvider(options: { name?: string; webhookSecret?: string; now?: () => Date } = {}): FakeBillingProvider {
  const now = options.now ?? (() => new Date());
  const provider: FakeBillingProvider = {
    name: options.name ?? "fake-billing",
    customers: new Map(),
    subscriptions: new Map(),
    bodiesRead: 0,
    checkoutLinks: 0,
    async parseWebhook(request) {
      const secret = options.webhookSecret;
      if (!secret) throw new AdapterError("fake billing: the webhook secret is not configured", "unavailable", false);
      const header = request.headers.get(FAKE_BILLING_SIGNATURE_HEADER) ?? "";
      const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
      if (!match) throw new AdapterError("fake billing: missing signature", "auth", false);
      const timestamp = match[1] ?? "";
      if (Math.abs(now().getTime() / 1000 - Number(timestamp)) > FAKE_BILLING_TOLERANCE_SECONDS) throw new AdapterError("fake billing: stale webhook", "auth", false);
      const body = await request.text();
      provider.bodiesRead += 1;
      if (!(await constantTimeEqual(match[2] ?? "", await hmac(secret, `${timestamp}.${body}`)))) throw new AdapterError("fake billing: bad signature", "auth", false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new AdapterError("fake billing: the body is not JSON", "invalid", false);
      }
      const event = (parsed as { event?: unknown }).event;
      if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") throw new AdapterError("fake billing: no event", "invalid", false);
      return event as BillingEvent;
    },
    getCustomerByEmail(email) {
      return Promise.resolve(provider.customers.get(email.trim().toLowerCase()) ?? null);
    },
    listSubscriptions(customerId) {
      return Promise.resolve(provider.subscriptions.get(customerId) ?? []);
    },
    createCheckoutLink() {
      provider.checkoutLinks += 1;
      return Promise.reject(new AdapterError("fake billing: checkout links are human-only", "invalid", false));
    },
  };
  return provider;
}

/** A webhook request carrying `event`, signed with `secret` at `at` (or tampered with after signing). */
export async function fakeBillingWebhook(event: BillingEvent, options: { secret: string; at?: Date; tamper?: boolean; unsigned?: boolean; url?: string }): Promise<Request> {
  const body = JSON.stringify({ event });
  const timestamp = String(Math.floor((options.at ?? new Date()).getTime() / 1000));
  const signature = await hmac(options.secret, `${timestamp}.${body}`);
  const sent = options.tamper ? body.replace(/"customerId":"[^"]*"/, '"customerId":"cus_tampered"') : body;
  return new Request(options.url ?? "https://agent.acme.example/api/webhooks/billing", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.unsigned ? {} : { [FAKE_BILLING_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}` }) },
    body: sent,
  });
}
