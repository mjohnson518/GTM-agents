// GTM-agents: the shared contract every EmailVerifier adapter runs in its contract.test.ts.
//
//   runEmailVerifierContract(createAdapter, fixtures)
//
// With recorded responses only, it checks that:
//   - the manifest validates and declares the EmailVerifier port;
//   - every vendor status the adapter documents (fixtures.vendorStatuses) has a recorded case, and
//     each maps to exactly one of the four port statuses: deliverable, risky, undeliverable or
//     unknown. Nothing else ever comes back;
//   - a score, when given, is from 0 to 100, and every result carries a cost attributed to the
//     adapter;
//   - the adapter uses only the injected fetch, and a missing secret fails before any request;
//   - each recorded failure becomes an AdapterError with the expected code and retryable flag.
// Cache lifetimes, confidence grades and the promotion policy are core's, not the adapter's.
import { AdapterError, VERIFICATION_STATUSES, manifestSchema, type AdapterContext, type AdapterErrorCode, type EmailVerifier, type VerificationStatus } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./context.ts";
import { recordedFetch, type RecordedRoute } from "./fetch.ts";

export interface EmailVerifierFixtures {
  manifest: unknown;
  secrets: Record<string, string>;
  options?: Record<string, unknown>;
  /** Every status the vendor can return. Each needs a case below. */
  vendorStatuses: readonly string[];
  cases: Array<{ vendorStatus: string; email: string; routes: RecordedRoute[]; expected: VerificationStatus }>;
  /** Responses that are not a vendor status but still complete (an inconclusive server answer, say). */
  extraCases?: Array<{ name: string; email: string; routes: RecordedRoute[]; expected: VerificationStatus }>;
  failures: Array<{ name: string; routes: RecordedRoute[]; code: AdapterErrorCode; retryable: boolean }>;
}

export function runEmailVerifierContract(create: (ctx: AdapterContext) => EmailVerifier, fixtures: EmailVerifierFixtures): void {
  describe("the EmailVerifier contract", () => {
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

    const ctxWith = (routes: RecordedRoute[], secrets = fixtures.secrets) => {
      const recorded = recordedFetch(routes);
      return { recorded, adapter: create(testContext({ secrets, fetch: recorded.fetch, ...(fixtures.options ? { options: fixtures.options } : {}) })) };
    };

    it("ships a valid manifest that declares the port", () => {
      const manifest = manifestSchema.parse(fixtures.manifest);
      expect(manifest.ports).toContain("EmailVerifier");
      expect(ctxWith([]).adapter.name).toBe(manifest.name);
    });

    it("has a recorded case for every vendor status, and only for those", () => {
      const covered = fixtures.cases.map((c) => c.vendorStatus).sort();
      expect(covered).toEqual([...new Set(fixtures.vendorStatuses)].sort());
      for (const c of fixtures.cases) expect(VERIFICATION_STATUSES).toContain(c.expected);
    });

    const all = [
      ...fixtures.cases.map((c) => ({ name: `vendor status "${c.vendorStatus}"`, ...c })),
      ...(fixtures.extraCases ?? []),
    ];
    for (const c of all) {
      it(`maps ${c.name} to exactly one port status (${c.expected})`, async () => {
        const { recorded, adapter } = ctxWith(c.routes);
        const result = await adapter.verify(c.email);
        expect(recorded.calls.length).toBeGreaterThan(0);
        expect(VERIFICATION_STATUSES).toContain(result.status);
        expect(result.status).toBe(c.expected);
        if (result.score !== undefined) {
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(100);
        }
        expect(result.cost?.provider).toBe(adapter.name);
        expect(result.cost?.usd !== undefined || result.cost?.credits !== undefined, "the cost has a price").toBe(true);
      });
    }

    it("fails without its secret, before sending any request", async () => {
      const first = fixtures.cases[0];
      const { recorded, adapter } = ctxWith(first?.routes ?? [], {});
      await expect(adapter.verify(first?.email ?? "nobody@vendor.example")).rejects.toThrow();
      expect(recorded.calls).toHaveLength(0);
    });

    for (const failure of fixtures.failures) {
      it(`maps ${failure.name} to an AdapterError (${failure.code}, ${failure.retryable ? "retryable" : "not retryable"})`, async () => {
        const { adapter } = ctxWith(failure.routes);
        const error: unknown = await adapter.verify(fixtures.cases[0]?.email ?? "nobody@vendor.example").then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AdapterError);
        expect((error as AdapterError).code).toBe(failure.code);
        expect((error as AdapterError).retryable).toBe(failure.retryable);
      });
    }
  });
}
