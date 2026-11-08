// GTM-agents: contract tests for the Exa adapter. Every response is recorded and synthetic: the
// companies, people and hostnames are invented, on *.example domains.
import { describe, expect, it } from "vitest";
import { runDiscoverySourceContract } from "../_contract/discovery-source.ts";
import { json } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { PRICES, createAdapter, mapSearchResponse } from "./index.ts";

const SEARCH = "https://api.exa.ai/search";
const secrets = { EXA_API_KEY: "test-exa-key" };

const accountResponse = {
  requestId: "req-account-1",
  results: [
    {
      id: "exa-result-1",
      url: "https://brightloop.example/",
      title: "Brightloop Labs: CI that tells you which tests lie",
      highlights: ["Brightloop runs CI on every pull request across 40 services."],
      entities: [{ id: "ent-1", type: "company", version: 2, properties: { name: "Brightloop Labs", workforce: { total: 120 } } }],
    },
    { id: "exa-result-2", url: "https://www.northwind-tools.example/about", title: "Northwind Tools | About us", summary: "Developer tooling for large test suites." },
    { url: "https://no-id.example/", title: "A result without an id is dropped" },
  ],
  costDollars: { total: 0.008, search: { neural: 0.005 }, contents: { highlights: 0.003 } },
};

const personResponse = {
  requestId: "req-person-1",
  results: [{ id: "exa-person-1", url: "https://profiles.example/in/jane-doe", title: "Jane Doe - Staff Engineer - Brightloop Labs | Profiles", highlights: ["Staff engineer working on build reliability."] }],
};

const accountQuery = { kind: "account" as const, text: "software companies discussing flaky tests in CI", limit: 10, excludeDomains: ["globex.example"] };

runDiscoverySourceContract(createAdapter, {
  manifest,
  secrets,
  failureQuery: accountQuery,
  searches: [
    {
      name: "account search with the reported cost",
      query: accountQuery,
      routes: [{ method: "POST", url: SEARCH, respond: json(accountResponse) }],
      expectedItems: 2,
      async check(page, requests) {
        const request = requests[0] as Request;
        expect(request.headers.get("x-api-key")).toBe("test-exa-key");
        const body = await request.clone().json<Record<string, unknown>>();
        expect(body).toMatchObject({ query: accountQuery.text, category: "company", numResults: 10, excludeDomains: ["globex.example"], type: "auto" });
        expect(page.items[0]).toMatchObject({ name: "Brightloop Labs", domain: "brightloop.example", providerRef: "exa-result-1" });
        expect(page.items[1]).toMatchObject({ domain: "northwind-tools.example", summary: "Developer tooling for large test suites." });
        expect(page.cost?.usd).toBe(0.008);
      },
    },
    {
      name: "person search, which sends no exclusions to the people category",
      query: { kind: "person", text: "staff engineers who own CI reliability", limit: 5, excludeDomains: ["globex.example"] },
      routes: [{ method: "POST", url: SEARCH, respond: json(personResponse) }],
      expectedItems: 1,
      async check(page, requests) {
        const body = await (requests[0] as Request).clone().json<Record<string, unknown>>();
        expect(body.category).toBe("people");
        expect(body.excludeDomains).toBeUndefined();
        expect(page.items[0]).toMatchObject({ kind: "person", name: "Jane Doe", title: "Staff Engineer", accountName: "Brightloop Labs" });
        expect(page.items[0]?.domain).toBeUndefined();
        // No reported cost: the estimate comes from the manifest's price table.
        expect(page.cost?.usd).toBeCloseTo(PRICES.search + PRICES.highlightsPerResult, 6);
      },
    },
  ],
  failures: [
    { name: "HTTP 400", routes: [{ url: SEARCH, respond: json({ error: "bad request" }, { status: 400 }) }], code: "invalid", retryable: false },
    { name: "HTTP 401", routes: [{ url: SEARCH, respond: json({ error: "invalid key" }, { status: 401 }) }], code: "auth", retryable: false },
    { name: "HTTP 402", routes: [{ url: SEARCH, respond: json({ error: "out of credits" }, { status: 402 }) }], code: "quota", retryable: false },
    { name: "HTTP 429", routes: [{ url: SEARCH, respond: json({ error: "slow down" }, { status: 429, headers: { "retry-after": "2" } }) }], code: "rate_limited", retryable: true },
    { name: "HTTP 503", routes: [{ url: SEARCH, respond: new Response("unavailable", { status: 503 }) }], code: "unavailable", retryable: true },
    { name: "a body that is not JSON", routes: [{ url: SEARCH, respond: new Response("<html>", { status: 200 }) }], code: "unknown", retryable: true },
    {
      name: "a network failure",
      routes: [
        {
          url: SEARCH,
          respond: () => {
            throw new TypeError("network connection lost");
          },
        },
      ],
      code: "unavailable",
      retryable: true,
    },
  ],
});

describe("the Exa adapter's price table", () => {
  it("matches the manifest", () => {
    expect(manifest.costs.search.usd).toBe(PRICES.search);
    expect(manifest.costs.search_large.usd).toBe(PRICES.searchLarge);
    expect(manifest.costs.highlights.usd).toBe(PRICES.highlightsPerResult);
  });

  it("estimates a large request at the larger price when the response reports none", () => {
    const page = mapSearchResponse({ results: [] }, { kind: "account", text: "q", limit: 50 }, "2026-11-04T12:00:00.000Z", 0);
    expect(page.cost?.usd).toBe(PRICES.searchLarge);
  });
});
