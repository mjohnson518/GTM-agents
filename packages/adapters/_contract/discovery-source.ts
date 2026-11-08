// GTM-agents: the shared contract every DiscoverySource adapter runs in its contract.test.ts.
//
//   runDiscoverySourceContract(createAdapter, fixtures)
//
// It drives the adapter with recorded responses only (fixtures.searches and fixtures.failures),
// and checks that:
//   - the manifest validates, declares the DiscoverySource port, and its capabilities match the
//     optional methods the adapter implements (research; createWatch, pollWatch and deleteWatch);
//   - search returns well-formed candidates: the query's kind, a name, a unique providerRef, an
//     http(s) URL and a lowercase bare domain when present, evidence attributed to the adapter with
//     an ISO timestamp, never more items than the query's limit, and a cost attributed to the
//     adapter;
//   - the adapter uses only the injected fetch, never the global one;
//   - a missing secret fails the call before any request is sent;
//   - each recorded failure becomes an AdapterError with the expected code and retryable flag.
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type Candidate, type DiscoveryQuery, type DiscoverySource, type Page } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./context.ts";
import { recordedFetch, type RecordedRoute } from "./fetch.ts";

export interface DiscoverySearchFixture {
  name: string;
  query: DiscoveryQuery;
  routes: RecordedRoute[];
  expectedItems: number;
  /** Extra assertions on the page and the requests the adapter sent. */
  check?: (page: Page<Candidate>, requests: Request[]) => void | Promise<void>;
}

export interface AdapterFailureFixture {
  name: string;
  routes: RecordedRoute[];
  code: AdapterErrorCode;
  retryable: boolean;
}

export interface DiscoverySourceFixtures {
  manifest: unknown;
  secrets: Record<string, string>;
  options?: Record<string, unknown>;
  searches: DiscoverySearchFixture[];
  /** A query to send in the failure and missing-secret cases. */
  failureQuery: DiscoveryQuery;
  failures: AdapterFailureFixture[];
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function runDiscoverySourceContract(create: (ctx: AdapterContext) => DiscoverySource, fixtures: DiscoverySourceFixtures): void {
  describe("the DiscoverySource contract", () => {
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

    it("ships a valid manifest that declares the port, with capabilities matching its optional methods", () => {
      const manifest = manifestSchema.parse(fixtures.manifest);
      expect(manifest.ports).toContain("DiscoverySource");
      const { adapter } = ctxWith([]);
      expect(adapter.name).toBe(manifest.name);
      expect(manifest.capabilities.includes("research"), "research capability").toBe(typeof adapter.research === "function");
      const watch = typeof adapter.createWatch === "function" && typeof adapter.pollWatch === "function" && typeof adapter.deleteWatch === "function";
      const anyWatch = typeof adapter.createWatch === "function" || typeof adapter.pollWatch === "function" || typeof adapter.deleteWatch === "function";
      expect(anyWatch, "watch needs createWatch, pollWatch and deleteWatch together").toBe(watch);
      expect(manifest.capabilities.includes("watch"), "watch capability").toBe(watch);
    });

    for (const fixture of fixtures.searches) {
      it(`returns well-formed candidates: ${fixture.name}`, async () => {
        const { recorded, adapter } = ctxWith(fixture.routes);
        const page = await adapter.search(fixture.query);
        expect(recorded.calls.length).toBeGreaterThan(0);
        expect(page.items).toHaveLength(fixture.expectedItems);
        expect(page.items.length).toBeLessThanOrEqual(fixture.query.limit);
        const refs = new Set<string>();
        for (const item of page.items) {
          expect(item.kind).toBe(fixture.query.kind);
          expect(typeof item.name === "string" && item.name.trim().length > 0, "name").toBe(true);
          expect(typeof item.providerRef === "string" && item.providerRef.length > 0, "providerRef").toBe(true);
          expect(refs.has(item.providerRef), `providerRef ${item.providerRef} is repeated`).toBe(false);
          refs.add(item.providerRef);
          if (item.url !== undefined) expect(["http:", "https:"]).toContain(new URL(item.url).protocol);
          if (item.domain !== undefined) expect(item.domain).toMatch(DOMAIN);
          expect(Array.isArray(item.evidence)).toBe(true);
          for (const e of item.evidence) {
            expect(e.provider).toBe(adapter.name);
            expect(Number.isNaN(Date.parse(e.retrievedAt))).toBe(false);
          }
        }
        expect(page.cost, "every paid call reports its cost").toBeDefined();
        expect(page.cost?.provider).toBe(adapter.name);
        expect((page.cost?.usd ?? 0) >= 0 && (page.cost?.credits ?? 0) >= 0).toBe(true);
        expect(page.cost?.usd !== undefined || page.cost?.credits !== undefined, "the cost has a price").toBe(true);
        await fixture.check?.(page, recorded.calls);
      });
    }

    it("fails without its secret, before sending any request", async () => {
      const { recorded, adapter } = ctxWith(fixtures.searches[0]?.routes ?? [], {});
      await expect(adapter.search(fixtures.failureQuery)).rejects.toThrow();
      expect(recorded.calls).toHaveLength(0);
    });

    for (const failure of fixtures.failures) {
      it(`maps ${failure.name} to an AdapterError (${failure.code}, ${failure.retryable ? "retryable" : "not retryable"})`, async () => {
        const { adapter } = ctxWith(failure.routes);
        const error: unknown = await adapter.search(fixtures.failureQuery).then(
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
