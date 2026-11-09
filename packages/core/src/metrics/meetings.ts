// GTM-agents: the one definition of a meeting booked, and the meeting counts every report reads.
//
//   - A meeting is booked when calendar sync (packages/core/src/convert/) has tied a calendar event
//     to a contact with one of MEETING_ATTRIBUTIONS (calendar_meetings.attribution), it is not
//     cancelled, and it had not already started when calendar sync began watching
//     (calendar_meetings.before_baseline is 0). A row with no attribution, or one this module does
//     not know, never counts. A meeting the operator unlinked has no row at all. Booked does not
//     require outreach: a call with an existing customer that calendar sync attributes is booked.
//   - It follows outreach when the contact had a first touch sent in the ATTRIBUTION_WINDOW_DAYS
//     before the meeting was first seen: the rule the per-send ledger credits it by (convert's
//     ledger.ts), and the meeting half of the positive-reply definition (positive-reply.ts,
//     meetingCountsAsPositive). meetingEvidence turns a row into that function's input.
//   - Held and no-show are the operator's answers after the meeting (calendar_meetings.outcome).
//
// countMeetings counts, for a window: meetings booked by when they were first seen, and held,
// no-show and cancelled meetings by when they were due to start, each in total and, for booked and
// held, the part that followed outreach. Every function throws on a database error, so a report
// shows the section as unreadable instead of a zero. There is no other meeting counter: the
// templates table keeps none (a per-template count is this rule joined to the credited send).
import { ATTRIBUTION_WINDOW_DAYS } from "./attribution.ts";
import type { MeetingEvidence } from "./positive-reply.ts";
import { firstTouchSql, n, sqlList } from "./sql.ts";
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
  /** 1 when the meeting had already started when calendar sync began watching. Missing counts as 0. */
  before_baseline?: number | null;
}

/** True for a meeting that is attributed, not cancelled, and not from before calendar sync's baseline. */
export function isMeetingBooked(row: Pick<MeetingRow, "status" | "attribution" | "before_baseline">): boolean {
  return row.status !== "cancelled" && isMeetingAttribution(row.attribution) && !row.before_baseline;
}

/**
 * A meeting row as the positive-reply definition's meeting input. A meeting from before the
 * baseline has no real booking time (its first sighting is when sync began), so it credits nothing.
 */
export function meetingEvidence(row: MeetingRow): MeetingEvidence {
  return { status: row.status, attributed: isMeetingAttribution(row.attribution) && !row.before_baseline, firstSeenAt: row.first_seen_at };
}

function alias(a: string): string {
  if (!/^[a-z]{1,8}$/.test(a)) throw new Error(`"${a}" is not a table alias`);
  return a;
}

/** A booked meeting (calendar_meetings, alias `a`): the same rule as isMeetingBooked. */
export const meetingBookedSql = (a: string): string =>
  `(${alias(a)}.status <> 'cancelled' AND ${alias(a)}.attribution IN (${sqlList(MEETING_ATTRIBUTIONS)}) AND COALESCE(${alias(a)}.before_baseline, 0) = 0)`;

/** An attributed meeting, cancelled or not. */
export const meetingAttributedSql = (a: string): string => `${alias(a)}.attribution IN (${sqlList(MEETING_ATTRIBUTIONS)})`;

/**
 * An attributed meeting (alias `a`) that followed outreach: not from before the baseline, and the
 * contact had a first touch sent before the meeting was first seen, within ATTRIBUTION_WINDOW_DAYS.
 * The same rule creditedSend and meetingCountsAsPositive apply to one meeting.
 */
export const meetingAfterOutreachSql = (a: string): string =>
  `(${meetingAttributedSql(a)} AND COALESCE(${alias(a)}.before_baseline, 0) = 0 AND EXISTS (SELECT 1 FROM outreach_sends mft WHERE mft.contact_id = ${alias(a)}.contact_id AND ${firstTouchSql("mft")}
     AND mft.sent_at < ${alias(a)}.first_seen_at AND mft.sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ${alias(a)}.first_seen_at, '-${Number(ATTRIBUTION_WINDOW_DAYS)} days')))`;

export interface MeetingCounts {
  /** Meetings booked (attributed, not cancelled, not from before the baseline) first seen in the window, outreach or not. */
  booked: number;
  /** The booked meetings that followed outreach (meetingAfterOutreachSql). */
  bookedAfterOutreach: number;
  /** Attributed meetings the operator marked held, due to start in the window. */
  held: number;
  /** The held meetings that followed outreach. */
  heldAfterOutreach: number;
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
              SUM(CASE WHEN ${meetingBookedSql("m")} AND ${meetingAfterOutreachSql("m")} AND m.first_seen_at >= ?1 AND m.first_seen_at < ?2 THEN 1 ELSE 0 END) AS booked_after,
              SUM(CASE WHEN ${meetingAttributedSql("m")} AND m.outcome = 'held' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS held,
              SUM(CASE WHEN ${meetingAfterOutreachSql("m")} AND m.outcome = 'held' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS held_after,
              SUM(CASE WHEN ${meetingAttributedSql("m")} AND m.outcome = 'no_show' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS no_shows,
              SUM(CASE WHEN ${meetingAttributedSql("m")} AND m.status = 'cancelled' AND m.starts_at >= ?1 AND m.starts_at < ?2 THEN 1 ELSE 0 END) AS cancelled
         FROM calendar_meetings m
        WHERE (m.first_seen_at >= ?1 AND m.first_seen_at < ?2) OR (m.starts_at >= ?1 AND m.starts_at < ?2)`,
    )
    .bind(window.from, window.to)
    .first<{ booked: number | null; booked_after: number | null; held: number | null; held_after: number | null; no_shows: number | null; cancelled: number | null }>();
  return {
    booked: n(row?.booked),
    bookedAfterOutreach: n(row?.booked_after),
    held: n(row?.held),
    heldAfterOutreach: n(row?.held_after),
    noShows: n(row?.no_shows),
    cancelled: n(row?.cancelled),
  };
}

/** `count` per 100 of `base`, to one decimal, or null when the base is zero. */
export function perHundred(count: number, base: number): number | null {
  if (!(base > 0)) return null;
  return Math.round((count / base) * 1000) / 10;
}
