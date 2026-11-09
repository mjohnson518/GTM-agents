// GTM-agents: what calendar sync reads from one event, before any database lookup.
//
// classifyEvent is pure. From the event's times, status, organizer and attendees it decides:
//   - timed: the event has a start and an end time (all-day events are never meetings);
//   - outside attendees: everyone on the invite except the calendar's own account, anyone who
//     declined, addresses at the company's or the sending domain (or their subdomains) or one of
//     the deployment's own addresses, and calendar resources and group calendars. An outside
//     organizer counts only through their own entry on the attendee list: the organizer field of
//     an invite from outside proves nothing;
//   - operatorOrganized: the calendar's own account organized it. A colleague's address in the
//     organizer field is not enough: that field can be forged on an invite from outside;
//   - booking: timed, not cancelled, not declined by the operator, at most MAX_OUTSIDE_ATTENDEES
//     outside attendees (a larger invite is an event, not a meeting), and either an outside
//     attendee accepted or the operator organized it. On an invite the operator did not organize,
//     the operator must also have accepted it (or answered maybe): the answers of the other
//     attendees on such an invite are written by its sender and can be forged. Anyone can put an invite on a calendar, so an
//     invite from outside counts only once someone outside has accepted it.
// The event states calendar_events.state holds are defined here, once.
import type { GtmConfig } from "../config/schema.ts";
import type { CalendarEventSummary } from "../ports/business.ts";
import { normalizeAddress } from "../sending/suppression.ts";

/** How attribution ended for an event calendar sync kept (calendar_events.state). */
export const CALENDAR_EVENT_STATES = ["attributed", "ambiguous", "unmatched", "inert"] as const;
export type CalendarEventState = (typeof CALENDAR_EVENT_STATES)[number];

/** An invite with more outside attendees than this is an event, not a meeting. */
export const MAX_OUTSIDE_ATTENDEES = 10;

/** Calendar resources (rooms, equipment) and group calendars have addresses under this domain. */
const RESOURCE_DOMAIN = "calendar.google.com";

export interface OutsideAttendee {
  /** Normalized, lowercase. */
  email: string;
  accepted: boolean;
}

export interface ClassifiedEvent {
  timed: boolean;
  operatorOrganized: boolean;
  operatorDeclined: boolean;
  /** The calendar's own account accepted the invite, or answered maybe. */
  operatorAccepted: boolean;
  outside: OutsideAttendee[];
  booking: boolean;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const under = (domain: string, parent: string) => domain === parent || domain.endsWith(`.${parent}`);

/** True for an address that belongs to the deployment: its own mailboxes, the company domain or the sending domain. */
export function isInternalAddress(config: Pick<GtmConfig, "company" | "sending">, address: string): boolean {
  const own = [config.sending.replyTo, config.sending.supportAddress, config.sending.from.email].map((a) => a.toLowerCase());
  if (own.includes(address)) return true;
  const domain = domainOf(address);
  return under(domain, config.company.domain) || under(domain, config.sending.domain);
}

/** True for a calendar resource or group calendar address. */
export function isResourceAddress(address: string): boolean {
  return under(domainOf(address), RESOURCE_DOMAIN);
}

/** Classify one listed event. Pure. */
export function classifyEvent(event: CalendarEventSummary, config: Pick<GtmConfig, "company" | "sending">): ClassifiedEvent {
  const timed = !event.allDay && event.start !== null && event.end !== null && event.end >= event.start;
  const operatorOrganized = event.organizer?.self === true;
  const operatorDeclined = event.attendees.some((a) => a.self && a.responseStatus === "declined");
  const operatorAccepted = event.attendees.some((a) => a.self && (a.responseStatus === "accepted" || a.responseStatus === "tentative"));
  const seen = new Set<string>();
  const outside: OutsideAttendee[] = [];
  for (const attendee of event.attendees) {
    if (attendee.self || attendee.responseStatus === "declined") continue;
    const email = normalizeAddress(attendee.email);
    if (!email || seen.has(email) || isResourceAddress(email) || isInternalAddress(config, email)) continue;
    seen.add(email);
    outside.push({ email, accepted: attendee.responseStatus === "accepted" });
  }
  const rest = { timed, operatorOrganized, operatorDeclined, operatorAccepted, outside };
  return { ...rest, booking: isBooking(event, rest) };
}

/** The booking rule over a classified event. Pure. */
export function isBooking(event: Pick<CalendarEventSummary, "status">, c: Omit<ClassifiedEvent, "booking">): boolean {
  return (
    c.timed &&
    event.status !== "cancelled" &&
    !c.operatorDeclined &&
    // On an invite from outside, every answer on it is written by the sender's side and can be
    // forged; only the operator's own acceptance makes it a meeting.
    (c.operatorOrganized || c.operatorAccepted) &&
    c.outside.length > 0 &&
    c.outside.length <= MAX_OUTSIDE_ATTENDEES &&
    (c.outside.some((a) => a.accepted) || c.operatorOrganized)
  );
}

/** The short id the meeting commands use for an event: "mg" and ten hex characters of its id's SHA-256. */
export async function meetingCode(eventId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`calendar-event:${eventId}`));
  return `mg${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10)}`;
}

/** The effects-ledger event id for a meeting's one-time effects. */
export const meetingEffectKey = (code: string): string => `calendar:${code}`;
