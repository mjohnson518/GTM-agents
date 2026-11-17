// GTM-agents: the Granola adapter: a MeetingNotesProvider backed by Granola's public API (v1).
// See docs/MEETING-NOTES.md.
//
//   listRecordings  GET /v1/notes?created_after=...&cursor=...&page_size=...
//                   then GET /v1/notes/{id} per note, for its calendar event and attendees
//   getTranscript   GET /v1/notes/{id}/transcript?page_size=100&cursor=...  (every page)
//
// Granola's API needs a Business or Enterprise plan, and returns only notes that have an AI
// summary. A personal key sees the notes its owner owns or that are shared with them. A note's
// invitees are its calendar event's invitees and its attendees; the note's owner is marked internal.
// A transcript speaker is "us" when Granola attributes the speech to the owner ("me"), "them" when
// to the others, and otherwise "unknown" (recordings from a phone mark every speaker the same way).
// Start times are made relative to the first segment. The adapter translates and decides nothing.
// Everything it returns is untrusted third-party text.
//
// Options (gtm.config.ts, adapters["notes-granola"].options), all optional:
//   baseUrl   default https://public-api.granola.ai/v1
// Secret: GRANOLA_API_KEY (wrangler secret put GRANOLA_API_KEY), sent as a Bearer token.
import { AdapterError, type AdapterContext, type AdapterErrorCode, type MeetingNotesProvider, type MeetingRecording, type TranscriptSegment } from "@gtm-agents/core/ports";

export const NAME = "notes-granola";
export const SECRET_NAME = "GRANOLA_API_KEY";
export const DEFAULT_BASE_URL = "https://public-api.granola.ai/v1";
/** Transcript pages read at most, 100 items each. */
export const MAX_TRANSCRIPT_PAGES = 30;

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

export function errorForStatus(status: number, endpoint: string, retryAfter: string | null = null): AdapterError {
  const table: Record<number, [AdapterErrorCode, boolean]> = {
    400: ["invalid", false],
    401: ["auth", false],
    403: ["auth", false],
    404: ["not_found", false],
    429: ["rate_limited", true],
  };
  const [code, retryable] = table[status] ?? (status >= 500 ? ["unavailable", true] : ["unknown", false]);
  const wait = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : 5000;
  return new AdapterError(`Granola ${endpoint} returned HTTP ${status}`, code, retryable, code === "rate_limited" ? { retryAfterMs: wait } : {});
}

interface GranolaNote {
  id?: unknown;
  title?: unknown;
  created_at?: unknown;
  owner?: { email?: unknown } | null;
  calendar_event?: { invitees?: unknown; scheduled_start_time?: unknown; scheduled_end_time?: unknown } | null;
  attendees?: unknown;
}

/** One note as a recording, or null when it has no id or time. */
export function mapNote(note: GranolaNote): MeetingRecording | null {
  const id = text(note.id);
  const startedAt = text(note.calendar_event?.scheduled_start_time) ?? text(note.created_at);
  if (!id || !startedAt) return null;
  const endedAt = text(note.calendar_event?.scheduled_end_time);
  const title = text(note.title);
  const owner = text(note.owner?.email)?.toLowerCase();
  const byEmail = new Map<string, { email: string; name?: string; external?: boolean }>();
  const add = (raw: { email?: unknown; name?: unknown } | null | undefined) => {
    const email = text(raw?.email);
    if (!email || byEmail.has(email.toLowerCase())) return;
    const name = text(raw?.name);
    byEmail.set(email.toLowerCase(), { email, ...(name ? { name } : {}), ...(email.toLowerCase() === owner ? { external: false } : {}) });
  };
  for (const i of Array.isArray(note.calendar_event?.invitees) ? (note.calendar_event.invitees as Array<{ email?: unknown }>) : []) add(i);
  for (const a of Array.isArray(note.attendees) ? (note.attendees as Array<{ email?: unknown; name?: unknown }>) : []) add(a);
  return { externalId: id, startedAt, ...(endedAt ? { endedAt } : {}), ...(title ? { title } : {}), invitees: [...byEmail.values()], transcriptAvailable: true };
}

type GranolaItem = { speaker?: { source?: unknown; attribution?: unknown; name?: unknown; diarization_label?: unknown } | null; text?: unknown; start_time?: unknown };

/** Transcript items as segments, start times relative to the first. Pure. */
export function mapTranscript(items: readonly GranolaItem[]): TranscriptSegment[] {
  const times = items.map((i) => Date.parse(text(i.start_time) ?? "")).filter(Number.isFinite);
  const first = times.length > 0 ? Math.min(...times) : NaN;
  return items.flatMap((item) => {
    const body = text(item.text);
    if (!body) return [];
    const attribution = item.speaker?.attribution;
    const side: TranscriptSegment["side"] = attribution === "me" ? "us" : attribution === "them" ? "them" : item.speaker?.source === "speaker" ? "them" : "unknown";
    const speaker = text(item.speaker?.name) ?? text(item.speaker?.diarization_label);
    const at = Date.parse(text(item.start_time) ?? "");
    return [{ side, text: body, ...(speaker ? { speaker } : {}), ...(Number.isFinite(at) && Number.isFinite(first) ? { startMs: at - first } : {}) }];
  });
}

export function createAdapter(ctx: AdapterContext): MeetingNotesProvider {
  const baseUrl = typeof ctx.options.baseUrl === "string" && ctx.options.baseUrl.length > 0 ? ctx.options.baseUrl.replace(/\/+$/, "") : DEFAULT_BASE_URL;

  async function get<T>(path: string, params: Record<string, string>, endpoint: string): Promise<T> {
    const key = ctx.secret(SECRET_NAME);
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await ctx.fetch(url.toString(), { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AdapterError(timeout ? `Granola ${endpoint} timed out` : `Granola ${endpoint} could not be reached`, timeout ? "timeout" : "unavailable", true, { cause: error });
    }
    if (!response.ok) {
      discard(response);
      throw errorForStatus(response.status, endpoint, response.headers.get("retry-after"));
    }
    try {
      return await response.json<T>();
    } catch (error) {
      throw new AdapterError(`Granola ${endpoint} returned a body that is not JSON`, "unknown", true, { cause: error });
    }
  }

  const noteId = (id: string) => {
    if (!/^not_[A-Za-z0-9]{14}$/.test(id)) throw new AdapterError("a Granola note id is not_ and 14 letters or digits", "invalid", false);
    return id;
  };

  return {
    name: NAME,

    async listRecordings(args) {
      const page = await get<{ notes?: unknown; hasMore?: unknown; cursor?: unknown }>(
        "/notes",
        { created_after: args.since, page_size: String(Math.max(1, Math.min(30, args.limit))), ...(args.cursor ? { cursor: args.cursor } : {}) },
        "/notes",
      );
      const items: MeetingRecording[] = [];
      for (const summary of Array.isArray(page.notes) ? (page.notes as Array<{ id?: unknown }>) : []) {
        const id = text(summary?.id);
        if (!id || !/^not_[A-Za-z0-9]{14}$/.test(id)) continue;
        const note = await get<GranolaNote>(`/notes/${id}`, {}, "/notes/{id}");
        const recording = mapNote(note);
        if (recording) items.push(recording);
      }
      const cursor = page.hasMore === true ? text(page.cursor) : undefined;
      return { items, ...(cursor ? { cursor } : {}) };
    },

    async getTranscript(externalId) {
      const id = noteId(externalId);
      const items: GranolaItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page++) {
        const body = await get<{ transcript?: unknown; hasMore?: unknown; cursor?: unknown }>(`/notes/${id}/transcript`, { page_size: "100", ...(cursor ? { cursor } : {}) }, "/notes/{id}/transcript");
        if (Array.isArray(body.transcript)) items.push(...(body.transcript as GranolaItem[]));
        cursor = body.hasMore === true ? text(body.cursor) : undefined;
        if (!cursor) break;
      }
      return { segments: mapTranscript(items) };
    },
  };
}
