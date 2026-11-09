// GTM-agents: contract tests for the Exa adapter. Every response is recorded and synthetic: the
// companies, people and hostnames are invented, on *.example domains.
import { describe, expect, it } from "vitest";
import { runDiscoverySourceContract } from "../_contract/discovery-source.ts";
import { json } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { testContext } from "../_contract/context.ts";
import { recordedFetch } from "../_contract/fetch.ts";
import { PRICES, WEBSET_CREDITS, createAdapter, mapSearchResponse, parseMonitorDelivery, signMonitorDelivery, verifyMonitorSignature } from "./index.ts";

const SEARCH = "https://api.exa.ai/search";
const secrets = { EXA_API_KEY: "test-exa-key" };
const BASE = "https://api.exa.ai";
const now = new Date("2026-11-04T12:00:00.000Z");
const adapterWith = (routes: Parameters<typeof recordedFetch>[0]) => {
  const recorded = recordedFetch(routes);
  return { recorded, adapter: createAdapter(testContext({ secrets, fetch: recorded.fetch, now })) };
};

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

describe("websets (the watch capability)", () => {
  const created = { id: "webset_synthetic_1", status: "running", createdAt: "2026-11-04T11:00:00.000Z" };
  const items = {
    data: [
      {
        id: "witem-1",
        createdAt: "2026-11-04T11:30:00.000Z",
        properties: { type: "person", url: "https://profiles.example/in/sam-lee", person: { name: "Sam Lee", position: "Head of Platform", company: { name: "Brightloop Labs" } } },
        enrichments: [{ format: "email", status: "completed", result: ["sam.lee@brightloop.example"], enrichmentId: "en-1" }],
      },
      { id: "witem-old", createdAt: "2026-11-01T09:00:00.000Z", properties: { type: "person", url: "https://profiles.example/in/old", person: { name: "Old Item", position: "CTO" } } },
      { id: "witem-2", createdAt: "2026-11-04T11:40:00.000Z", properties: { type: "person", url: "https://profiles.example/in/no-email", person: { name: "Ira Park", position: "Staff Engineer", company: null } }, enrichments: [{ format: "email", status: "pending", result: null }] },
      { id: "witem-3", createdAt: "2026-11-04T11:41:00.000Z", properties: { type: "person", person: {} } },
    ],
    hasMore: false,
    nextCursor: null,
  };

  it("creates a person webset with the criteria and an email enrichment", async () => {
    const { recorded, adapter } = adapterWith([{ method: "POST", url: `${BASE}/websets/v0/websets`, respond: json(created, { status: 201 }) }]);
    const handle = await adapter.createWatch({ kind: "person", text: "platform leaders at software companies with flaky CI", limit: 25 });
    expect(handle).toEqual({ id: "webset_synthetic_1", provider: "data-exa", createdAt: "2026-11-04T11:00:00.000Z" });
    const body = await (recorded.calls[0] as Request).clone().json<Record<string, unknown>>();
    expect(body).toMatchObject({ search: { query: "platform leaders at software companies with flaky CI", count: 25, entity: { type: "person" } }, enrichments: [{ format: "email" }] });
  });

  it("polls items newer than the last poll, with the address an enrichment found, and prices them in credits", async () => {
    const { recorded, adapter } = adapterWith([{ method: "GET", url: `${BASE}/websets/v0/websets/webset_synthetic_1/items?limit=100`, respond: json(items) }]);
    const page = await adapter.pollWatch({ id: "webset_synthetic_1", provider: "data-exa", createdAt: created.createdAt }, "2026-11-02T00:00:00.000Z");
    expect(recorded.calls).toHaveLength(1);
    expect(page.items.map((i) => i.providerRef)).toEqual(["witem-1", "witem-2"]);
    expect(page.items[0]).toMatchObject({ kind: "person", name: "Sam Lee", title: "Head of Platform", accountName: "Brightloop Labs", email: "sam.lee@brightloop.example" });
    expect(page.items[1]).not.toHaveProperty("email");
    expect(page.cost).toMatchObject({ provider: "data-exa", capability: "webset_items", credits: 2 * WEBSET_CREDITS.item + WEBSET_CREDITS.email });
    expect(page.cost?.usd).toBeCloseTo((2 * WEBSET_CREDITS.item + WEBSET_CREDITS.email) * 0.006, 6);
  });

  it("refuses a webset id that could change the request path", async () => {
    const { recorded, adapter } = adapterWith([]);
    await expect(adapter.pollWatch({ id: "../../search", provider: "data-exa", createdAt: created.createdAt })).rejects.toMatchObject({ code: "invalid" });
    expect(recorded.calls).toHaveLength(0);
  });

  it("deletes a webset", async () => {
    const { recorded, adapter } = adapterWith([{ method: "DELETE", url: `${BASE}/websets/v0/websets/webset_synthetic_1`, respond: json({ id: "webset_synthetic_1" }) }]);
    await adapter.deleteWatch({ id: "webset_synthetic_1", provider: "data-exa", createdAt: created.createdAt });
    expect(recorded.calls[0]?.method).toBe("DELETE");
  });
});

describe("find-similar", () => {
  it("asks for companies like the seed, excluding the seed's domain and the exclusions", async () => {
    const response = { results: [{ id: "sim-1", url: "https://quillstack.example/", title: "Quillstack" }, { id: "sim-2", url: "https://www.tidewater.example/", title: "Tidewater" }], costDollars: { total: 0.006 } };
    const { recorded, adapter } = adapterWith([{ method: "POST", url: `${BASE}/findSimilar`, respond: json(response) }]);
    const page = await adapter.findSimilar({ url: "https://brightloop.example/", limit: 10, excludeDomains: ["globex.example"] });
    const body = await (recorded.calls[0] as Request).clone().json<Record<string, unknown>>();
    expect(body).toMatchObject({ url: "https://brightloop.example/", numResults: 10, excludeSourceDomain: true, excludeDomains: ["globex.example"] });
    expect(page.items.map((i) => i.domain)).toEqual(["quillstack.example", "tidewater.example"]);
    expect(page.cost).toMatchObject({ provider: "data-exa", capability: "find_similar", usd: 0.006 });
  });

  it("maps a failure to an AdapterError", async () => {
    const { adapter } = adapterWith([{ url: `${BASE}/findSimilar`, respond: json({ error: "slow down" }, { status: 429 }) }]);
    await expect(adapter.findSimilar({ url: "https://brightloop.example/", limit: 5 })).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });
});

describe("dated news search", () => {
  it("searches the news category from a published-date floor and keeps the reported dates", async () => {
    const response = {
      results: [
        { id: "news-1", url: "https://news.example/brightloop-series-b", title: "Brightloop Labs raises Series B", publishedDate: "2026-10-28T00:00:00.000Z" },
        { id: "news-2", url: "https://news.example/undated", title: "An undated story" },
        { id: "news-3", title: "No URL" },
      ],
    };
    const { recorded, adapter } = adapterWith([{ method: "POST", url: `${BASE}/search`, respond: json(response) }]);
    const page = await adapter.searchNews({ text: "software company raises funding round", since: "2026-10-05T00:00:00.000Z", limit: 25 });
    const body = await (recorded.calls[0] as Request).clone().json<Record<string, unknown>>();
    expect(body).toMatchObject({ category: "news", startPublishedDate: "2026-10-05T00:00:00.000Z", numResults: 25 });
    expect(page.items).toEqual([
      { title: "Brightloop Labs raises Series B", url: "https://news.example/brightloop-series-b", providerRef: "news-1", publishedAt: "2026-10-28T00:00:00.000Z" },
      { title: "An undated story", url: "https://news.example/undated", providerRef: "news-2" },
    ]);
    expect(page.cost).toMatchObject({ provider: "data-exa", capability: "news", usd: PRICES.news });
  });
});

describe("search monitor deliveries", () => {
  const secret = "m".repeat(48);
  const body = JSON.stringify({ id: "evt-1", object: "event", type: "monitor.run.completed", data: { id: "run-1", results: [{ id: "r-1", url: "https://quillstack.example/blog/ci", title: "Quillstack on CI" }, { id: "r-2" }] } });
  const t = Math.floor(now.getTime() / 1000);

  it("accepts a delivery signed with the monitor's secret, and only that", async () => {
    const sig = await signMonitorDelivery(secret, t, body);
    const ok = new Headers({ "exa-signature": `t=${t},v1=${"0".repeat(64)},v1=${sig}` });
    expect(await verifyMonitorSignature({ secret, headers: ok, rawBody: body, now })).toBe(true);
    expect(await verifyMonitorSignature({ secret: "n".repeat(48), headers: ok, rawBody: body, now })).toBe(false);
    expect(await verifyMonitorSignature({ secret, headers: ok, rawBody: `${body} `, now })).toBe(false);
    expect(await verifyMonitorSignature({ secret, headers: new Headers(), rawBody: body, now })).toBe(false);
  });

  it("refuses a delivery older than five minutes", async () => {
    const old = t - 6 * 60;
    const headers = new Headers({ "exa-signature": `t=${old},v1=${await signMonitorDelivery(secret, old, body)}` });
    expect(await verifyMonitorSignature({ secret, headers, rawBody: body, now })).toBe(false);
  });

  it("parses the results of a monitor run, and nothing from other events", () => {
    expect(parseMonitorDelivery(JSON.parse(body))).toEqual([{ providerRef: "r-1", url: "https://quillstack.example/blog/ci", title: "Quillstack on CI" }]);
    expect(parseMonitorDelivery({ type: "webset.created", data: { id: "ws" } })).toBeNull();
    expect(parseMonitorDelivery("not an event")).toBeNull();
  });
});

describe("the extended price table", () => {
  it("matches the manifest", () => {
    expect(manifest.costs.find_similar.usd).toBe(PRICES.findSimilar);
    expect(manifest.costs.news.usd).toBe(PRICES.news);
    expect(manifest.costs.webset_item.credits).toBe(WEBSET_CREDITS.item);
    expect(manifest.costs.webset_email.credits).toBe(WEBSET_CREDITS.email);
  });
});
