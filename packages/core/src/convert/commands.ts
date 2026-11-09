// GTM-agents: the operator's meeting commands. None of them reaches the model; the chat consumer
// routes them before anything else, once per message.
//
//   /meetings                                  upcoming meetings, and bookings not linked to anyone
//   meeting-held-<code>                        it took place: the recap is drafted for approval
//   meeting-noshow-<code>                      it did not: the recap is withdrawn, a rebook drafted
//   meeting-notes-<code> <notes>               keep your notes on the meeting (shown in later briefs)
//   meeting-link-<code> <contact id or email>  tie a booking to a contact: the booked effects run
//   meeting-unlink-<code>                      make a meeting inert: it stops counting, nothing follows
//   prep-<contact id or email>                 a one-page prep brief on any contact
//
// Each accepts an optional leading slash. Codes and ids are matched exactly and only used as lookup
// keys; notes are stored as written, for the operator. The meeting commands need
// convert:calendar_enabled (an unreadable flag refuses); /meetings and prep only read, so they need
// no flag beyond the operator agent. Nothing here sends mail: drafts wait for approval.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { readOn } from "../outreach/flags.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { label } from "../reports/format.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import { addressHash, mailboxOf, normalizeAddress } from "../sending/suppression.ts";
import { applyBooked, dealFor, withdrawBooked } from "./booked.ts";
import { displayName, loadContactBrief, renderPrepBrief, when } from "./brief.ts";
import { CONVERT_DRAFT_KINDS, createConvertDraft, withdrawConvertDrafts, type ConvertDraftResult } from "./drafts.ts";
import { CONVERT_FLAGS, CONVERT_LIMITS } from "./flags.ts";

export type ConvertCommand =
  | { kind: "held" | "noshow" | "unlink"; code: string }
  | { kind: "notes"; code: string; notes: string }
  | { kind: "link"; code: string; contact: string }
  | { kind: "prep"; contact: string }
  | { kind: "list" };

const CODE = "(mg[0-9a-f]{10})";
const SIMPLE = new RegExp(`^/?meeting-(held|noshow|unlink)-${CODE}$`, "i");
const NOTES = new RegExp(`^/?meeting-notes-${CODE}\\s+([\\s\\S]+)$`, "i");
const LINK = new RegExp(`^/?meeting-link-${CODE}\\s+(\\S{2,254})$`, "i");
const PREP = /^\/?prep-(\S{2,254})$/i;
const LIST = /^\/meetings(?:@[A-Za-z0-9_]{1,64})?$/i;

export const CONVERT_HELP_LINES: readonly string[] = Object.freeze([
  "/meetings  upcoming meetings, and bookings not linked to a contact",
  "meeting-held-<code> / meeting-noshow-<code>  say whether a meeting took place (drafts the recap or a rebook)",
  "meeting-notes-<code> <notes>  keep your notes on a meeting",
  "meeting-link-<code> <contact id or email> / meeting-unlink-<code>  tie a booking to a contact, or make it inert",
  "prep-<contact id or email>  a one-page prep brief on any contact",
]);

/** A meeting command in a message, or null. */
export function parseConvertCommand(text: string): ConvertCommand | null {
  const trimmed = text.trim();
  if (LIST.test(trimmed)) return { kind: "list" };
  const simple = SIMPLE.exec(trimmed);
  if (simple) return { kind: (simple[1] ?? "").toLowerCase() as "held" | "noshow" | "unlink", code: (simple[2] ?? "").toLowerCase() };
  const notes = NOTES.exec(trimmed);
  if (notes) {
    const body = (notes[2] ?? "").trim();
    return body.length > 0 && body.length <= CONVERT_LIMITS.noteMaxChars ? { kind: "notes", code: (notes[1] ?? "").toLowerCase(), notes: body } : null;
  }
  const link = LINK.exec(trimmed);
  if (link) return { kind: "link", code: (link[1] ?? "").toLowerCase(), contact: link[2] ?? "" };
  const prep = PREP.exec(trimmed);
  if (prep) return { kind: "prep", contact: prep[1] ?? "" };
  return null;
}

export interface ConvertCommandDeps {
  db: D1Database;
  flags: FlagReader;
  config: GtmConfig;
  operator?: OperatorChannel | undefined;
  /** Where approval requests record what was shown (the KV namespace). */
  shown?: ShownStore | undefined;
  /** The chat the command came from: approval requests go there. */
  chatId?: string | undefined;
  userId: string;
  now?: () => Date;
  log?: JobLogger;
}

const silent: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface ContactRow {
  id: string;
  email: string;
  email_sha256: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  timezone: string | null;
  account_key: string | null;
}

const CONTACT_COLUMNS = "id, email, email_sha256, first_name, last_name, job_title, timezone, account_key";

/** A contact by exact id or by address (any +tag). Throws on a database error. */
export async function resolveContact(db: D1Database, ref: string): Promise<ContactRow | null> {
  if (ref.includes("@")) {
    const email = normalizeAddress(ref);
    if (!email) return null;
    const exact = await addressHash(email);
    const mailbox = await addressHash(mailboxOf(email));
    return db
      .prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 ORDER BY (email_sha256 = ?1) DESC, id LIMIT 1`)
      .bind(exact, mailbox)
      .first<ContactRow>();
  }
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(ref)) return null;
  return db.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ?1`).bind(ref).first<ContactRow>();
}

interface CodeRow {
  event_id: string;
  code: string;
  status: string;
  starts_at: string;
  ends_at: string;
  state: string;
  first_seen_at: string;
  attendee_hashes: string;
  attendee_domains: string;
  m_contact: string | null;
  m_status: string | null;
  m_attribution: string | null;
  m_outcome: string | null;
  m_first_seen: string | null;
}

async function byCode(db: D1Database, code: string): Promise<CodeRow | null> {
  return db
    .prepare(
      `SELECT ce.event_id, ce.code, ce.status, ce.starts_at, ce.ends_at, ce.state, ce.first_seen_at, ce.attendee_hashes, ce.attendee_domains,
              cm.contact_id AS m_contact, cm.status AS m_status, cm.attribution AS m_attribution, cm.outcome AS m_outcome, cm.first_seen_at AS m_first_seen
         FROM calendar_events ce LEFT JOIN calendar_meetings cm ON cm.event_id = ce.event_id
        WHERE ce.code = ?1`,
    )
    .bind(code)
    .first<CodeRow>();
}

function draftLine(result: ConvertDraftResult, what: string): string {
  switch (result.status) {
    case "created":
      return result.approvalRequested ? `A ${what} draft is waiting for your approval. Nothing is sent.` : `A ${what} draft was saved (${result.draftId}); its approval request could not be shown.`;
    case "exists":
      return `The ${what} draft already exists${result.draftId ? ` (${result.draftId})` : ""}.`;
    case "suppressed":
      return `Their address is suppressed, so no ${what} draft was written.`;
    case "failed":
      return `The ${what} draft could not be written (${result.reason}).`;
  }
}

function parseJsonList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function listMeetings(deps: ConvertCommandDeps, now: Date): Promise<string> {
  const { db } = deps;
  const [{ results: upcoming }, { results: unlinked }] = await Promise.all([
    db
      .prepare(
        `SELECT ce.code, cm.starts_at, cm.outcome, cm.attribution, c.id, c.email, c.first_name, c.last_name
           FROM calendar_meetings cm JOIN calendar_events ce ON ce.event_id = cm.event_id AND ce.state = 'attributed' JOIN contacts c ON c.id = cm.contact_id
          WHERE cm.status <> 'cancelled' AND cm.ends_at >= ?1
          ORDER BY cm.starts_at ASC LIMIT ?2`,
      )
      .bind(new Date(now.getTime() - 86_400_000).toISOString(), CONVERT_LIMITS.listed)
      .all<{ code: string; starts_at: string; outcome: string | null; attribution: string | null; id: string; email: string; first_name: string | null; last_name: string | null }>(),
    db
      .prepare(
        `SELECT code, starts_at, state, attendee_domains FROM calendar_events
          WHERE state IN ('ambiguous', 'unmatched') AND status <> 'cancelled' AND ends_at >= ?1
          ORDER BY starts_at ASC LIMIT ?2`,
      )
      .bind(now.toISOString(), CONVERT_LIMITS.listed)
      .all<{ code: string; starts_at: string; state: string; attendee_domains: string }>(),
  ]);
  const lines = ["Meetings:"];
  if (upcoming.length === 0) lines.push("  none in the next 60 days");
  for (const m of upcoming) {
    const note = m.outcome ? ` (${label(m.outcome, 12)})` : m.attribution === "domain_contacted" ? " (matched by company domain: check it)" : "";
    lines.push(`  ${when(m.starts_at)} [${m.code}] ${displayName(m)} <${m.email}>${note}`);
  }
  if (unlinked.length > 0) {
    lines.push("Bookings not linked to a contact (meeting-link-<code> <contact id or email>):");
    for (const u of unlinked) lines.push(`  ${when(u.starts_at)} [${u.code}] ${u.state}, attendees at ${parseJsonList(u.attendee_domains).map((d) => label(d, 60)).join(", ") || "(unknown)"}`);
  }
  return lines.join("\n");
}

/** Run a meeting command and return the reply text. Throws on a database error; the caller reports it. */
export async function runConvertCommand(deps: ConvertCommandDeps, command: ConvertCommand): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? silent;
  const { db } = deps;

  if (command.kind === "list") return listMeetings(deps, now);
  if (command.kind === "prep") {
    const contact = await resolveContact(db, command.contact);
    if (!contact) return `No contact matches ${label(command.contact, 80)}.`;
    const brief = await loadContactBrief(db, contact.id);
    if (!brief) return `No contact matches ${label(command.contact, 80)}.`;
    const next = await db
      .prepare(
        `SELECT ce.code, cm.starts_at, cm.ends_at, cm.attribution FROM calendar_meetings cm JOIN calendar_events ce ON ce.event_id = cm.event_id
          WHERE cm.contact_id = ?1 AND cm.status <> 'cancelled' AND cm.ends_at >= ?2 ORDER BY cm.starts_at ASC LIMIT 1`,
      )
      .bind(contact.id, now.toISOString())
      .first<{ code: string; starts_at: string; ends_at: string; attribution: string | null }>();
    return renderPrepBrief(brief, next, now);
  }

  if (!(await readOn(deps.flags, CONVERT_FLAGS.calendar))) return `Calendar sync is off (${CONVERT_FLAGS.calendar}), so meeting commands do nothing. Nothing was changed.`;
  const row = await byCode(db, command.code);
  if (!row) return `There is no booking ${command.code}. /meetings lists them.`;
  const draftDeps = { db, config: deps.config, operator: deps.operator, shown: deps.shown, chatId: deps.chatId, now, log };

  if (command.kind === "link") {
    if (row.state === "attributed" && row.m_contact) return `Meeting ${row.code} is already linked to ${row.m_contact}. Send meeting-unlink-${row.code} first to change it.`;
    if (row.status === "cancelled") return `Meeting ${row.code} was cancelled, so it was not linked.`;
    const contact = await resolveContact(db, command.contact);
    if (!contact) return `No contact matches ${label(command.contact, 80)}. Nothing was linked.`;
    const at = now.toISOString();
    const firstSeen = row.first_seen_at;
    await db.batch([
      db
        .prepare(
          `INSERT INTO calendar_meetings (event_id, contact_id, starts_at, ends_at, status, attribution, first_seen_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'operator_link', ?6, ?7, ?7)
           ON CONFLICT (event_id) DO UPDATE SET contact_id = excluded.contact_id, attribution = excluded.attribution, status = excluded.status,
             starts_at = excluded.starts_at, ends_at = excluded.ends_at, first_seen_at = excluded.first_seen_at, updated_at = excluded.updated_at`,
        )
        .bind(row.event_id, contact.id, row.starts_at, row.ends_at, row.status, firstSeen, at),
      db.prepare("UPDATE calendar_events SET state = 'attributed', updated_at = ?2 WHERE event_id = ?1").bind(row.event_id, at),
    ]);
    const applied = await applyBooked(
      { db, config: deps.config, operator: deps.operator, chatId: deps.chatId, now, log, quiet: true },
      { event_id: row.event_id, code: row.code, contact_id: contact.id, starts_at: row.starts_at, ends_at: row.ends_at, status: row.status, attribution: "operator_link", first_seen_at: firstSeen },
    );
    const onInvite = parseJsonList(row.attendee_hashes).includes(contact.email_sha256) || (contact.account_key !== null && parseJsonList(row.attendee_domains).some((d) => d === contact.account_key || d.endsWith(`.${contact.account_key}`)));
    let brief = applied.brief;
    if (!brief) {
      const data = await loadContactBrief(db, contact.id);
      brief = data ? renderPrepBrief(data, { code: row.code, starts_at: row.starts_at, ends_at: row.ends_at, attribution: "operator_link" }, now) : null;
    }
    return [
      `Linked meeting ${row.code} (${when(row.starts_at)}) to ${displayName(contact)}.${onInvite ? "" : " Note: they are not on the invite by address or company domain."}`,
      applied.failed.length > 0 ? `Some steps did not finish (${applied.failed.join(", ")}); calendar sync retries them.` : "Cold outreach and follow-ups to them and their account are stopped.",
      ...(brief ? ["", brief] : []),
    ].join("\n");
  }

  if (command.kind === "unlink") {
    if (row.state === "inert") return `Meeting ${row.code} is already inert.`;
    const at = now.toISOString();
    await db.batch([
      db.prepare("UPDATE calendar_events SET state = 'inert', updated_at = ?2 WHERE event_id = ?1").bind(row.event_id, at),
      db.prepare("DELETE FROM calendar_meetings WHERE event_id = ?1").bind(row.event_id),
    ]);
    if (row.m_contact && row.m_first_seen) await withdrawBooked({ db, log, now }, { event_id: row.event_id, code: row.code, contact_id: row.m_contact, first_seen_at: row.m_first_seen });
    const withdrawn = await withdrawConvertDrafts(db, row.code, CONVERT_DRAFT_KINDS, now);
    return [
      `Meeting ${row.code} is inert: it no longer counts as a meeting, and no reminders, questions or drafts follow.${withdrawn > 0 ? ` ${withdrawn} open draft${withdrawn === 1 ? " was" : "s were"} withdrawn.` : ""}`,
      "Warmth, the deal stage and stopped follow-up sequences only move forward, so they were left as they are.",
    ].join("\n");
  }

  // held, noshow and notes need a linked meeting.
  if (row.state !== "attributed" || !row.m_contact) return `Meeting ${row.code} is not linked to a contact. Link it first with meeting-link-${row.code} <contact id or email>.`;
  if (row.m_status === "cancelled") return `Meeting ${row.code} was cancelled.`;
  const contact = await db.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ?1`).bind(row.m_contact).first<ContactRow>();
  if (!contact) return `The contact for meeting ${row.code} no longer exists.`;
  const at = now.toISOString();

  if (command.kind === "notes") {
    const text = `${at.slice(0, 10)}: ${command.notes.replace(/\p{Cc}/gu, (c) => (c === "\n" ? c : " ")).trim()}`;
    const deal = await dealFor(db, contact.id, contact.account_key);
    const minutes = Math.max(0, Math.round((Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 60_000));
    await db
      .prepare(
        `INSERT INTO meetings (id, external_id, deal_id, contact_id, occurred_at, duration_minutes, summary, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (external_id) DO UPDATE SET summary = substr(COALESCE(meetings.summary || char(10) || char(10), '') || excluded.summary, -${CONVERT_LIMITS.notesMaxChars})`,
      )
      .bind(`mt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, `calendar:${row.code}:${contact.id}`, deal?.id ?? null, contact.id, row.starts_at, minutes, text, at)
      .run();
    return `Notes saved on meeting ${row.code} with ${displayName(contact)}. They appear in later briefs about them, and only there.`;
  }

  if (Date.parse(row.ends_at) > now.getTime()) return `Meeting ${row.code} has not ended yet (${when(row.ends_at)}). Answer after it ends.`;
  const deal = await dealFor(db, contact.id, contact.account_key);
  const input = { code: row.code, contact, dealId: deal?.id ?? null, meetingStart: row.starts_at, attribution: row.m_attribution };

  if (command.kind === "held") {
    if (row.m_outcome === "held") return `Meeting ${row.code} is already marked held.`;
    await db
      .prepare(
        `UPDATE calendar_meetings SET outcome = 'held', outcome_at = ?2, held_asked_at = COALESCE(held_asked_at, ?2), sequence_stopped = 0,
           sequence_step = MAX(COALESCE(sequence_step, 0), 1), updated_at = ?2
          WHERE event_id = ?1`,
      )
      .bind(row.event_id, at)
      .run();
    await withdrawConvertDrafts(db, row.code, ["rebook"], now);
    const draft = await createConvertDraft(draftDeps, { ...input, kind: "recap" });
    const postDemo = await readOn(deps.flags, CONVERT_FLAGS.postDemo);
    return [
      `Marked meeting ${row.code} with ${displayName(contact)} as held.`,
      draftLine(draft, "recap"),
      postDemo ? "Once you approve the recap, follow-ups are drafted for approval on day 4 and day 10, unless they write back first." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // noshow
  if (row.m_outcome === "no_show") return `Meeting ${row.code} is already marked a no-show.`;
  await db
    .prepare("UPDATE calendar_meetings SET outcome = 'no_show', outcome_at = ?2, held_asked_at = COALESCE(held_asked_at, ?2), sequence_stopped = 1, sequence_next_at = NULL, updated_at = ?2 WHERE event_id = ?1")
    .bind(row.event_id, at)
    .run();
  const withdrawn = await withdrawConvertDrafts(db, row.code, ["recap", "step2", "step3"], now);
  const draft = await createConvertDraft(draftDeps, { ...input, kind: "rebook", reason: "no_show" });
  return [`Marked meeting ${row.code} with ${displayName(contact)} as a no-show.${withdrawn > 0 ? " The recap was withdrawn." : ""}`, draftLine(draft, "rebook")].join("\n");
}
