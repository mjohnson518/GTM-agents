// GTM-agents: contract tests for the Fathom adapter. Every response is recorded and synthetic: the
// meetings, people, addresses and transcripts are invented, on *.example domains.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manifestSchema } from "@gtm-agents/core/ports";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { NAME, createAdapter, timestampMs } from "./index.ts";

const secrets = { FATHOM_API_KEY: "test-fathom-key" };
const LIST = /^https:\/\/api\.fathom\.ai\/external\/v1\/meetings\?/;
const TRANSCRIPT = "https://api.fathom.ai/external/v1/recordings/123456/transcript";

const meeting = {
  title: "Acme intro",
  meeting_title: "Acme and Brightloop",
  recording_id: 123456,
  url: "https://fathom.example/calls/123456",
  share_url: "https://fathom.example/share/abc",
  created_at: "2026-11-09T16:00:00Z",
  scheduled_start_time: "2026-11-09T15:00:00Z",
  scheduled_end_time: "2026-11-09T15:30:00Z",
  recording_start_time: "2026-11-09T15:01:00Z",
  recording_end_time: "2026-11-09T15:29:00Z",
  calendar_invitees_domains_type: "one_or_more_external",
  transcript: null,
  default_summary: null,
  calendar_invitees: [
    { name: "Avery", email: "avery@acme.example", email_domain: "acme.example", is_external: false },
    { name: "Jane Doe", email: "Jane.Doe@brightloop.example", email_domain: "brightloop.example", is_external: true },
  ],
  recorded_by: { name: "Avery", email: "avery@acme.example", email_domain: "acme.example", team: "Sales" },
};

const transcript = {
  transcript: [
    { speaker: { display_name: "Avery", matched_calendar_invitee_email: "avery@acme.example" }, text: "Thanks for the time.", timestamp: "00:00:05" },
    { speaker: { display_name: "Jane Doe", matched_calendar_invitee_email: "jane.doe@brightloop.example" }, text: "Flaky tests block every release.", timestamp: "00:01:10" },
    { speaker: { display_name: "Guest", matched_calendar_invitee_email: null }, text: "Can I join late?", timestamp: "01:02:03" },
    { speaker: { display_name: "Avery" }, text: "   ", timestamp: "00:03:00" },
  ],
};

function adapter(routes: RecordedRoute[]) {
  const recorded = recordedFetch(routes);
  return { notes: createAdapter(testContext({ secrets, fetch: recorded.fetch })), calls: recorded.calls };
}

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

describe("notes-fathom", () => {
  it("ships a valid manifest for the port, needing only its key", () => {
    const parsed = manifestSchema.parse(manifest);
    expect(parsed).toMatchObject({ name: NAME, ports: ["MeetingNotesProvider"], requiredSecrets: ["FATHOM_API_KEY"] });
    expect(Object.keys(parsed.tools)).toHaveLength(0);
  });

  it("lists recordings created since a time, a light request with the key in a header", async () => {
    const { notes, calls } = adapter([{ method: "GET", url: LIST, respond: json({ limit: 10, next_cursor: "cur-2", items: [meeting, { title: "no id" }] }) }]);
    const page = await notes.listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 25 });
    expect(page.cursor).toBe("cur-2");
    expect(page.items).toEqual([
      {
        externalId: "123456",
        startedAt: "2026-11-09T15:01:00Z",
        endedAt: "2026-11-09T15:29:00Z",
        title: "Acme and Brightloop",
        invitees: [
          { email: "avery@acme.example", name: "Avery", external: false },
          { email: "Jane.Doe@brightloop.example", name: "Jane Doe", external: true },
        ],
        transcriptAvailable: true,
      },
    ]);
    const url = new URL((calls[0] as Request).url);
    expect(url.searchParams.get("created_after")).toBe("2026-11-03T12:00:00.000Z");
    expect(url.searchParams.has("include_transcript")).toBe(false);
    expect((calls[0] as Request).headers.get("x-api-key")).toBe("test-fathom-key");
  });

  it("passes the cursor on, and maps transcript speakers to sides from the listing", async () => {
    const { notes, calls } = adapter([
      { method: "GET", url: LIST, respond: json({ next_cursor: null, items: [meeting] }) },
      { method: "GET", url: TRANSCRIPT, respond: json(transcript) },
    ]);
    const page = await notes.listRecordings({ since: "2026-11-03T12:00:00.000Z", cursor: "cur-2", limit: 25 });
    expect(page).not.toHaveProperty("cursor");
    expect(new URL((calls[0] as Request).url).searchParams.get("cursor")).toBe("cur-2");
    const { segments } = await notes.getTranscript("123456");
    expect(segments).toEqual([
      { side: "us", speaker: "Avery", text: "Thanks for the time.", startMs: 5000 },
      { side: "them", speaker: "Jane Doe", text: "Flaky tests block every release.", startMs: 70000 },
      { side: "unknown", speaker: "Guest", text: "Can I join late?", startMs: 3723000 },
    ]);
  });

  it("without the listing, every speaker is unknown", async () => {
    const { notes } = adapter([{ method: "GET", url: TRANSCRIPT, respond: json(transcript) }]);
    const { segments } = await notes.getTranscript("123456");
    expect(new Set(segments.map((s) => s.side))).toEqual(new Set(["unknown"]));
  });

  it("refuses an id that is not a recording id, before any request", async () => {
    const { notes, calls } = adapter([]);
    await expect(notes.getTranscript("../users")).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [429, "rate_limited", true],
    [503, "unavailable", true],
  ] as const)("HTTP %i is %s", async (status, code, retryable) => {
    const { notes } = adapter([{ url: LIST, respond: json({}, { status, headers: status === 429 ? { "retry-after": "12" } : {} }) }]);
    const error = await notes.listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 5 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AdapterError", code, retryable });
    if (status === 429) expect(error).toMatchObject({ retryAfterMs: 12_000 });
  });

  it("fails without its key before any request, and on an unreachable API", async () => {
    const recorded = recordedFetch([]);
    await expect(createAdapter(testContext({ fetch: recorded.fetch })).listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 5 })).rejects.toThrow(/FATHOM_API_KEY/);
    expect(recorded.calls).toHaveLength(0);
    const down = createAdapter(testContext({ secrets, fetch: () => Promise.reject(new TypeError("network down")) }));
    await expect(down.listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 5 })).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("reads HH:MM:SS timestamps", () => {
    expect(timestampMs("00:05:32")).toBe(332_000);
    expect(timestampMs("5:32")).toBeUndefined();
  });
});
