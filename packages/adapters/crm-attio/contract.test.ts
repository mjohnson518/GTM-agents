// GTM-agents: contract tests for the Attio adapter. Every response is recorded and synthetic: the
// companies, people, addresses and record ids are invented, on *.example domains.
import { describe, expect, it } from "vitest";
import { manifestSchema } from "@gtm-agents/core/ports";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { NAME, RETRY_MAX_MS, createAdapter, retryAfterMs } from "./index.ts";

const secrets = { ATTIO_API_KEY: "test-attio-key" };
const COMPANIES = "https://api.attio.com/v2/objects/companies/records?matching_attribute=domains";
const PEOPLE = "https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses";
const NOTES = "https://api.attio.com/v2/notes";
const NOW = new Date("2026-11-16T12:00:00.000Z");

const record = (id: string) => ({ data: { id: { workspace_id: "ws-example", object_id: "obj-example", record_id: id }, values: {} } });

function adapter(routes: RecordedRoute[]) {
  const recorded = recordedFetch(routes);
  return { sink: createAdapter(testContext({ secrets, fetch: recorded.fetch, now: NOW })), calls: recorded.calls };
}

const contact = {
  id: "c_1",
  email: "jane.doe@brightloop.example",
  firstName: "Jane",
  lastName: "Doe",
  title: "Staff Engineer",
  accountKey: "brightloop.example",
  accountExternalId: "rec-company-1",
  warmth: "contacted",
  attributes: {},
};

describe("crm-attio manifest", () => {
  it("validates, claims CrmSink, and needs only its key", () => {
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.name).toBe(NAME);
    expect(parsed.ports).toEqual(["CrmSink"]);
    expect(parsed.requiredSecrets).toEqual(["ATTIO_API_KEY"]);
    expect(parsed.flags).toContain("crm:mirror_enabled");
    expect(Object.keys(parsed.tools)).toHaveLength(0);
  });
});

describe("crm-attio requests", () => {
  it("upserts a company on its domain and returns the record id", async () => {
    const { sink, calls } = adapter([{ method: "PUT", url: COMPANIES, respond: json(record("rec-company-1")) }]);
    const out = await sink.upsertAccount({ key: "brightloop.example", name: "Brightloop Labs", domain: "brightloop.example", attributes: {} });
    expect(out).toEqual({ externalId: "rec-company-1" });
    const req = calls[0] as Request;
    expect(req.headers.get("authorization")).toBe("Bearer test-attio-key");
    expect(new URL(req.url).searchParams.has("api_key")).toBe(false);
    expect(await req.json()).toEqual({ data: { values: { domains: [{ domain: "brightloop.example" }], name: "Brightloop Labs" } } });
  });

  it("upserts a person on the address, with name, title and the company by record id", async () => {
    const { sink, calls } = adapter([{ method: "PUT", url: PEOPLE, respond: json(record("rec-person-1")) }]);
    expect(await sink.upsertContact(contact)).toEqual({ externalId: "rec-person-1" });
    expect(await (calls[0] as Request).json()).toEqual({
      data: {
        values: {
          email_addresses: [{ email_address: "jane.doe@brightloop.example" }],
          name: [{ first_name: "Jane", last_name: "Doe", full_name: "Jane Doe" }],
          job_title: "Staff Engineer",
          company: [{ target_object: "companies", target_record_id: "rec-company-1" }],
        },
      },
    });
  });

  it("leaves out fields core does not hold, and never sends warmth or attributes", async () => {
    const { sink, calls } = adapter([{ method: "PUT", url: PEOPLE, respond: json(record("rec-person-2")) }]);
    await sink.upsertContact({ id: "c_2", email: "sam@initech.example", warmth: "cold", attributes: { secret: "x" } });
    expect(await (calls[0] as Request).json()).toEqual({ data: { values: { email_addresses: [{ email_address: "sam@initech.example" }] } } });
  });

  it("refuses a contact without an address before any request", async () => {
    const { sink, calls } = adapter([]);
    await expect(sink.upsertContact({ id: "c_3", warmth: "cold", attributes: {} })).rejects.toMatchObject({ code: "invalid", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("writes an activity as a dated plain-text note on the person", async () => {
    const { sink, calls } = adapter([{ method: "POST", url: NOTES, respond: json({ data: { id: { note_id: "note-1" } } }) }]);
    await sink.logActivity({ contactId: "rec-person-1", type: "email_sent", at: "2026-11-10T15:00:00.000Z", summary: "Cold email sent: Flaky tests at Brightloop" });
    expect(await (calls[0] as Request).json()).toEqual({
      data: {
        parent_object: "people",
        parent_record_id: "rec-person-1",
        title: "Email sent",
        format: "plaintext",
        content: "Cold email sent: Flaky tests at Brightloop",
        created_at: "2026-11-10T15:00:00.000Z",
      },
    });
  });
});

describe("crm-attio failures", () => {
  it("retries a 429 once after Retry-After, then succeeds", async () => {
    const { sink, calls } = adapter([
      { method: "PUT", url: PEOPLE, times: 1, respond: json({ status_code: 429 }, { status: 429, headers: { "retry-after": "0" } }) },
      { method: "PUT", url: PEOPLE, respond: json(record("rec-person-1")) },
    ]);
    expect(await sink.upsertContact(contact)).toEqual({ externalId: "rec-person-1" });
    expect(calls).toHaveLength(2);
  });

  it("gives up on a second 429 as rate_limited and retryable", async () => {
    const { sink, calls } = adapter([{ method: "POST", url: NOTES, respond: json({}, { status: 429, headers: { "retry-after": new Date(NOW.getTime() - 1000).toUTCString() } }) }]);
    await expect(sink.logActivity({ contactId: "rec-person-1", type: "note", at: NOW.toISOString(), summary: "Deal moved to proposal" })).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [400, "invalid", false],
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [422, "invalid", false],
    [502, "unavailable", true],
  ] as const)("HTTP %i is %s", async (status, code, retryable) => {
    const { sink } = adapter([{ url: COMPANIES, respond: json({}, { status }) }]);
    await expect(sink.upsertAccount({ key: "initech.example", name: "Initech", domain: "initech.example", attributes: {} })).rejects.toMatchObject({ code, retryable });
  });

  it("a response without a record id is an error, not a guess", async () => {
    const { sink } = adapter([{ url: PEOPLE, respond: json({ data: {} }) }]);
    await expect(sink.upsertContact(contact)).rejects.toMatchObject({ name: "AdapterError", code: "unknown" });
  });

  it("an unreachable API is unavailable and retryable", async () => {
    const sink = createAdapter(testContext({ secrets, fetch: () => Promise.reject(new TypeError("network down")), now: NOW }));
    await expect(sink.upsertContact(contact)).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("a missing key throws before any request", async () => {
    const recorded = recordedFetch([]);
    const sink = createAdapter(testContext({ fetch: recorded.fetch, now: NOW }));
    await expect(sink.upsertContact(contact)).rejects.toThrow(/ATTIO_API_KEY/);
    expect(recorded.calls).toHaveLength(0);
  });

  it("reads Retry-After in seconds or as a date, capped", () => {
    expect(retryAfterMs("2", NOW)).toBe(2000);
    expect(retryAfterMs(new Date(NOW.getTime() + 3000).toUTCString(), NOW)).toBe(3000);
    expect(retryAfterMs("600", NOW)).toBe(RETRY_MAX_MS);
    expect(retryAfterMs(null, NOW)).toBe(1000);
    expect(retryAfterMs("soon", NOW)).toBe(1000);
  });
});
