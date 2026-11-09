// GTM-agents: the calendar-google adapter: the CalendarProvider port over the Google Calendar API,
// read-only, with no SDK.
//
// It translates and decides nothing; core detects and attributes bookings. Specifically:
//   - listEvents reads events.list on the primary calendar for the window, with singleEvents=true
//     (recurring events expanded into instances) and showDeleted=true (a cancelled event comes back
//     with status "cancelled", so core can tell a cancellation from silence). Pages of 250, at most
//     maxPages pages;
//   - privacy: every request carries a field mask asking for exactly the event id, status, start and
//     end (date or time), attendees (email, self, response status) and organizer (email, self).
//     Never the title, description, location, conferencing, attachments or attendee names. If the
//     API answers with more than it was asked for, the extra fields are dropped here and never
//     reach core;
//   - times come back as ISO 8601 UTC; an event with dates but no times is allDay with null times;
//     addresses are lowercased, and an attendee without a usable address is left out;
//   - the adapter is read-only: freeBusy, createEvent, updateEvent and cancelEvent refuse with a
//     non-retryable "invalid" AdapterError without a request, and capabilities says so;
//   - every call goes through ctx.fetch with a Google access token (_google-auth); a 401 refreshes
//     the token once. An instance of a recurring event carries its series id (recurringEventId), so
//     core can count a series as one booking.
//   Errors are typed AdapterErrors carrying Google's short reason only: 400
//     invalid, 401 and 403 auth (403 rate limits are rate_limited, quota errors quota), 404
//     not_found, 429 rate_limited, 5xx unavailable, and a dropped connection timeout.
//
// Scope: https://www.googleapis.com/auth/calendar.events.owned.readonly (read events on calendars
// the account owns, which includes the primary calendar); calendar.events.readonly also works.
// docs/CONVERT.md explains how to grant it, and how one refresh token can carry both this scope and
// the mailbox's.
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN.
// Options (adapters.calendar-google.options):
//   maxPages     pages of 250 events one listEvents call reads, 1 to 20 (default 10)
//   apiBaseUrl   defaults to https://www.googleapis.com/calendar/v3
import { AdapterError, type AdapterContext, type CalendarAttendee, type CalendarEventSummary, type CalendarProvider } from "@gtm-agents/core/ports";
import { createGoogleAuth } from "../_google-auth/index.ts";

export const NAME = "calendar-google";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const REFRESH_TOKEN_NAME = "GOOGLE_CALENDAR_REFRESH_TOKEN";
/** The narrowest scope events.list accepts for the primary calendar. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly";
/** The calendar read: always the account's own primary calendar. */
export const CALENDAR_ID = "primary";
/**
 * The field mask on every events.list request: exactly what booking detection needs. Changing it
 * is a privacy decision; the contract test fails if it ever asks for a title or a description.
 */
export const EVENT_FIELDS = "nextPageToken,items(id,status,recurringEventId,start(date,dateTime),end(date,dateTime),attendees(email,self,responseStatus),organizer(email,self))";
const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 10;
const RESPONSES: ReadonlySet<string> = new Set(["accepted", "declined", "tentative", "needsAction"]);
const STATUSES: ReadonlySet<string> = new Set(["confirmed", "tentative", "cancelled"]);
const ADDRESS = /^[^\s@<>()",;:]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

interface Options {
  baseUrl: string;
  maxPages: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function readOptions(ctx: AdapterContext): Options {
  const raw = ctx.options;
  const baseUrl = typeof raw.apiBaseUrl === "string" && /^https:\/\/[^/\s]+/.test(raw.apiBaseUrl) ? raw.apiBaseUrl.replace(/\/+$/, "") : CALENDAR_API;
  const maxPages = typeof raw.maxPages === "number" && Number.isInteger(raw.maxPages) && raw.maxPages >= 1 && raw.maxPages <= 20 ? raw.maxPages : DEFAULT_MAX_PAGES;
  return { baseUrl, maxPages };
}

/** The AdapterError for a Calendar API error response, with Google's short reason only. */
export async function calendarError(response: Response, what: string): Promise<AdapterError> {
  let reason = "";
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    const first = Array.isArray(error.errors) && isRecord(error.errors[0]) ? error.errors[0] : {};
    const candidate = str(first.reason) ?? str(error.status) ?? "";
    reason = /^[A-Za-z_]{1,60}$/.test(candidate) ? candidate : "";
  } catch {
    // No reason.
  }
  const detail = `${what} failed with HTTP ${response.status}${reason ? ` (${reason})` : ""}`;
  const retryAfter = Number(response.headers.get("retry-after"));
  const opts = Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {};
  if (response.status === 400) return new AdapterError(detail, "invalid", false);
  if (response.status === 401) return new AdapterError(detail, "auth", false);
  if (response.status === 403) {
    if (/ratelimit/i.test(reason)) return new AdapterError(detail, "rate_limited", true, opts);
    if (/dailylimit|quota/i.test(reason)) return new AdapterError(detail, "quota", true, opts);
    return new AdapterError(detail, "auth", false);
  }
  if (response.status === 404) return new AdapterError(detail, "not_found", false);
  if (response.status === 429) return new AdapterError(detail, "rate_limited", true, opts);
  if (response.status >= 500) return new AdapterError(detail, "unavailable", true, opts);
  return new AdapterError(detail, "unknown", false);
}

/** An address as core reads it, or null when it is not one plain address. */
function address(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return lower.length <= 254 && ADDRESS.test(lower) ? lower : null;
}

/** An RFC 3339 time as ISO 8601 UTC, or null. */
function utc(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** One API event as core sees it: only the fields the mask names, whatever else the answer holds. */
export function toSummary(item: unknown): CalendarEventSummary | null {
  if (!isRecord(item)) return null;
  const id = str(item.id);
  if (!id || id.length > 1024) return null;
  const status = typeof item.status === "string" && STATUSES.has(item.status) ? (item.status as CalendarEventSummary["status"]) : "tentative";
  const start = isRecord(item.start) ? item.start : {};
  const end = isRecord(item.end) ? item.end : {};
  const allDay = !str(start.dateTime) && Boolean(str(start.date));
  const attendees: CalendarAttendee[] = [];
  for (const raw of Array.isArray(item.attendees) ? item.attendees : []) {
    if (!isRecord(raw)) continue;
    const email = address(raw.email);
    if (!email) continue;
    const response = typeof raw.responseStatus === "string" && RESPONSES.has(raw.responseStatus) ? (raw.responseStatus as CalendarAttendee["responseStatus"]) : "needsAction";
    attendees.push({ email, self: raw.self === true, responseStatus: response });
  }
  const series = str(item.recurringEventId);
  const organizerEmail = isRecord(item.organizer) ? address(item.organizer.email) : null;
  return {
    id,
    status,
    start: allDay ? null : utc(start.dateTime),
    end: allDay ? null : utc(end.dateTime),
    allDay,
    seriesId: series && series.length <= 1024 ? series : null,
    organizer: organizerEmail && isRecord(item.organizer) ? { email: organizerEmail, self: item.organizer.self === true } : null,
    attendees,
  };
}

const readOnly = (method: string) => new AdapterError(`${NAME} is read-only (calendar.events.owned.readonly); ${method} is not supported`, "invalid", false);

export function createAdapter(ctx: AdapterContext): CalendarProvider {
  const options = readOptions(ctx);
  const auth = createGoogleAuth(ctx, { refreshTokenName: REFRESH_TOKEN_NAME });
  const eventsPath = `${options.baseUrl}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

  async function call(url: string, what: string, retried = false): Promise<Response> {
    const token = await auth.accessToken();
    let response: Response;
    try {
      response = await ctx.fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (error) {
      throw new AdapterError(`${what} failed before an answer arrived`, "timeout", true, { cause: error });
    }
    if (response.status === 401 && !retried) {
      auth.invalidate();
      return call(url, what, true);
    }
    if (!response.ok) throw await calendarError(response, what);
    return response;
  }

  return {
    name: NAME,
    capabilities: { list: true, freeBusy: false, write: false },

    async listEvents(args) {
      const timeMin = utc(args.start);
      const timeMax = utc(args.end);
      if (!timeMin || !timeMax || timeMax < timeMin) throw new AdapterError("listEvents needs a start and an end, in order", "invalid", false);
      const events: CalendarEventSummary[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const params = new URLSearchParams({
          timeMin,
          timeMax,
          singleEvents: "true",
          showDeleted: "true",
          maxResults: String(PAGE_SIZE),
          fields: EVENT_FIELDS,
        });
        if (pageToken) params.set("pageToken", pageToken);
        const response = await call(`${eventsPath}?${params.toString()}`, "event list");
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new AdapterError("event list answered with something other than JSON", "unknown", true);
        }
        pages += 1;
        const page = isRecord(body) ? body : {};
        for (const item of Array.isArray(page.items) ? page.items : []) {
          const summary = toSummary(item);
          if (summary) events.push(summary);
        }
        pageToken = str(page.nextPageToken);
      } while (pageToken && pages < options.maxPages);
      if (pageToken) ctx.logger.warn("calendar listing stopped at the page limit; later events in the window were not read", { pages });
      return events;
    },

    freeBusy: () => Promise.reject(readOnly("freeBusy")),
    createEvent: () => Promise.reject(readOnly("createEvent")),
    updateEvent: () => Promise.reject(readOnly("updateEvent")),
    cancelEvent: () => Promise.reject(readOnly("cancelEvent")),
  };
}
