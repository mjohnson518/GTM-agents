// GTM-agents: contract tests for the Hunter adapter. Every response is recorded and synthetic: the
// companies, people, addresses and hostnames are invented, on *.example domains.
import { describe, expect, it } from "vitest";
import { runContactFinderContract } from "../_contract/contact-finder.ts";
import { testContext } from "../_contract/context.ts";
import { runEmailVerifierContract } from "../_contract/email-verifier.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { CREDITS, DEFAULT_USD_PER_CREDIT, VENDOR_STATUS_MAP, createAdapter, mapVendorStatus } from "./index.ts";

const secrets = { HUNTER_API_KEY: "test-hunter-key" };
const FINDER = /^https:\/\/api\.hunter\.io\/v2\/email-finder\?/;
const VERIFIER = /^https:\/\/api\.hunter\.io\/v2\/email-verifier\?/;
const DOMAIN_SEARCH = /^https:\/\/api\.hunter\.io\/v2\/domain-search\?/;
const args = { firstName: "Jane", lastName: "Doe", domain: "brightloop.example" };

const finderFound = {
  data: {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@brightloop.example",
    score: 94,
    domain: "brightloop.example",
    accept_all: false,
    position: "Staff Engineer",
    company: "Brightloop Labs",
    sources: [{ domain: "brightloop.example", uri: "https://brightloop.example/team", extracted_on: "2026-10-01", last_seen_on: "2026-10-20", still_on_page: true }],
    verification: { date: "2026-10-20", status: "valid" },
  },
  meta: { params: { domain: "brightloop.example" } },
};

const verification = (status: string, extra: Record<string, unknown> = {}) => ({
  data: {
    status,
    score: status === "valid" ? 96 : 40,
    email: "jane.doe@brightloop.example",
    regexp: true,
    gibberish: false,
    disposable: status === "disposable",
    webmail: status === "webmail",
    mx_records: true,
    smtp_server: true,
    smtp_check: status === "valid",
    accept_all: status === "accept_all",
    block: false,
    ...extra,
  },
});

const verifierRoute = (body: unknown, status = 200): RecordedRoute[] => [{ method: "GET", url: VERIFIER, respond: json(body, { status }) }];

runContactFinderContract(createAdapter, {
  manifest,
  secrets,
  found: {
    args,
    routes: [{ method: "GET", url: FINDER, respond: json(finderFound) }],
    expectedEmail: "jane.doe@brightloop.example",
    check(requests) {
      const url = new URL((requests[0] as Request).url);
      expect(url.searchParams.get("domain")).toBe("brightloop.example");
      expect(url.searchParams.get("first_name")).toBe("Jane");
      expect(url.searchParams.get("last_name")).toBe("Doe");
      expect(url.searchParams.get("api_key"), "the key travels in a header, never the URL").toBeNull();
      expect((requests[0] as Request).headers.get("x-api-key")).toBe("test-hunter-key");
    },
  },
  notFound: [
    { name: "the finder has no address", args, routes: [{ url: FINDER, respond: json({ data: { email: null, score: null } }) }] },
    { name: "the finder answers 404", args, routes: [{ url: FINDER, respond: json({ errors: [{ id: "not_found" }] }, { status: 404 }) }] },
    { name: "the person asked not to be processed (451)", args, routes: [{ url: FINDER, respond: json({ errors: [{ id: "claimed_email" }] }, { status: 451 }) }] },
  ],
  failures: [
    { name: "HTTP 400", routes: [{ url: FINDER, respond: json({ errors: [] }, { status: 400 }) }], code: "invalid", retryable: false },
    { name: "HTTP 401", routes: [{ url: FINDER, respond: json({ errors: [] }, { status: 401 }) }], code: "auth", retryable: false },
    { name: "HTTP 403 (the rate limit)", routes: [{ url: FINDER, respond: json({ errors: [] }, { status: 403 }) }], code: "rate_limited", retryable: true },
    { name: "HTTP 429 (the plan quota)", routes: [{ url: FINDER, respond: json({ errors: [] }, { status: 429 }) }], code: "quota", retryable: false },
    { name: "HTTP 502", routes: [{ url: FINDER, respond: new Response("bad gateway", { status: 502 }) }], code: "unavailable", retryable: true },
    {
      name: "a network failure",
      routes: [
        {
          url: FINDER,
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

runEmailVerifierContract(createAdapter, {
  manifest,
  secrets,
  vendorStatuses: Object.keys(VENDOR_STATUS_MAP),
  cases: Object.entries(VENDOR_STATUS_MAP).map(([vendorStatus, expected]) => ({
    vendorStatus,
    email: "jane.doe@brightloop.example",
    routes: verifierRoute(verification(vendorStatus)),
    expected,
  })),
  extraCases: [
    { name: "a legacy result field with no status", email: "jane.doe@brightloop.example", routes: verifierRoute({ data: { result: "deliverable", score: 91 } }), expected: "deliverable" },
    { name: "an unrecognized status", email: "jane.doe@brightloop.example", routes: verifierRoute(verification("brand_new_status")), expected: "unknown" },
    { name: "an unexpected mail server answer (222)", email: "jane.doe@brightloop.example", routes: verifierRoute({ data: {} }, 222), expected: "unknown" },
    { name: "a refusal to process the person (451)", email: "jane.doe@brightloop.example", routes: verifierRoute({ errors: [] }, 451), expected: "unknown" },
  ],
  failures: [
    { name: "a verification still in progress (202)", routes: verifierRoute({ data: null }, 202), code: "unavailable", retryable: true },
    { name: "HTTP 401", routes: verifierRoute({ errors: [] }, 401), code: "auth", retryable: false },
    { name: "HTTP 429 (the plan quota)", routes: verifierRoute({ errors: [] }, 429), code: "quota", retryable: false },
    { name: "HTTP 500", routes: verifierRoute({ errors: [] }, 500), code: "unavailable", retryable: true },
  ],
});

describe("the Hunter adapter as a PeopleProvider", () => {
  const domainSearch = {
    data: {
      domain: "brightloop.example",
      organization: "Brightloop Labs",
      pattern: "{first}.{last}",
      emails: [
        { value: "jane.doe@brightloop.example", type: "personal", confidence: 92, first_name: "Jane", last_name: "Doe", position: "Staff Engineer", seniority: "senior", department: "it", sources: [{ uri: "https://brightloop.example/team" }] },
        { value: "info@brightloop.example", type: "generic", confidence: 99, first_name: null, last_name: null, position: null },
        { value: "x7@brightloop.example", type: "personal", confidence: 50, first_name: null, last_name: null, position: "Engineer" },
      ],
    },
    meta: { results: 25, limit: 10, offset: 0 },
  };

  it("lists named people at a domain, skipping generic addresses, with a cursor and a cost", async () => {
    const recorded = recordedFetch([{ method: "GET", url: DOMAIN_SEARCH, respond: json(domainSearch) }]);
    const adapter = createAdapter(testContext({ secrets, fetch: recorded.fetch }));
    const page = await adapter.searchPeople({ accountDomains: ["brightloop.example"], seniority: ["vp", "senior"], limit: 10 });
    const url = new URL((recorded.calls[0] as Request).url);
    expect(url.searchParams.get("domain")).toBe("brightloop.example");
    expect(url.searchParams.get("type")).toBe("personal");
    expect(url.searchParams.get("seniority")).toBe("executive,senior");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ firstName: "Jane", lastName: "Doe", fullName: "Jane Doe", title: "Staff Engineer", accountDomain: "brightloop.example", email: "jane.doe@brightloop.example" });
    expect(page.items[0]?.providerRef).toMatch(/^hunter:[0-9a-f]{24}$/);
    expect(page.items[0]?.providerRef).not.toContain("jane");
    expect(page.cursor).toBe("10");
    expect(page.cost).toMatchObject({ provider: "data-hunter", credits: 1, usd: DEFAULT_USD_PER_CREDIT });
  });

  it("asks nothing, and costs nothing, without a domain", async () => {
    const recorded = recordedFetch([]);
    const adapter = createAdapter(testContext({ secrets, fetch: recorded.fetch }));
    expect(await adapter.searchPeople({ limit: 10 })).toMatchObject({ items: [], cost: { credits: 0 } });
    expect(recorded.calls).toHaveLength(0);
  });

  it("matches one person by full name at a domain", async () => {
    const recorded = recordedFetch([{ method: "GET", url: FINDER, respond: json(finderFound) }]);
    const adapter = createAdapter(testContext({ secrets, fetch: recorded.fetch }));
    const { record, cost } = await adapter.matchPerson({ fullName: "Jane Doe", accountDomain: "brightloop.example" });
    expect(new URL((recorded.calls[0] as Request).url).searchParams.get("full_name")).toBe("Jane Doe");
    expect(record).toMatchObject({ fullName: "Jane Doe", title: "Staff Engineer", accountName: "Brightloop Labs", email: "jane.doe@brightloop.example" });
    expect(cost).toMatchObject({ credits: CREDITS.find });
    expect(await adapter.matchPerson({ fullName: "Jane Doe" })).toEqual({ record: null });
  });
});

describe("the Hunter adapter's mapping and prices", () => {
  it("maps every vendor status to one of the four, and anything unrecognized to unknown", () => {
    expect(mapVendorStatus("valid")).toBe("deliverable");
    expect(mapVendorStatus("accept_all")).toBe("risky");
    expect(mapVendorStatus(undefined, "undeliverable")).toBe("undeliverable");
    expect(mapVendorStatus("toString")).toBe("unknown");
    expect(mapVendorStatus(42)).toBe("unknown");
  });

  it("prices calls from the manifest's credit table at the configured price per credit", async () => {
    expect(manifest.costs.email_find.credits).toBe(CREDITS.find);
    expect(manifest.costs.email_verify.credits).toBe(CREDITS.verify);
    expect(manifest.costs.people_search.credits).toBe(CREDITS.peopleSearchPerTen);
    expect(manifest.costs.email_find.usd).toBe(CREDITS.find * DEFAULT_USD_PER_CREDIT);
    const recorded = recordedFetch(verifierRoute(verification("valid")));
    const adapter = createAdapter(testContext({ secrets, fetch: recorded.fetch, options: { usdPerCredit: 0.1 } }));
    expect((await adapter.verify("jane.doe@brightloop.example")).cost).toMatchObject({ credits: 0.5, usd: 0.05 });
  });
});
