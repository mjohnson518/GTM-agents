// GTM-agents: the shared contract every BillingProvider adapter runs in its contract.test.ts.
//
//   runBillingProviderContract(createAdapter, fixtures)
//
// With recorded responses and locally signed webhooks only, it checks that:
//   - the manifest validates, declares the BillingProvider port and requires the webhook secret;
//   - parseWebhook rejects before reading the body when the secret is unset ("unavailable"), when
//     the request is unsigned, and when the signature's timestamp is more than 5 minutes old or
//     ahead ("auth"). Request.bodyUsed proves the body was never read;
//   - a tampered body, or one signed with another secret, is "auth";
//   - when the vendor sends several signatures (fixtures.multipleSignatures), one matching
//     signature among wrong ones is accepted, and only wrong ones are refused;
//   - every port event type has a recorded case (checkout_completed, subscription_created,
//     subscription_updated, subscription_canceled, payment_failed and ignored), each maps to
//     exactly the expected BillingEvent, amounts are non-negative integers in minor units, and the
//     time is ISO 8601 UTC;
//   - a signed body that is not an event the vendor sends is "invalid";
//   - getCustomerByEmail and listSubscriptions answer from recorded responses, a missing API key
//     fails before any request, and recorded failures become AdapterErrors with the expected code;
//   - the adapter uses only the injected fetch, never the global one.
// Routing, identity, erasure and MRR are core's, not the adapter's.
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type BillingEvent, type BillingProvider } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./context.ts";
import { recordedFetch, type RecordedRoute } from "./fetch.ts";

export const BILLING_EVENT_TYPES = ["checkout_completed", "subscription_created", "subscription_updated", "subscription_canceled", "payment_failed", "ignored"] as const;

export interface SignOptions {
  /** Seconds before `now` the signature claims; negative is in the future. */
  ageSeconds?: number;
  /** Sign with each of these secrets instead of the configured one (one signature per secret). */
  secrets?: readonly string[];
  /** Change the body after signing it. */
  tamper?: boolean;
  /** Send no signature at all. */
  unsigned?: boolean;
}

export interface BillingProviderFixtures {
  manifest: unknown;
  /** Every secret the adapter needs, set. */
  secrets: Record<string, string>;
  webhookSecretName: string;
  apiKeyName: string;
  options?: Record<string, unknown>;
  now: Date;
  /** A webhook request carrying `body`, signed the vendor's way. */
  request(body: string, options?: SignOptions): Promise<Request>;
  /** True when the vendor's header carries one signature per active secret. */
  multipleSignatures: boolean;
  /** One case per port event type at least. */
  events: Array<{ name: string; body: string; expected: BillingEvent }>;
  /** Signed bodies that are not vendor events. */
  invalidBodies: string[];
  customer: { email: string; routes: RecordedRoute[]; expected: Awaited<ReturnType<BillingProvider["getCustomerByEmail"]>> };
  unknownCustomer: { email: string; routes: RecordedRoute[] };
  subscriptions: { customerId: string; routes: RecordedRoute[]; expected: Awaited<ReturnType<BillingProvider["listSubscriptions"]>> };
  failures: Array<{ name: string; routes: RecordedRoute[]; code: AdapterErrorCode; retryable: boolean }>;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

async function adapterError(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error("expected an AdapterError, but the call succeeded");
}

export function runBillingProviderContract(create: (ctx: AdapterContext) => BillingProvider, fixtures: BillingProviderFixtures): void {
  describe("the BillingProvider contract", () => {
    let globalFetch: { mock: { calls: unknown[] }; mockRestore(): void };
    beforeEach(() => {
      globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("adapters use ctx.fetch, never the global fetch");
      });
    });
    afterEach(() => {
      const calls = globalFetch.mock.calls.length;
      globalFetch.mockRestore();
      expect(calls, "the adapter called the global fetch").toBe(0);
    });

    const adapterWith = (routes: RecordedRoute[] = [], secrets = fixtures.secrets) => {
      const recorded = recordedFetch(routes);
      return { recorded, adapter: create(testContext({ secrets, fetch: recorded.fetch, now: fixtures.now, ...(fixtures.options ? { options: fixtures.options } : {}) })) };
    };
    const sample = fixtures.events[0]?.body ?? "{}";

    it("has a manifest that validates and declares the port and its webhook secret", () => {
      const manifest = manifestSchema.parse(fixtures.manifest);
      expect(manifest.ports).toContain("BillingProvider");
      expect(manifest.requiredSecrets).toContain(fixtures.webhookSecretName);
      expect(manifest.requiredSecrets).toContain(fixtures.apiKeyName);
    });

    it("refuses before reading the body when the secret is unset, the request is unsigned, or the timestamp is stale", async () => {
      const without = { ...fixtures.secrets };
      delete without[fixtures.webhookSecretName];
      const unset = await fixtures.request(sample);
      expect((await adapterError(adapterWith([], without).adapter.parseWebhook(unset))).code).toBe("unavailable");
      expect(unset.bodyUsed).toBe(false);
      for (const [name, options] of [
        ["unsigned", { unsigned: true }],
        ["six minutes old", { ageSeconds: 360 }],
        ["six minutes ahead", { ageSeconds: -360 }],
      ] as const) {
        const request = await fixtures.request(sample, options);
        const error = await adapterError(adapterWith().adapter.parseWebhook(request));
        expect(error.code, name).toBe("auth");
        expect(request.bodyUsed, name).toBe(false);
      }
    });

    it("accepts a signature just inside the tolerance and refuses a tampered body or another secret", async () => {
      await expect(adapterWith().adapter.parseWebhook(await fixtures.request(sample, { ageSeconds: 290 }))).resolves.toBeTruthy();
      expect((await adapterError(adapterWith().adapter.parseWebhook(await fixtures.request(sample, { tamper: true })))).code).toBe("auth");
      expect((await adapterError(adapterWith().adapter.parseWebhook(await fixtures.request(sample, { secrets: ["x".repeat(48)] })))).code).toBe("auth");
    });

    it.runIf(fixtures.multipleSignatures)("accepts one matching signature among several and refuses only wrong ones", async () => {
      const right = fixtures.secrets[fixtures.webhookSecretName] ?? "";
      await expect(adapterWith().adapter.parseWebhook(await fixtures.request(sample, { secrets: ["x".repeat(48), right, "y".repeat(48)] }))).resolves.toBeTruthy();
      expect((await adapterError(adapterWith().adapter.parseWebhook(await fixtures.request(sample, { secrets: ["x".repeat(48), "y".repeat(48)] })))).code).toBe("auth");
    });

    it("has a case for every port event type", () => {
      const covered = new Set(fixtures.events.map((e) => e.expected.type));
      for (const type of BILLING_EVENT_TYPES) expect(covered.has(type), type).toBe(true);
    });

    for (const event of fixtures.events) {
      it(`maps ${event.name}`, async () => {
        const mapped = await adapterWith().adapter.parseWebhook(await fixtures.request(event.body));
        expect(mapped).toEqual(event.expected);
        // Core treats an event not marked live as test mode, so every event says which it is.
        if (mapped.type !== "ignored") expect(typeof mapped.livemode, `${event.name}: livemode`).toBe("boolean");
        expect(mapped.providerEventId.length).toBeGreaterThan(0);
        if (mapped.type !== "ignored") {
          expect(mapped.at).toMatch(ISO_UTC);
          expect(mapped.customerId.length).toBeGreaterThan(0);
          if (mapped.amount !== undefined) expect(Number.isInteger(mapped.amount) && mapped.amount >= 0, "amount in minor units").toBe(true);
        }
      });
    }

    it("refuses a signed body that is not a vendor event", async () => {
      for (const body of fixtures.invalidBodies) expect((await adapterError(adapterWith().adapter.parseWebhook(await fixtures.request(body)))).code, body).toBe("invalid");
    });

    it("looks customers and subscriptions up through the injected fetch", async () => {
      expect(await adapterWith(fixtures.customer.routes).adapter.getCustomerByEmail(fixtures.customer.email)).toEqual(fixtures.customer.expected);
      expect(await adapterWith(fixtures.unknownCustomer.routes).adapter.getCustomerByEmail(fixtures.unknownCustomer.email)).toBeNull();
      const subscriptions = await adapterWith(fixtures.subscriptions.routes).adapter.listSubscriptions(fixtures.subscriptions.customerId);
      expect(subscriptions).toEqual(fixtures.subscriptions.expected);
      for (const s of subscriptions) if (s.amount !== undefined) expect(Number.isInteger(s.amount) && s.amount >= 0).toBe(true);
    });

    it("fails before any request when the API key is missing", async () => {
      const without = { ...fixtures.secrets };
      delete without[fixtures.apiKeyName];
      const { recorded, adapter } = adapterWith(fixtures.customer.routes, without);
      expect((await adapterError(adapter.getCustomerByEmail(fixtures.customer.email))).code).toBe("auth");
      expect((await adapterError(adapter.listSubscriptions(fixtures.subscriptions.customerId))).code).toBe("auth");
      expect(recorded.calls).toHaveLength(0);
    });

    for (const failure of fixtures.failures) {
      it(`maps a failure: ${failure.name}`, async () => {
        const error = await adapterError(adapterWith(failure.routes).adapter.listSubscriptions(fixtures.subscriptions.customerId));
        expect(error.code).toBe(failure.code);
        expect(error.retryable).toBe(failure.retryable);
      });
    }
  });
}
