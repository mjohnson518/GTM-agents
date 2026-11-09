// GTM-agents: calendar sync: read the calendar, find bookings, attribute them, and keep up with
// cancellations and moves.
//
// One run lists the primary calendar from 3 days back to 60 days ahead (the adapter asks only for
// ids, status, times, attendees and organizer) and, for each event, at most maxRows of them in start
// order (events already known first, so a cut never drops a cancellation). Attendees an erasure
// tombstone covers are dropped first, so a sync never brings an erased person back:
//   - a booking (state.ts) never seen before is attributed (attribution.ts) and stored in
//     calendar_events with its attendees' address hashes and domains, never an address. Attributed,
//     it gets a calendar_meetings row (first_seen_at is now) and the booked effects run (booked.ts).
//     Ambiguous, the operator is told once, with the candidates and the command that links one.
//     Unmatched, it is kept quietly until the window passes it, and /meetings lists it. A recurring
//     series counts once: only its first instance seen is a booking;
//   - a known booking that is still unattributed is attributed again (someone may have accepted, or
//     become a contact since);
//   - a known meeting whose time changed is moved: reminders and the held question re-arm and the
//     operator is told once per new time;
//   - a known meeting that was cancelled, declined by the operator, or lost the people it rests on
//     (the contact it is attributed to by address declined or left the invite; for other
//     attributions, every outside attendee did) before it started stops counting. A change of
//     answer to "maybe" is not a cancellation. It its credit is withdrawn
//     (booked.ts), its recap and follow-up drafts are withdrawn, a rebook draft waits for approval,
//     and the operator is told once. A meeting removed once it started is left as it was;
//   - an event the operator unlinked (inert) is left alone, and a sync racing a command never
//     moves an event out of inert or back from attributed;
//   - booked effects that failed on an earlier run are retried.
// Unmatched events are forgotten 3 days after they end, ambiguous ones after 14.
// The listing itself failing throws: the run fails, and the job runner pages with the provider's
// short error code (an unauthorized_client there usually means the calendar scope was not granted).
// Everything after the listing is per event: one event's failure is logged and never stops the rest.
import type { GtmConfig } from "../config/schema.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { CalendarEventSummary, CalendarProvider } from "../ports/business.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { label } from "../reports/format.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { attendeeFingerprint, attributeEvent, withoutErased, type AttributionResult } from "./attribution.ts";
import { applyBooked, dealFor, withdrawBooked } from "./booked.ts";
import { displayName, when } from "./brief.ts";
import { createConvertDraft, withdrawConvertDrafts } from "./drafts.ts";
import { CONVERT_LIMITS } from "./flags.ts";
import { classifyEvent, meetingCode, meetingEffectKey, type CalendarEventState, type ClassifiedEvent } from "./state.ts";

const DAY_MS = 86_400_000;
/** Attributions that rest on the contact's own address being on the invite. */
const ADDRESS_ATTRIBUTIONS: ReadonlySet<string> = new Set(["accepted_contact", "organized_contact"]);

export interface SyncDeps {
  db: D1Database;
  calendar: CalendarProvider;
  config: GtmConfig;
  operator?: OperatorChannel | undefined;
  /** Where approval requests record what was shown (the KV namespace). */
  shown?: ShownStore | undefined;
  chatId?: string | undefined;
  now: Date;
  log: JobLogger;
  /** Events handled per run, at most. */
  maxRows: number;
}

export interface SyncResult {
  listed: number;
  handled: number;
  booked: number;
  ambiguous: number;
  unmatched: number;
  moved: number;
  cancelled: number;
  failed: number;
  /** More events were listed than one run handles. */
  truncated: boolean;
}

interface EventRow {
  event_id: string;
  code: string;
  status: string;
  starts_at: string;
  ends_at: string;
  state: CalendarEventState;
  first_seen_at: string;
  series_id: string | null;
  other_contacts: string;
}

export interface MeetingRecord {
  event_id: string;
  contact_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  attribution: string | null;
  outcome: string | null;
  first_seen_at: string;
}

/** The sync window at `now`: 3 days back to 60 days ahead. */
export function syncWindow(now: Date): { start: string; end: string } {
  return {
    start: new Date(now.getTime() - CONVERT_LIMITS.syncBackDays * DAY_MS).toISOString(),
    end: new Date(now.getTime() + CONVERT_LIMITS.syncAheadDays * DAY_MS).toISOString(),
  };
}

async function tell(deps: Pick<SyncDeps, "operator" | "chatId">, text: string): Promise<void> {
  if (!deps.operator) return;
  await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
}

/** Send a notice once per (key, effect): claimed first, released when the channel fails. Never throws. */
async function noticeOnce(deps: Pick<SyncDeps, "db" | "operator" | "chatId" | "log">, key: string, effect: string, text: string): Promise<boolean> {
  if (!deps.operator) return false;
  try {
    if (!(await claimEffect(deps.db, key, effect))) return false;
  } catch {
    return false;
  }
  try {
    await tell(deps, text);
    return true;
  } catch (error) {
    await releaseEffect(deps.db, key, effect);
    deps.log.warn("an operator notice could not be sent; the next sync tries again", { effect, error: sanitizeErrorMessage(error) });
    return false;
  }
}

async function contactLine(db: D1Database, id: string): Promise<string> {
  const c = await db.prepare("SELECT first_name, last_name, email, job_title FROM contacts WHERE id = ?1").bind(id).first<{ first_name: string | null; last_name: string | null; email: string; job_title: string | null }>();
  if (!c) return id;
  return `${displayName(c)}${c.job_title ? ` (${label(c.job_title, 40)})` : ""} <${c.email}>, ${id}`;
}

function ambiguousNotice(code: string, startsAt: string, domains: readonly string[], candidates: readonly string[]): string {
  return [
    `A meeting on ${when(startsAt)} [${code}] could belong to more than one contact, so it was not attributed.`,
    `Outside attendees at: ${domains.map((d) => label(d, 60)).join(", ")}`,
    "Contacts it could be:",
    ...candidates.slice(0, CONVERT_LIMITS.listed).map((c) => `  ${c}`),
    `Link one with meeting-link-${code} <contact id>. Until then nothing happens: outreach continues and no brief is written.`,
  ].join("\n");
}

/**
 * Insert or refresh the calendar_events row. The state never leaves inert (only the operator's link
 * does that) and never falls back from attributed, so a sync racing a command cannot undo it.
 * Throws on a database error.
 */
async function saveEvent(
  deps: SyncDeps,
  event: CalendarEventSummary,
  classified: ClassifiedEvent,
  code: string,
  state: CalendarEventState,
  firstSeenAt: string,
  otherContacts?: readonly string[],
): Promise<void> {
  const print = await attendeeFingerprint(classified.outside);
  const at = deps.now.toISOString();
  await deps.db
    .prepare(
      `INSERT INTO calendar_events (event_id, series_id, code, status, starts_at, ends_at, operator_organized, attendee_hashes, attendee_domains, other_contacts, state, first_seen_at, last_seen_at, attendees, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, '[]'), ?11, ?12, ?13, ?14, ?13, ?13)
       ON CONFLICT (event_id) DO UPDATE SET status = excluded.status, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         operator_organized = excluded.operator_organized, attendee_hashes = excluded.attendee_hashes, attendee_domains = excluded.attendee_domains,
         attendees = excluded.attendees,
         other_contacts = CASE WHEN ?10 IS NULL THEN calendar_events.other_contacts ELSE excluded.other_contacts END,
         state = CASE WHEN calendar_events.state = 'inert' THEN 'inert'
                      WHEN calendar_events.state = 'attributed' AND excluded.state <> 'attributed' THEN 'attributed'
                      ELSE excluded.state END,
         last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
    )
    .bind(
      event.id,
      event.seriesId,
      code,
      event.status,
      event.start,
      event.end,
      classified.operatorOrganized ? 1 : 0,
      JSON.stringify(print.hashes),
      JSON.stringify(print.domains),
      otherContacts ? JSON.stringify(otherContacts) : null,
      state,
      firstSeenAt,
      at,
      JSON.stringify(print.entries),
    )
    .run();
}

/** The stored state of an event, read again right before acting on it. Throws on a database error. */
async function currentState(db: D1Database, eventId: string): Promise<string | null> {
  return (await db.prepare("SELECT state FROM calendar_events WHERE event_id = ?1").bind(eventId).first<{ state: string }>())?.state ?? null;
}

function contactIdList(text: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Record an attributed meeting and run its booked effects. Throws on a database error before the effects. */
async function attach(deps: SyncDeps, event: CalendarEventSummary, code: string, result: Extract<AttributionResult, { kind: "attributed" }>, firstSeenAt: string): Promise<void> {
  const [contactId, ...others] = result.contactIds;
  if (!contactId) return;
  if ((await currentState(deps.db, event.id)) !== "attributed") return;
  const at = deps.now.toISOString();
  await deps.db
    .prepare(
      `INSERT INTO calendar_meetings (event_id, contact_id, starts_at, ends_at, status, attribution, first_seen_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (event_id) DO NOTHING`,
    )
    .bind(event.id, contactId, event.start, event.end, event.status, result.method, firstSeenAt, at)
    .run();
  const stored = await deps.db.prepare("SELECT contact_id, attribution, status, first_seen_at, starts_at, ends_at FROM calendar_meetings WHERE event_id = ?1").bind(event.id).first<MeetingRecord>();
  if (!stored) return;
  await applyBooked(
    { db: deps.db, config: deps.config, operator: deps.operator, chatId: deps.chatId, now: deps.now, log: deps.log },
    { ...stored, event_id: event.id, code, otherContactIds: stored.contact_id === contactId ? others : [] },
  );
}

/**
 * A meeting stopped counting before it started: cancelled, withdrawn credit, withdrawn drafts, a rebook
 * draft, one notice. Throws on a database error before anything external happens.
 */
export async function cancelMeeting(
  deps: Pick<SyncDeps, "db" | "config" | "operator" | "shown" | "chatId" | "now" | "log">,
  meeting: MeetingRecord,
  code: string,
  reason: "cancelled" | "declined",
): Promise<boolean> {
  const at = deps.now.toISOString();
  const update = await deps.db
    .prepare(
      `UPDATE calendar_meetings SET status = 'cancelled', outcome = COALESCE(outcome, 'cancelled'), outcome_at = COALESCE(outcome_at, ?2), sequence_stopped = 1, updated_at = ?2
        WHERE event_id = ?1 AND status <> 'cancelled'`,
    )
    .bind(meeting.event_id, at)
    .run();
  if ((update.meta.changes ?? 0) === 0) return false;
  await withdrawBooked(deps, { event_id: meeting.event_id, code, contact_id: meeting.contact_id, first_seen_at: meeting.first_seen_at });
  try {
    await withdrawConvertDrafts(deps.db, code, ["recap", "step2", "step3"], deps.now);
  } catch (error) {
    deps.log.warn("a cancelled meeting's drafts could not be withdrawn", { code, error: sanitizeErrorMessage(error) });
  }
  const contact = await deps.db.prepare("SELECT id, email, first_name, last_name, timezone, account_key FROM contacts WHERE id = ?1").bind(meeting.contact_id).first<{ id: string; email: string; first_name: string | null; last_name: string | null; timezone: string | null; account_key: string | null }>();
  if (!contact) return true;
  const deal = await dealFor(deps.db, contact.id, contact.account_key).catch(() => null);
  const draft = await createConvertDraft(
    { db: deps.db, config: deps.config, operator: deps.operator, shown: deps.shown, chatId: deps.chatId, now: deps.now, log: deps.log },
    { code, kind: "rebook", contact, dealId: deal?.id ?? null, meetingStart: meeting.starts_at, attribution: meeting.attribution, reason: "cancelled" },
  );
  const why = reason === "declined" ? "was declined" : "was cancelled";
  const drafted = draft.status === "created" ? " A rebook draft is waiting for your approval." : draft.status === "suppressed" ? " Their address is suppressed, so no rebook draft was written." : "";
  await noticeOnce(deps, meetingEffectKey(code), `meeting_cancelled:${meeting.starts_at}`, `The meeting with ${displayName(contact)} on ${when(meeting.starts_at)} [${code}] ${why}.${drafted}`);
  return true;
}

/** One sync run. Throws only when the calendar cannot be listed or read at all. */
export async function runCalendarSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, now, log } = deps;
  const result: SyncResult = { listed: 0, handled: 0, booked: 0, ambiguous: 0, unmatched: 0, moved: 0, cancelled: 0, failed: 0, truncated: false };
  const listed = await deps.calendar.listEvents(syncWindow(now));
  result.listed = listed.length;
  // Events already known come first, so a cut never drops a cancellation of a booked meeting.
  const { results: knownIds } = await db
    .prepare("SELECT event_id FROM calendar_events WHERE event_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(listed.map((e) => e.id)))
    .all<{ event_id: string }>();
  const isKnown = new Set(knownIds.map((r) => r.event_id));
  const events = [...listed].sort(
    (a, b) => Number(isKnown.has(b.id)) - Number(isKnown.has(a.id)) || (a.start ?? "\uffff").localeCompare(b.start ?? "\uffff") || a.id.localeCompare(b.id),
  );
  if (events.length > deps.maxRows) {
    result.truncated = true;
    events.length = deps.maxRows;
  }
  const ids = JSON.stringify(events.map((e) => e.id));
  const [{ results: rows }, { results: meetings }] = await Promise.all([
    db
      .prepare("SELECT event_id, series_id, code, status, starts_at, ends_at, state, first_seen_at, other_contacts FROM calendar_events WHERE event_id IN (SELECT value FROM json_each(?1))")
      .bind(ids)
      .all<EventRow>(),
    db
      .prepare("SELECT event_id, contact_id, starts_at, ends_at, status, attribution, outcome, first_seen_at FROM calendar_meetings WHERE event_id IN (SELECT value FROM json_each(?1))")
      .bind(ids)
      .all<MeetingRecord>(),
  ]);
  const known = new Map(rows.map((r) => [r.event_id, r]));
  const meetingOf = new Map(meetings.map((m) => [m.event_id, m]));
  const at = now.toISOString();

  for (const event of events) {
    try {
      const row = known.get(event.id);
      const meeting = meetingOf.get(event.id);
      const code = row?.code ?? (await meetingCode(event.id));
      // Erased people are dropped before anything is stored or matched.
      const classified = await withoutErased(db, event, classifyEvent(event, deps.config));

      // A booked meeting: it stops counting only when it is cancelled, the operator declines, or
      // the people it rests on decline or leave the invite. A change of answer to "maybe" is not a
      // cancellation.
      if (row?.state === "attributed" && meeting && meeting.status !== "cancelled") {
        const contact = await db.prepare("SELECT email_sha256, mailbox_sha256 FROM contacts WHERE id = ?1").bind(meeting.contact_id).first<{ email_sha256: string; mailbox_sha256: string }>();
        const present = (await attendeeFingerprint(classified.outside)).hashes;
        const stillOn = ADDRESS_ATTRIBUTIONS.has(meeting.attribution ?? "")
          ? contact !== null && (present.includes(contact.email_sha256) || present.includes(contact.mailbox_sha256))
          : classified.outside.length > 0;
        const off = event.status === "cancelled" || classified.operatorDeclined || !classified.timed || !stillOn;
        if (off) {
          await db.prepare("UPDATE calendar_events SET status = ?2, last_seen_at = ?3, updated_at = ?3 WHERE event_id = ?1").bind(event.id, event.status, at).run();
          if (Date.parse(meeting.starts_at) > now.getTime()) {
            result.handled += 1;
            if (await cancelMeeting(deps, meeting, code, event.status === "cancelled" ? "cancelled" : "declined")) result.cancelled += 1;
          }
          continue;
        }
      } else if (!classified.booking) {
        if (row) await db.prepare("UPDATE calendar_events SET status = ?2, last_seen_at = ?3, updated_at = ?3 WHERE event_id = ?1").bind(event.id, event.status, at).run();
        continue;
      }
      result.handled += 1;
      const start = event.start as string;
      const end = event.end as string;

      if (row?.state === "inert") {
        await db.prepare("UPDATE calendar_events SET status = ?2, starts_at = ?3, ends_at = ?4, last_seen_at = ?5, updated_at = ?5 WHERE event_id = ?1").bind(event.id, event.status, start, end, at).run();
        continue;
      }

      if (row?.state === "attributed" && meeting) {
        await saveEvent(deps, event, classified, code, "attributed", row.first_seen_at);
        if ((await currentState(db, event.id)) !== "attributed") continue;
        const moved = meeting.starts_at !== start || meeting.ends_at !== end;
        const restored = meeting.status === "cancelled";
        await db
          .prepare(
            `UPDATE calendar_meetings SET status = ?2, starts_at = ?3, ends_at = ?4,
               reminded_24h_at = CASE WHEN ?5 = 1 THEN NULL ELSE reminded_24h_at END,
               reminded_1h_at = CASE WHEN ?5 = 1 THEN NULL ELSE reminded_1h_at END,
               held_asked_at = CASE WHEN ?5 = 1 THEN NULL ELSE held_asked_at END,
               outcome = CASE WHEN ?6 = 1 OR (?5 = 1 AND ?3 > ?7) THEN NULL ELSE outcome END,
               outcome_at = CASE WHEN ?6 = 1 OR (?5 = 1 AND ?3 > ?7) THEN NULL ELSE outcome_at END,
               sequence_stopped = CASE WHEN ?6 = 1 THEN 0 ELSE sequence_stopped END,
               updated_at = ?7
             WHERE event_id = ?1`,
          )
          .bind(event.id, event.status, start, end, moved ? 1 : 0, restored ? 1 : 0, at)
          .run();
        // A restored meeting no longer needs its rebook.
        if (restored) await withdrawConvertDrafts(db, code, ["rebook"], now);
        if (moved && !restored) {
          result.moved += 1;
          const name = await contactLine(db, meeting.contact_id);
          await noticeOnce(deps, meetingEffectKey(code), `meeting_moved:${start}`, `The meeting with ${name} [${code}] moved to ${when(start)}. Reminders are reset.`);
        }
        await applyBooked(
          { db, config: deps.config, operator: deps.operator, chatId: deps.chatId, now, log },
          {
            event_id: event.id,
            code,
            contact_id: meeting.contact_id,
            starts_at: start,
            ends_at: end,
            status: event.status,
            attribution: meeting.attribution,
            first_seen_at: meeting.first_seen_at,
            otherContactIds: contactIdList(row.other_contacts),
          },
        );
        continue;
      }

      // A recurring series counts as one booking. While another instance of the series is a live
      // booking (attributed and not cancelled), waits for the operator's link (ambiguous) or was
      // unlinked (inert), later instances are not stored, attributed, reminded or counted. With
      // none (the booked instance was cancelled, or earlier instances stayed unmatched), the next
      // instance is considered on its own and can become the series' booking.
      if (!row && event.seriesId) {
        const sibling = await db
          .prepare(
            `SELECT 1 AS hit FROM calendar_events ce LEFT JOIN calendar_meetings cm ON cm.event_id = ce.event_id
              WHERE ce.series_id = ?1 AND ce.event_id <> ?2
                AND (ce.state IN ('ambiguous', 'inert') OR (ce.state = 'attributed' AND cm.status IS NOT NULL AND cm.status <> 'cancelled'))
              LIMIT 1`,
          )
          .bind(event.seriesId, event.id)
          .first();
        if (sibling) {
          result.handled -= 1;
          continue;
        }
      }

      // New, or known but not attributed yet.
      const firstSeenAt = row?.first_seen_at ?? at;
      const attribution = await attributeEvent(db, classified, new Date(firstSeenAt));
      if (attribution.kind === "attributed") {
        await saveEvent(deps, event, classified, code, "attributed", firstSeenAt, attribution.contactIds.slice(1));
        await attach(deps, event, code, attribution, firstSeenAt);
        result.booked += 1;
      } else if (attribution.kind === "ambiguous") {
        await saveEvent(deps, event, classified, code, "ambiguous", firstSeenAt);
        result.ambiguous += 1;
        const candidates = await Promise.all(attribution.candidates.slice(0, CONVERT_LIMITS.listed).map((id) => contactLine(db, id)));
        const domains = (await attendeeFingerprint(classified.outside)).domains;
        if (await noticeOnce(deps, meetingEffectKey(code), "meeting_ambiguous_notice", ambiguousNotice(code, start, domains, candidates))) {
          await db.prepare("UPDATE calendar_events SET noticed_at = ?2 WHERE event_id = ?1 AND noticed_at IS NULL").bind(event.id, at).run();
        }
      } else {
        await saveEvent(deps, event, classified, code, "unmatched", firstSeenAt);
        result.unmatched += 1;
      }
    } catch (error) {
      result.failed += 1;
      log.warn("a calendar event could not be handled; the next sync tries again", { error: sanitizeErrorMessage(error) });
    }
  }

  try {
    await db.batch([
      db.prepare("DELETE FROM calendar_events WHERE state = 'unmatched' AND ends_at < ?1").bind(new Date(now.getTime() - CONVERT_LIMITS.forgetUnmatchedDays * DAY_MS).toISOString()),
      db.prepare("DELETE FROM calendar_events WHERE state = 'ambiguous' AND ends_at < ?1").bind(new Date(now.getTime() - CONVERT_LIMITS.forgetAmbiguousDays * DAY_MS).toISOString()),
    ]);
  } catch (error) {
    log.warn("old unattributed calendar events could not be forgotten", { error: sanitizeErrorMessage(error) });
  }
  return result;
}
