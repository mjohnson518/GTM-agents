// GTM-agents: the shared contract every ContactFinder adapter runs in its contract.test.ts.
//
//   runContactFinderContract(createAdapter, fixtures)
//
// With recorded responses only, it checks that:
//   - the manifest validates and declares the ContactFinder port;
//   - a found address comes back as given, with a confidence from 0 to 100, sources attributed to
//     the adapter, and a cost attributed to the adapter;
//   - "nothing found" is `{ email: null }` with a cost (often zero), never an error and never a
//     guessed address;
//   - the adapter uses only the injected fetch, and a missing secret fails before any request;
//   - each recorded failure becomes an AdapterError with the expected code and retryable flag.
// The adapter does not screen addresses (personal domains, role mailboxes, the account match):
// core does, after the call.
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type ContactFinder } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./context.ts";
import { recordedFetch, type RecordedRoute } from "./fetch.ts";

type FindArgs = Parameters<ContactFinder["findWorkEmail"]>[0];

export interface ContactFinderFixtures {
  manifest: unknown;
  secrets: Record<string, string>;
  options?: Record<string, unknown>;
  found: { args: FindArgs; routes: RecordedRoute[]; expectedEmail: string; check?: (requests: Request[]) => void | Promise<void> };
  notFound: Array<{ name: string; args: FindArgs; routes: RecordedRoute[] }>;
  failures: Array<{ name: string; routes: RecordedRoute[]; code: AdapterErrorCode; retryable: boolean }>;
}

export function runContactFinderContract(create: (ctx: AdapterContext) => ContactFinder, fixtures: ContactFinderFixtures): void {
  describe("the ContactFinder contract", () => {
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
      expect(manifest.ports).toContain("ContactFinder");
      expect(ctxWith([]).adapter.name).toBe(manifest.name);
    });

    it("returns a found address with a confidence, sources and a cost", async () => {
      const { recorded, adapter } = ctxWith(fixtures.found.routes);
      const result = await adapter.findWorkEmail(fixtures.found.args);
      expect(result.email).toBe(fixtures.found.expectedEmail);
      if (result.email === null) return;
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(100);
      for (const source of result.sources) {
        expect(source.provider).toBe(adapter.name);
        expect(Number.isNaN(Date.parse(source.retrievedAt))).toBe(false);
      }
      expect(result.cost?.provider).toBe(adapter.name);
      expect(result.cost?.usd !== undefined || result.cost?.credits !== undefined, "the cost has a price").toBe(true);
      await fixtures.found.check?.(recorded.calls);
    });

    for (const fixture of fixtures.notFound) {
      it(`returns no address, not an error or a guess, when ${fixture.name}`, async () => {
        const { adapter } = ctxWith(fixture.routes);
        const result = await adapter.findWorkEmail(fixture.args);
        expect(result.email).toBeNull();
        expect(result.cost?.provider ?? adapter.name).toBe(adapter.name);
      });
    }

    it("fails without its secret, before sending any request", async () => {
      const { recorded, adapter } = ctxWith(fixtures.found.routes, {});
      await expect(adapter.findWorkEmail(fixtures.found.args)).rejects.toThrow();
      expect(recorded.calls).toHaveLength(0);
    });

    for (const failure of fixtures.failures) {
      it(`maps ${failure.name} to an AdapterError (${failure.code}, ${failure.retryable ? "retryable" : "not retryable"})`, async () => {
        const { adapter } = ctxWith(failure.routes);
        const error: unknown = await adapter.findWorkEmail(fixtures.found.args).then(
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
