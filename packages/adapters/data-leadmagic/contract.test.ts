// GTM-agents: contract tests for the LeadMagic adapter. Every response is recorded and synthetic: the
// companies, people, addresses, profile URLs and hostnames are invented, on *.example domains.
import { describe, expect, it } from "vitest";
import { EMPLOYMENT_STATUSES, manifestSchema } from "@gtm-agents/core/ports";
import { runContactFinderContract } from "../_contract/contact-finder.ts";
import { testContext } from "../_contract/context.ts";
import { runEmailVerifierContract } from "../_contract/email-verifier.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { CREDITS, DEFAULT_USD_PER_CREDIT, JOB_STATUS_MAP, NAME, VENDOR_STATUS_MAP, createAdapter } from "./index.ts";

const secrets = { LEADMAGIC_API_KEY: "test-leadmagic-key" };
const FINDER = "https://api.leadmagic.io/v1/people/email-finder";
const VALIDATION = "https://api.leadmagic.io/v1/people/email-validation";
const JOB_CHANGE = "https://api.leadmagic.io/v1/people/job-change-detector";
const PROFILE = "https://profiles.example/in/jane-doe";
const args = { firstName: "Jane", lastName: "Doe", domain: "brightloop.example" };

const found = { email: "jane.doe@brightloop.example", status: "valid", credits_consumed: 1, message: "Valid email found.", first_name: "Jane", last_name: "Doe", domain: "brightloop.example", company_name: "Brightloop Labs" };
const notFound = { email: null, status: null, credits_consumed: 0, message: "No email found." };
const failure = (status: number, headers: Record<string, string> = {}) => json({ success: false, errors: [{ status, code: "error" }] }, { status, headers });

function adapter(routes: RecordedRoute[], options: Record<string, unknown> = {}) {
  const recorded = recordedFetch(routes);
  return { sink: createAdapter(testContext({ secrets, fetch: recorded.fetch, options })), calls: recorded.calls };
}

runContactFinderContract(createAdapter, {
  manifest,
  secrets,
  found: {
    args: { ...args, profileUrl: PROFILE },
    routes: [{ method: "POST", url: FINDER, respond: json(found) }],
    expectedEmail: "jane.doe@brightloop.example",
    async check(requests) {
      const request = requests[0] as Request;
      expect(request.headers.get("x-api-key")).toBe("test-leadmagic-key");
      expect(new URL(request.url).search, "the key travels in a header, never the URL").toBe("");
      expect(await request.json()).toEqual({ first_name: "Jane", last_name: "Doe", domain: "brightloop.example", profile_url: PROFILE });
    },
  },
  notFound: [
    { name: "the finder has no address", args, routes: [{ url: FINDER, respond: json(notFound) }] },
    { name: "the only address is on an unrelated domain", args, routes: [{ url: FINDER, respond: json({ ...found, domain_mismatch: true, credits_consumed: 0 }) }] },
    { name: "the address is not validated", args, routes: [{ url: FINDER, respond: json({ ...found, status: null, credits_consumed: 0 }) }] },
  ],
  failures: [
    { name: "HTTP 400", routes: [{ url: FINDER, respond: failure(400) }], code: "invalid", retryable: false },
    { name: "HTTP 401", routes: [{ url: FINDER, respond: failure(401) }], code: "auth", retryable: false },
    { name: "HTTP 402 (out of credits)", routes: [{ url: FINDER, respond: failure(402) }], code: "quota", retryable: false },
    { name: "HTTP 429", routes: [{ url: FINDER, respond: failure(429, { "retry-after": "3" }) }], code: "rate_limited", retryable: true },
    { name: "HTTP 500", routes: [{ url: FINDER, respond: failure(500) }], code: "unavailable", retryable: true },
    { name: "a body that is not JSON", routes: [{ url: FINDER, respond: new Response("<html>", { status: 200 }) }], code: "unknown", retryable: true },
  ],
});

const validation = (status: string, credits: number) => [{ method: "POST", url: VALIDATION, respond: json({ email: "jane.doe@brightloop.example", email_status: status, credits_consumed: credits, message: "" }) }];

runEmailVerifierContract(createAdapter, {
  manifest,
  secrets,
  vendorStatuses: Object.keys(VENDOR_STATUS_MAP),
  cases: [
    { vendorStatus: "valid", email: "jane.doe@brightloop.example", routes: validation("valid", 0.25), expected: "deliverable" },
    { vendorStatus: "invalid", email: "jane.doe@brightloop.example", routes: validation("invalid", 0.25), expected: "undeliverable" },
    { vendorStatus: "unknown", email: "jane.doe@brightloop.example", routes: validation("unknown", 0), expected: "unknown" },
  ],
  extraCases: [{ name: "a status LeadMagic does not document", email: "jane.doe@brightloop.example", routes: validation("catch_all", 0), expected: "unknown" }],
  failures: [
    { name: "HTTP 401", routes: [{ url: VALIDATION, respond: failure(401) }], code: "auth", retryable: false },
    { name: "HTTP 402", routes: [{ url: VALIDATION, respond: failure(402) }], code: "quota", retryable: false },
    { name: "HTTP 429", routes: [{ url: VALIDATION, respond: failure(429) }], code: "rate_limited", retryable: true },
    { name: "HTTP 503", routes: [{ url: VALIDATION, respond: failure(503) }], code: "unavailable", retryable: true },
  ],
});

describe("data-leadmagic manifest and costs", () => {
  it("declares the employment port and only its key", () => {
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.name).toBe(NAME);
    expect(parsed.ports).toEqual(["ContactFinder", "EmailVerifier", "EmploymentChecker"]);
    expect(parsed.requiredSecrets).toEqual(["LEADMAGIC_API_KEY"]);
    expect(parsed.costs.email_find?.credits).toBe(CREDITS.find);
    expect(parsed.costs.email_verify?.credits).toBe(CREDITS.verify);
    expect(parsed.costs.job_change?.credits).toBe(CREDITS.jobChange);
  });

  it("never reports risky: accept-all comes back unknown, and unknown is free", async () => {
    expect(Object.values(VENDOR_STATUS_MAP)).not.toContain("risky");
    const { sink } = adapter(validation("unknown", 0));
    const result = await sink.verify("jane.doe@brightloop.example");
    expect(result).toMatchObject({ status: "unknown", cost: { credits: 0, usd: 0 } });
    expect(result).not.toHaveProperty("acceptAll");
  });

  it("prices credits at the configured rate", async () => {
    const { sink } = adapter([{ url: FINDER, respond: json(found) }], { usdPerCredit: 0.01 });
    const result = await sink.findWorkEmail(args);
    expect(result.cost).toMatchObject({ provider: NAME, credits: 1, usd: 0.01 });
    const plain = adapter([{ url: FINDER, respond: json(found) }]);
    expect((await plain.sink.findWorkEmail(args)).cost?.usd).toBe(DEFAULT_USD_PER_CREDIT);
  });
});

const jobChange = (body: Record<string, unknown>) => [{ method: "POST", url: JOB_CHANGE, respond: json({ credits_consumed: 3, profile_url: PROFILE, ...body }) }];

describe("data-leadmagic employment checks", () => {
  it("maps every documented status to exactly one port status", async () => {
    expect(new Set(Object.values(JOB_STATUS_MAP))).toEqual(new Set(EMPLOYMENT_STATUSES));
    for (const [vendor, expected] of Object.entries(JOB_STATUS_MAP)) {
      const { sink } = adapter(jobChange({ status: vendor, job_change_detected: vendor === "JOB_CHANGE_DETECTED" }));
      expect((await sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).status, vendor).toBe(expected);
    }
    const { sink } = adapter(jobChange({ status: "SOMETHING_NEW" }));
    expect((await sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).status).toBe("unknown");
  });

  it("sends the profile and the expected company, and returns when the current role began", async () => {
    const { sink, calls } = adapter(jobChange({ status: "NO_CHANGE", current_position: { title: "VP Engineering", company: "Brightloop Labs", start_date: "2026-09-01", is_current_position: true } }));
    const result = await sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example", companyName: "Brightloop Labs" });
    expect(result).toMatchObject({ status: "current", roleStartedAt: "2026-09-01T00:00:00.000Z", title: "VP Engineering", cost: { provider: NAME, capability: "job_change", credits: 3 } });
    expect(Object.keys(result).sort()).toEqual(["cost", "roleStartedAt", "status", "title"]);
    expect(await (calls[0] as Request).json()).toEqual({ profile_url: PROFILE, company_domain: "brightloop.example", company_name: "Brightloop Labs" });
  });

  it("gives no start date for a move, and charges nothing for a profile it cannot find", async () => {
    const moved = adapter(jobChange({ status: "JOB_CHANGE_DETECTED", current_company: "Initech", current_position: { title: "CTO", start_date: "2026-10-01" } }));
    expect(await moved.sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).not.toHaveProperty("roleStartedAt");
    const missing = adapter(jobChange({ status: "PROFILE_NOT_FOUND", credits_consumed: 0 }));
    expect((await missing.sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).cost?.credits).toBe(0);
    const gone = adapter([{ url: JOB_CHANGE, respond: json({ success: false, errors: [{ status: 404, code: "profile_not_found" }] }, { status: 404 }) }]);
    expect(await gone.sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).toMatchObject({ status: "profile_not_found", cost: { credits: 0 } });
    const wrongPath = adapter([{ url: JOB_CHANGE, respond: json({ success: false, errors: [{ status: 404, code: "route_not_found" }] }, { status: 404 }) }]);
    await expect(wrongPath.sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails on errors other than a missing profile", async () => {
    const { sink } = adapter([{ url: JOB_CHANGE, respond: failure(402) }]);
    await expect(sink.checkEmployment({ profileUrl: PROFILE, companyDomain: "brightloop.example" })).rejects.toMatchObject({ code: "quota", retryable: false });
  });

  it("finds the current work address from the profile alone, with the employer's domain", async () => {
    const { sink, calls } = adapter([{ url: FINDER, respond: json({ ...found, email: "jane@initech.example", domain: "initech.example", company_name: "Initech" }) }]);
    const result = await sink.findCurrentWorkEmail({ profileUrl: PROFILE, firstName: "Jane", lastName: "Doe" });
    expect(result).toMatchObject({ email: "jane@initech.example", domain: "initech.example", companyName: "Initech", cost: { credits: 1 } });
    expect(await (calls[0] as Request).json()).toEqual({ profile_url: PROFILE, first_name: "Jane", last_name: "Doe" });
  });

  it("takes the domain from the address when the response has none, and finds nothing free", async () => {
    const { sink } = adapter([{ url: FINDER, times: 1, respond: json({ email: "jane@initech.example", status: "valid", credits_consumed: 1 }) }, { url: FINDER, respond: json(notFound) }]);
    expect(await sink.findCurrentWorkEmail({ profileUrl: PROFILE })).toMatchObject({ email: "jane@initech.example", domain: "initech.example" });
    const none = await sink.findCurrentWorkEmail({ profileUrl: PROFILE });
    expect(none).toMatchObject({ email: null, cost: { credits: 0 } });
    expect(Object.keys(none).sort()).toEqual(["cost", "email"]);
  });
});
