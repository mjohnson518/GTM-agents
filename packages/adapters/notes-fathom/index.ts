// GTM-agents: the Fathom adapter: a MeetingNotesProvider backed by Fathom's API (v1).
// See docs/MEETING-NOTES.md.
//
//   listRecordings  GET /meetings?created_after=...&cursor=...     (no transcript, a light request)
//   getTranscript   GET /recordings/{recording_id}/transcript      (a heavy request)
//
// A key sees the recordings of the user who made it and the meetings shared with them or their
// team. Each recording's calendar invitees come with Fathom's own is_external flag, and a transcript
// speaker is matched to an invitee's address: a speaker matched to an internal invitee is "us", to
// an external one "them", and anyone unmatched "unknown". The invitees are remembered from the
// listing for the transcript that follows in the same run; without them every speaker is unknown.
// The adapter translates and decides nothing: which recordings are read, and what is kept, is core's.
// Everything it returns is untrusted third-party text.
//
// Options (gtm.config.ts, adapters["notes-fathom"].options), all optional:
//   baseUrl   default https://api.fathom.ai/external/v1
// Secret: FATHOM_API_KEY (wrangler secret put FATHOM_API_KEY), sent in the X-Api-Key header.
import { AdapterError, type AdapterContext, type AdapterErrorCode, type MeetingNotesProvider, type MeetingRecording, type TranscriptSegment } from "@gtm-agents/core/ports";

export const NAME = "notes-fathom";
export const SECRET_NAME = "FATHOM_API_KEY";
export const DEFAULT_BASE_URL = "https://api.fathom.ai/external/v1";

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

/** The AdapterError for a failed HTTP response. */
export function errorForStatus(status: number, endpoint: string, retryAfter: string | null = null): AdapterError {
  const table: Record<number, [AdapterErrorCode, boolean]> = {
    400: ["invalid", false],
    401: ["auth", false],
    403: ["auth", false],
    404: ["not_found", false],
    422: ["invalid", false],
    429: ["rate_limited", true],
  };
  const [code, retryable] = table[status] ?? (status >= 500 ? ["unavailable", true] : ["unknown", false]);
  const wait = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : 60_000;
  return new AdapterError(`Fathom ${endpoint} returned HTTP ${status}`, code, retryable, code === "rate_limited" ? { retryAfterMs: wait } : {});
}

/** "00:05:32" as milliseconds, or undefined. */
export function timestampMs(value: unknown): number | undefined {
  const m = typeof value === "string" ? /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim()) : null;
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : undefined;
}

interface FathomInvitee {
  name?: unknown;
  email?: unknown;
  is_external?: unknown;
}

interface FathomMeeting {
  recording_id?: unknown;
  title?: unknown;
  meeting_title?: unknown;
  scheduled_start_time?: unknown;
  scheduled_end_time?: unknown;
  recording_start_time?: unknown;
  recording_end_time?: unknown;
  calendar_invitees?: unknown;
}

/** One listed meeting as a recording, or null when it has no id or start. */
export function mapMeeting(m: FathomMeeting): MeetingRecording | null {
  const id = typeof m.recording_id === "number" || typeof m.recording_id === "string" ? String(m.recording_id) : undefined;
  const startedAt = text(m.recording_start_time) ?? text(m.scheduled_start_time);
  if (!id || !startedAt) return null;
  const endedAt = text(m.recording_end_time) ?? text(m.scheduled_end_time);
  const title = text(m.meeting_title) ?? text(m.title);
  const invitees = (Array.isArray(m.calendar_invitees) ? (m.calendar_invitees as FathomInvitee[]) : []).flatMap((i) => {
    const email = text(i?.email);
    if (!email) return [];
    const name = text(i.name);
    return [{ email, ...(name ? { name } : {}), ...(typeof i.is_external === "boolean" ? { external: i.is_external } : {}) }];
  });
  return { externalId: id, startedAt, ...(endedAt ? { endedAt } : {}), ...(title ? { title } : {}), invitees, transcriptAvailable: true };
}

/** One transcript item as a segment, its side from the invitee the speaker was matched to. */
export function mapTranscriptItem(item: { speaker?: { display_name?: unknown; matched_calendar_invitee_email?: unknown } | null; text?: unknown; timestamp?: unknown }, sides: ReadonlyMap<string, boolean>): TranscriptSegment | null {
  const body = text(item.text);
  if (!body) return null;
  const email = text(item.speaker?.matched_calendar_invitee_email)?.toLowerCase();
  const external = email ? sides.get(email) : undefined;
  const speaker = text(item.speaker?.display_name);
  const startMs = timestampMs(item.timestamp);
  return { side: external === true ? "them" : external === false ? "us" : "unknown", text: body, ...(speaker ? { speaker } : {}), ...(startMs !== undefined ? { startMs } : {}) };
}

export function createAdapter(ctx: AdapterContext): MeetingNotesProvider {
  const baseUrl = typeof ctx.options.baseUrl === "string" && ctx.options.baseUrl.length > 0 ? ctx.options.baseUrl.replace(/\/+$/, "") : DEFAULT_BASE_URL;
  /** Invitee address to is_external, per recording, from this run's listing. */
  const invitees = new Map<string, Map<string, boolean>>();

  async function get<T>(path: string, params: Record<string, string>, endpoint: string): Promise<T> {
    const key = ctx.secret(SECRET_NAME);
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await ctx.fetch(url.toString(), { method: "GET", headers: { "x-api-key": key, accept: "application/json" } });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AdapterError(timeout ? `Fathom ${endpoint} timed out` : `Fathom ${endpoint} could not be reached`, timeout ? "timeout" : "unavailable", true, { cause: error });
    }
    if (!response.ok) {
      discard(response);
      throw errorForStatus(response.status, endpoint, response.headers.get("retry-after"));
    }
    try {
      return await response.json<T>();
    } catch (error) {
      throw new AdapterError(`Fathom ${endpoint} returned a body that is not JSON`, "unknown", true, { cause: error });
    }
  }

  return {
    name: NAME,

    async listRecordings(args) {
      const body = await get<{ items?: unknown; next_cursor?: unknown }>("/meetings", { created_after: args.since, ...(args.cursor ? { cursor: args.cursor } : {}) }, "/meetings");
      const raw = Array.isArray(body.items) ? (body.items as FathomMeeting[]) : [];
      const items: MeetingRecording[] = [];
      // Fathom sets its own page size: every item is returned, so none is skipped as the cursor moves on.
      for (const m of raw) {
        const recording = mapMeeting(m);
        if (!recording) continue;
        invitees.set(recording.externalId, new Map(recording.invitees.flatMap((i) => (i.external === undefined ? [] : [[i.email.toLowerCase(), i.external] as const]))));
        items.push(recording);
      }
      const cursor = text(body.next_cursor);
      return { items, ...(cursor ? { cursor } : {}) };
    },

    async getTranscript(externalId) {
      if (!/^\d+$/.test(externalId)) throw new AdapterError("a Fathom recording id is a number", "invalid", false);
      const body = await get<{ transcript?: unknown }>(`/recordings/${externalId}/transcript`, {}, "/recordings/{id}/transcript");
      const sides = invitees.get(externalId) ?? new Map<string, boolean>();
      const segments = (Array.isArray(body.transcript) ? body.transcript : []).flatMap((item) => {
        const segment = mapTranscriptItem(item as Parameters<typeof mapTranscriptItem>[0], sides);
        return segment ? [segment] : [];
      });
      return { segments };
    },
  };
}
