// GTM-agents: test doubles and synthetic fixtures for convert.
//
// Import them from "@gtm-agents/core/convert/testing" in tests only:
//   - fakeCalendar: a CalendarProvider that serves the events a test scripts, records every window
//     it was asked for, can be made to fail, and refuses writes like a read-only adapter;
//   - calendarEvent: one listed event, built from a start, a length and attendees;
//   - resetConvertTables: deletes the rows convert tests write.
// Every person, company and address is invented, on *.example domains.
import type { CalendarAttendee, CalendarEventSummary, CalendarProvider } from "../ports/business.ts";
import { AdapterError } from "../ports/types.ts";

export interface FakeCalendar extends CalendarProvider {
  events: CalendarEventSummary[];
  windows: Array<{ start: string; end: string }>;
  /** listEvents throws this while set. */
  failWith: AdapterError | null;
}

export function fakeCalendar(events: CalendarEventSummary[] = []): FakeCalendar {
  const refuse = (method: string) => Promise.reject(new AdapterError(`fake calendar is read-only; ${method} is not supported`, "invalid", false));
  const calendar: FakeCalendar = {
    name: "fake-calendar",
    capabilities: { list: true, freeBusy: false, write: false },
    events,
    windows: [],
    failWith: null,
    listEvents(window) {
      calendar.windows.push(window);
      if (calendar.failWith) return Promise.reject(calendar.failWith);
      return Promise.resolve(structuredClone(calendar.events));
    },
    freeBusy: () => refuse("freeBusy"),
    createEvent: () => refuse("createEvent"),
    updateEvent: () => refuse("updateEvent"),
    cancelEvent: () => refuse("cancelEvent"),
  };
  return calendar;
}

/** The operator's own address in convert fixtures (the Acme config's reply-to mailbox). */
export const OPERATOR_ADDRESS = "avery@acme.example";

export interface EventInput {
  id: string;
  start: string;
  minutes?: number;
  status?: CalendarEventSummary["status"];
  /** True (the default) when the operator organized it. */
  organizedByOperator?: boolean;
  /** Who organized it when the operator did not. */
  organizer?: string;
  /** Outside attendees and their answers. */
  attendees?: Array<{ email: string; response?: CalendarAttendee["responseStatus"] }>;
  /** The operator's own answer, when they are on the invite. */
  operatorResponse?: CalendarAttendee["responseStatus"];
  allDay?: boolean;
  /** The recurring series this is an instance of. */
  seriesId?: string;
}

/** One listed event, as an adapter returns it: no title, no description. */
export function calendarEvent(input: EventInput): CalendarEventSummary {
  const start = new Date(input.start);
  const end = new Date(start.getTime() + (input.minutes ?? 30) * 60_000);
  const organizedByOperator = input.organizedByOperator !== false;
  const attendees: CalendarAttendee[] = [
    { email: OPERATOR_ADDRESS, self: true, responseStatus: input.operatorResponse ?? (organizedByOperator ? "accepted" : "needsAction") },
    ...(input.attendees ?? []).map((a) => ({ email: a.email.toLowerCase(), self: false, responseStatus: a.response ?? "needsAction" })),
  ];
  return {
    id: input.id,
    status: input.status ?? "confirmed",
    start: input.allDay ? null : start.toISOString(),
    end: input.allDay ? null : end.toISOString(),
    allDay: input.allDay === true,
    seriesId: input.seriesId ?? null,
    organizer: organizedByOperator ? { email: OPERATOR_ADDRESS, self: true } : { email: (input.organizer ?? input.attendees?.[0]?.email ?? "someone@outside.example").toLowerCase(), self: false },
    attendees,
  };
}

/** Delete the rows convert tests write. Storage is per test file, so this touches no other suite. */
export async function resetConvertTables(db: D1Database): Promise<void> {
  const tables = [
    "calendar_events",
    "calendar_meetings",
    "meetings",
    "deal_handoffs",
    "deal_stage_history",
    "deals",
    "drafts",
    "deferred_send_items",
    "deferred_sends",
    "campaign_contacts",
    "outreach_sequence_runs",
    "campaigns",
    "outreach_sends",
    "outreach_log",
    "inbound_emails",
    "templates",
    "event_effects",
    "suppression",
    "signal_events",
    "contact_fit",
    "account_contacts",
    "account_fit",
    "contact_lifecycle",
    "email_verifications",
    "chat_messages",
    "contacts",
    "accounts",
  ];
  await db
    .prepare("INSERT OR IGNORE INTO erasure_tombstones (email_sha256, mailbox_sha256, source, erased_at) SELECT email_sha256, mailbox_sha256, 'operator', created_at FROM contacts WHERE warmth = 'opted_out'")
    .run();
  await db.batch([...tables.map((t) => db.prepare(`DELETE FROM ${t}`)), db.prepare("DELETE FROM erasure_tombstones")]);
}
