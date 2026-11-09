// GTM-agents: the one definition of a meeting booked, and the meeting counts every report reads.
//
//   - A meeting is booked when calendar sync (packages/core/src/convert/) has tied a calendar event
//     to a contact with one of MEETING_ATTRIBUTIONS (calendar_meetings.attribution), and it is not
//     cancelled. A row with no attribution, or one this module does not know, never counts. A
//     meeting the operator unlinked has no row at all.
//   - It counts toward a send, as the meeting half of the positive-reply definition
//     (positive-reply.ts, meetingCountsAsPositive), when it was also first seen after that send:
//     meetingEvidence turns a row into that function's input.
//   - Held and no-show are the operator's answers after the meeting (calendar_meetings.outcome).
//
// countMeetings counts, for a window: meetings booked by when they were first seen, and held,
// no-show and cancelled meetings by when they were due to start. Every function throws on a
// database error, so a report shows the section as unreadable instead of a zero.
import type { MeetingEvidence } from "./positive-reply.ts";
import { n, sqlList } from "./sql.ts";
import type { MetricWindow } from "./window.ts";

/** How a meeting was tied to a contact. */
export const MEETING_ATTRIBUTIONS = ["accepted_contact", "organized_contact", "domain_contacted", "operator_link"] as const;
export type MeetingAttribution = (typeof MEETING_ATTRIBUTIONS)[number];

/** Attributions that rest on a guess (one contacted person at the attendee's domain), not on an address match. */
export const HEURISTIC_ATTRIBUTIONS: readonly MeetingAttribution[] = Object.freeze(["domain_contacted"]);

/** The meeting outcomes calendar_meetings.outcome may hold. */
export const MEETING_OUTCOMES = ["held", "no_show", "rescheduled", "cancelled"] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

export function isMeetingAttribution(value: unknown): value is MeetingAttribution {
  return typeof value === "string" && (MEETING_ATTRIBUTIONS as readonly string[]).includes(value);
}

/** The calendar_meetings columns the definition reads. */
export interface MeetingRow {
  status: string;
  attribution: string | null;
  first_seen_at: string;
}

/** True for a meeting that is attributed and not cancelled. */
export function isMeetingBooked(row: Pick<MeetingRow, "status" | "attribution">): boolean {
  return row.status !== "cancelled" && isMeetingAttribution(row.attribution);
}

/** A meeting row as the positive-reply definition's meeting input. */
export function meetingEvidence(row: MeetingRow): MeetingEvidence {
  return { status: row.status, attributed: isMeetingAttribution(row.attribution), firstSeenAt: row.first_seen_at };
}

function alias(a: string): string {
  if (!/^[a-z]{1,8}$/.test(a)) throw new Error(`"${a}" is not a table alias`);
  return a;
}

/** A booked meeting (calendar_meetings, alias `a`): the same rule as isMeetingBooked. */
export const meetingBookedSql = (a: string): string => `(${alias(a)}.status <> 'cancelled' AND ${alias(a)}.attribution IN (${sqlList(MEETING_ATTRIBUTIONS)}))`;

/** An attributed meeting, cancelled or not. */
export const meetingAttributedSql = (a: string): string => `${alias(a)}.attribution IN (${sqlList(MEETING_ATTRIBUTIONS)})`;

export interface MeetingCounts {
  /** Meetings booked (attributed, not cancelled) first seen in the window. */
  booked: number;
  /** Attributed meetings the operator marked held, due to start in the window. */
  held: number;
  /** Attributed meetings the operator marked a no-show, due to start in the window. */
  noShows: number;
  /** Attributed meetings that were cancelled, due to start in the window. */
  cancelled: number;
}

/** Meetings booked, held, missed and cancelled in the window. */
export async function countMeetings(db: D1Database, window: MetricWindow): Promise<MeetingCounts> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN ${meetingBookedSql("m")} AND m.first_seen_at >= ?1 AND m.first_seen_at < ?2 THEN 1 ELSE 0 END) AS booked,
              SUM(CASE WHEN ${meetingAttributedSql("m")} AND m.outcome = 'held' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS held,
              SUM(CASE WHEN ${meetingAttributedSql("m")} AND m.outcome = 'no_show' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS no_shows,
              SUM(CASE WHEN ${meetingAttributedSql("m")} AND m.status = 'cancelled' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS cancelled
         FROM calendar_meetings m
        WHERE (m.first_seen_at >= ?1 AND m.first_seen_at < ?2) OR (m.starts_at >= ?1 AND m.starts_at < ?2)`,
    )
    .bind(window.from, window.to)
    .first<{ booked: number | null; held: number | null; no_shows: number | null; cancelled: number | null }>();
  return { booked: n(row?.booked), held: n(row?.held), noShows: n(row?.no_shows), cancelled: n(row?.cancelled) };
}

/** `count` per 100 of `base`, to one decimal, or null when the base is zero. */
export function perHundred(count: number, base: number): number | null {
  if (!(base > 0)) return null;
  return Math.round((count / base) * 1000) / 10;
}
