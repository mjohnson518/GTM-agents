// GTM-agents: contract tests for the Granola adapter. Every response is recorded and synthetic: the
// notes, people, addresses and transcripts are invented, on *.example domains.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manifestSchema } from "@gtm-agents/core/ports";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { NAME, createAdapter, mapTranscript } from "./index.ts";

const secrets = { GRANOLA_API_KEY: "test-granola-key" };
const NOTE_ID = "not_1d3tmYTlCICgjy";
const LIST = /^https:\/\/public-api\.granola\.ai\/v1\/notes\?/;
const NOTE = `https://public-api.granola.ai/v1/notes/${NOTE_ID}`;
const TRANSCRIPT = /^https:\/\/public-api\.granola\.ai\/v1\/notes\/not_1d3tmYTlCICgjy\/transcript\?/;

const summary = { id: NOTE_ID, object: "note", title: "Acme and Brightloop", owner: { name: "Avery", email: "avery@acme.example" }, created_at: "2026-11-09T15:40:00Z", updated_at: "2026-11-09T15:41:00Z", deleted_at: null };
const note = {
  ...summary,
  web_url: "https://granola.example/n/1",
  calendar_event: {
    event_title: "Acme and Brightloop",
    invitees: [{ email: "avery@acme.example" }, { email: "jane.doe@brightloop.example" }],
    organiser: "avery@acme.example",
    calendar_event_id: "cal-1",
    scheduled_start_time: "2026-11-09T15:00:00Z",
    scheduled_end_time: "2026-11-09T15:30:00Z",
  },
  attendees: [{ name: "Jane Doe", email: "jane.doe@brightloop.example" }, { name: "Sam Lee", email: "sam.lee@brightloop.example" }],
  summary_text: "A summary.",
  transcript: null,
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

describe("notes-granola", () => {
  it("ships a valid manifest for the port, needing only its key", () => {
    expect(manifestSchema.parse(manifest)).toMatchObject({ name: NAME, ports: ["MeetingNotesProvider"], requiredSecrets: ["GRANOLA_API_KEY"] });
  });

  it("lists notes, reads each for its invitees and time, and marks the owner internal", async () => {
    const { notes, calls } = adapter([
      { method: "GET", url: LIST, respond: json({ notes: [summary, { id: "bad id" }], hasMore: true, cursor: "c2" }) },
      { method: "GET", url: NOTE, respond: json(note) },
    ]);
    const page = await notes.listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 25 });
    expect(page).toEqual({
      items: [
        {
          externalId: NOTE_ID,
          startedAt: "2026-11-09T15:00:00Z",
          endedAt: "2026-11-09T15:30:00Z",
          title: "Acme and Brightloop",
          invitees: [
            { email: "avery@acme.example", external: false },
            { email: "jane.doe@brightloop.example" },
            { email: "sam.lee@brightloop.example", name: "Sam Lee" },
          ],
          transcriptAvailable: true,
        },
      ],
      cursor: "c2",
    });
    const url = new URL((calls[0] as Request).url);
    expect(url.searchParams.get("created_after")).toBe("2026-11-03T12:00:00.000Z");
    expect(url.searchParams.get("page_size")).toBe("25");
    expect((calls[0] as Request).headers.get("authorization")).toBe("Bearer test-granola-key");
    expect(calls).toHaveLength(2);
  });

  it("reads every transcript page and maps who spoke", async () => {
    const page = (items: unknown[], cursor: string | null) => json({ transcript: items, hasMore: cursor !== null, cursor });
    const { notes, calls } = adapter([
      { method: "GET", url: TRANSCRIPT, times: 1, respond: page([{ speaker: { source: "microphone", attribution: "me" }, text: "Thanks for joining.", start_time: "2026-11-09T15:00:05Z", end_time: "2026-11-09T15:00:07Z" }], "p2") },
      {
        method: "GET",
        url: TRANSCRIPT,
        respond: page(
          [
            { speaker: { source: "speaker", attribution: "them", name: "Jane Doe" }, text: "Flaky tests block every release.", start_time: "2026-11-09T15:01:05Z", end_time: "2026-11-09T15:01:09Z" },
            { speaker: { source: "microphone", diarization_label: "Speaker B" }, text: "From a phone.", start_time: "2026-11-09T15:02:05Z", end_time: "2026-11-09T15:02:07Z" },
          ],
          null,
        ),
      },
    ]);
    const { segments } = await notes.getTranscript(NOTE_ID);
    expect(segments).toEqual([
      { side: "us", text: "Thanks for joining.", startMs: 0 },
      { side: "them", speaker: "Jane Doe", text: "Flaky tests block every release.", startMs: 60000 },
      { side: "unknown", speaker: "Speaker B", text: "From a phone.", startMs: 120000 },
    ]);
    expect(new URL((calls[1] as Request).url).searchParams.get("cursor")).toBe("p2");
  });

  it("refuses an id that is not a note id, before any request", async () => {
    const { notes, calls } = adapter([]);
    await expect(notes.getTranscript("../notes")).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "auth", false],
    [404, "not_found", false],
    [429, "rate_limited", true],
    [500, "unavailable", true],
  ] as const)("HTTP %i is %s", async (status, code, retryable) => {
    const { notes } = adapter([{ url: LIST, respond: json({ code: "ERR", message: "x", requestId: "r" }, { status }) }]);
    await expect(notes.listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 5 })).rejects.toMatchObject({ name: "AdapterError", code, retryable });
  });

  it("fails without its key before any request", async () => {
    const recorded = recordedFetch([]);
    await expect(createAdapter(testContext({ fetch: recorded.fetch })).listRecordings({ since: "2026-11-03T12:00:00.000Z", limit: 5 })).rejects.toThrow(/GRANOLA_API_KEY/);
    expect(recorded.calls).toHaveLength(0);
  });

  it("drops empty speech", () => {
    expect(mapTranscript([{ speaker: { source: "speaker" }, text: "  ", start_time: "2026-11-09T15:00:00Z" }])).toEqual([]);
  });
});
