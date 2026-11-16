// GTM-agents: the CRM mirror (docs/CRM.md). One run copies what changed into a CrmSink.
//
// Five streams, in this order, each read after its own cursor (crm_sync_state):
//   contacts     contacts.updated_at: a new contact, or a change to its name, title, account or warmth
//   sends        outreach_sends.created_at: an email we sent
//   replies      inbound_emails.updated_at: a reply from a contact once triage gave it an intent
//   meetings     calendar_meetings.updated_at: a meeting booked (or moved), and a meeting held
//   deal_stages  deal_stage_history.created_at: a deal moving stage
// A stream reads only rows changed at least CRM_SETTLE_MS ago. Some jobs stamp a row with the time
// they started and write it minutes later, so the lag is longer than any job may run
// (MAX_JOB_DURATION_MS): a row committed late is never behind the cursor already. The contacts
// stream may use at most half of a run's rows, so a burst of contact changes cannot hold up activity.
//
// What leaves this deployment is fixed. A contact's address, name, title and account (name and
// domain); and for activity, only a summary this file writes from enumerated values and our own
// subject lines: "Cold email sent: <our subject>", "Reply received: interested", "Meeting booked for
// <time>", "Deal moved to proposal". No inbound text is ever read here (no body, preview, subject or
// sender name), and a reply we sent is summarized without its subject, which can repeat theirs.
//
// Before anything is written for a contact, the contact (and its account) is linked: upserted once,
// and again only when the fields written change (crm_links.digest). A contact that is suppressed or
// opted out is not written again; if it was already mirrored, one note says it opted out of email
// (a bounce or a manual block says nothing). An erased person has no contact row left, so nothing
// of theirs is written (erasure.ts tells the operator which CRM record to delete). A person erased
// while their record is being written is caught too: the link is recorded only while the contact
// row exists, and otherwise the record goes to crm_erasures with the same notice.
//
// Every activity is written inside runOnce, keyed by sink, stream and row, so a rerun does not write
// it again (a write that times out after the CRM stored it can, rarely, be repeated once). The cursor moves only past rows that finished. A sink error stops the run with the
// cursors where they are; the next run picks up from there. The suppression check fails closed: an
// error stops the run.
import { runOnce } from "../events/effects.ts";
import type { CrmSink } from "../ports/business.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { MAX_JOB_DURATION_MS } from "../jobs/registry.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { sha256Hex } from "../shared/hash.ts";

export const CRM_STREAMS = ["contacts", "sends", "replies", "meetings", "deal_stages"] as const;
export type CrmStream = (typeof CRM_STREAMS)[number];

/** Rows changed more recently than this are left for a later run: longer than any job may run. */
export const CRM_SETTLE_MS = MAX_JOB_DURATION_MS + 60_000;
/** The effect name every mirrored write is claimed under in the effects ledger. */
export const CRM_EFFECT = "crm_mirror";
/** Our own subject lines are cut to this many characters in a summary. */
const SUBJECT_MAX = 150;

/** What a reply's intent reads as in the CRM. An intent not listed here is not mirrored. */
export const REPLY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  interested: "interested",
  question: "question",
  referral: "referral",
  warm: "warm",
  objection: "objection",
  not_a_fit: "not a fit",
  unclear: "unclear",
});

const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  prospecting: "prospecting",
  contacted: "contacted",
  engaged: "engaged",
  demo_scheduled: "demo scheduled",
  trial: "trial",
  proposal: "proposal",
  negotiation: "negotiation",
  closed_won: "closed won",
  closed_lost: "closed lost",
});

/** Suppression reasons that mean the person asked not to be emailed. */
const OPT_OUT_REASONS = new Set(["opt_out", "complaint", "do_not_contact"]);

export interface CrmMirrorDeps {
  db: D1Database;
  sink: CrmSink;
  now: Date;
  /** Rows this run may handle across every stream. */
  perRun: number;
  signal?: AbortSignal;
  log?: { warn(msg: string, data?: Record<string, unknown>): void };
}

export interface CrmMirrorResult {
  rows: number;
  contacts: number;
  activities: number;
  optOutNotes: number;
  /** Set when a sink error stopped the run, sanitized. */
  error?: string;
}

interface Cursor {
  at: string;
  id: string;
}

type Activity = { key: string; type: "email_sent" | "reply" | "meeting" | "note"; at: string; summary: string };

interface StreamRow {
  cursor_at: string;
  cursor_id: string;
  contact_id: string | null;
  [column: string]: unknown;
}

interface StreamDef {
  /** SELECT ... FROM ... with a WHERE clause the cursor condition is ANDed onto. */
  select: string;
  /** The change-time and id expressions the cursor orders by. */
  at: string;
  id: string;
  activities(row: StreamRow): Activity[];
}

/** A single line of our own text, without control characters, at most `max` characters. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/** "2026-11-20 15:00 UTC", or "" for a value that is not a time. */
function utcTime(value: unknown): string {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) return "";
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A stored time column, or the row's change time when it is empty. */
const timeOr = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);

function sendSummary(row: StreamRow): string {
  const subject = oneLine(row.subject, SUBJECT_MAX);
  const withSubject = (lead: string) => (subject ? `${lead}: ${subject}` : lead);
  switch (row.send_path) {
    case "cold":
      return withSubject("Cold email sent");
    case "sequence":
      return withSubject(typeof row.sequence_step === "number" ? `Follow-up ${row.sequence_step} sent` : "Follow-up sent");
    case "lifecycle":
      return withSubject("Email sent");
    default:
      // A reply's subject can repeat the inbound subject, which is not ours: it is never mirrored.
      return "Reply sent";
  }
}

const STREAMS: Readonly<Record<CrmStream, StreamDef>> = Object.freeze({
  contacts: {
    select: "SELECT updated_at AS cursor_at, id AS cursor_id, id AS contact_id FROM contacts WHERE 1 = 1",
    at: "updated_at",
    id: "id",
    activities: () => [],
  },
  sends: {
    select: "SELECT created_at AS cursor_at, id AS cursor_id, contact_id, send_path, subject, sequence_step, sent_at FROM outreach_sends WHERE contact_id IS NOT NULL",
    at: "created_at",
    id: "id",
    activities: (row) => [{ key: String(row.cursor_id), type: "email_sent", at: timeOr(row.sent_at, row.cursor_at), summary: sendSummary(row) }],
  },
  replies: {
    select: "SELECT updated_at AS cursor_at, id AS cursor_id, contact_id, intent, received_at FROM inbound_emails WHERE contact_id IS NOT NULL AND intent IS NOT NULL",
    at: "updated_at",
    id: "id",
    activities: (row) => {
      const label = typeof row.intent === "string" && Object.hasOwn(REPLY_LABELS, row.intent) ? REPLY_LABELS[row.intent] : undefined;
      return label ? [{ key: String(row.cursor_id), type: "reply", at: timeOr(row.received_at, row.cursor_at), summary: `Reply received: ${label}` }] : [];
    },
  },
  meetings: {
    select: "SELECT updated_at AS cursor_at, event_id AS cursor_id, contact_id, starts_at, status, outcome, outcome_at FROM calendar_meetings WHERE 1 = 1",
    at: "updated_at",
    id: "event_id",
    activities: (row) => {
      const out: Activity[] = [];
      const when = utcTime(row.starts_at);
      if ((row.status === "confirmed" || row.status === "tentative") && when) {
        out.push({ key: `${String(row.cursor_id)}:booked:${String(row.starts_at)}`, type: "meeting", at: String(row.cursor_at), summary: `Meeting booked for ${when}` });
      }
      if (row.outcome === "held" && when) {
        out.push({ key: `${String(row.cursor_id)}:held`, type: "meeting", at: timeOr(row.outcome_at, row.cursor_at), summary: `Meeting held on ${when.slice(0, 10)}` });
      }
      return out;
    },
  },
  deal_stages: {
    select: "SELECT h.created_at AS cursor_at, h.id AS cursor_id, d.contact_id AS contact_id, h.to_stage AS to_stage FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id WHERE d.contact_id IS NOT NULL",
    at: "h.created_at",
    id: "h.id",
    activities: (row) => {
      const stage = typeof row.to_stage === "string" ? STAGE_LABELS[row.to_stage] : undefined;
      return stage ? [{ key: String(row.cursor_id), type: "note", at: String(row.cursor_at), summary: `Deal moved to ${stage}` }] : [];
    },
  },
});

async function readCursor(db: D1Database, sink: string, stream: CrmStream): Promise<Cursor> {
  const row = await db.prepare("SELECT cursor_at, cursor_id FROM crm_sync_state WHERE sink = ?1 AND stream = ?2").bind(sink, stream).first<{ cursor_at: string; cursor_id: string }>();
  return row ? { at: row.cursor_at, id: row.cursor_id } : { at: "", id: "" };
}

/** Bookkeeping: a cursor that cannot be saved means the next run repeats rows, which runOnce makes harmless. */
async function saveCursor(deps: CrmMirrorDeps, stream: CrmStream, cursor: Cursor): Promise<void> {
  if (cursor.at === "") return;
  try {
    const at = deps.now.toISOString();
    await deps.db
      .prepare(
        `INSERT INTO crm_sync_state (sink, stream, cursor_at, cursor_id, updated_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (sink, stream) DO UPDATE SET cursor_at = excluded.cursor_at, cursor_id = excluded.cursor_id, updated_at = excluded.updated_at`,
      )
      .bind(deps.sink.name, stream, cursor.at, cursor.id, at)
      .run();
  } catch (error) {
    deps.log?.warn("the CRM mirror's cursor could not be saved; the next run repeats those rows", { stream, error: sanitizeErrorMessage(error) });
  }
}

interface Link {
  external_id: string;
  digest: string;
}

async function readLink(db: D1Database, sink: string, kind: "account" | "contact", id: string): Promise<Link | null> {
  return db.prepare("SELECT external_id, digest FROM crm_links WHERE sink = ?1 AND local_kind = ?2 AND local_id = ?3").bind(sink, kind, id).first<Link>();
}

async function writeLink(deps: CrmMirrorDeps, kind: "account" | "contact", id: string, externalId: string, digest: string): Promise<void> {
  const at = deps.now.toISOString();
  // A contact link is recorded only while the contact exists, so a person erased while their record
  // was being written never keeps a link erasure did not see.
  const exists = kind === "contact" ? "EXISTS (SELECT 1 FROM contacts WHERE id = ?3)" : "1 = 1";
  const result = await deps.db
    .prepare(
      `INSERT INTO crm_links (sink, local_kind, local_id, external_id, digest, synced_at, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 WHERE ${exists}
       ON CONFLICT (sink, local_kind, local_id) DO UPDATE SET external_id = excluded.external_id, digest = excluded.digest, synced_at = excluded.synced_at`,
    )
    .bind(deps.sink.name, kind, id, externalId, digest, at)
    .run();
  if (kind === "contact" && (result.meta.changes ?? 0) === 0) await recordErased(deps, externalId);
}

/** The person was erased while their record was written: keep the record id and tell the operator, as erasure does. */
async function recordErased(deps: CrmMirrorDeps, externalId: string): Promise<void> {
  const at = deps.now.toISOString();
  await deps.db.batch([
    deps.db.prepare("INSERT OR IGNORE INTO crm_erasures (sink, external_id, erased_at, created_at) VALUES (?1, ?2, ?3, ?3)").bind(deps.sink.name, externalId, at),
    deps.db
      .prepare(
        `INSERT INTO operator_outbox (id, kind, text, silent, status, release_at, attempts, created_at, updated_at)
         VALUES ('ob_' || lower(hex(randomblob(8))), 'notice', ${ERASED_NOTICE_SQL}, 0, 'held', ?3, 0, ?3, ?3)`,
      )
      .bind(deps.sink.name, externalId, at),
  ]);
  deps.log?.warn("a person was erased while the CRM mirror wrote their record; the operator is told to delete it", { sink: deps.sink.name });
}

/** The operator notice for an erased person's CRM record, as SQL over ?1 (the sink) and ?2 (the record id). */
const ERASED_NOTICE_SQL =
  "'A person mirrored to the CRM (' || ?1 || ') was erased here. Their CRM record ' || ?2 || ' still holds their data: delete it in the CRM yourself. The mirror will not write to it again.'";

/** A sink call failed: the run stops and the cursors stay where they are. */
class SinkFailure extends Error {}

async function sinkCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new SinkFailure(sanitizeErrorMessage(error), { cause: error });
  }
}

interface ContactRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  account_key: string | null;
  warmth: string;
}

type Linked = { state: "linked"; externalId: string } | { state: "skip" };

/**
 * Link a contact (and its account) before anything is written about it. Returns skip for a contact
 * that is gone, suppressed or opted out; an opted-out contact that was already mirrored gets one note.
 */
async function linkContact(deps: CrmMirrorDeps, contactId: string, tally: CrmMirrorResult): Promise<Linked> {
  const { db, sink } = deps;
  const c = await db
    .prepare("SELECT id, email, first_name, last_name, job_title, account_key, warmth FROM contacts WHERE id = ?1")
    .bind(contactId)
    .first<ContactRow>();
  if (!c) return { state: "skip" };
  const suppression = await checkSuppression(db, [c.email]);
  if (suppression.blocked.some((b) => b.reason === "check_failed")) throw new Error("the suppression list could not be read; the CRM mirror stopped");
  const blocked = suppression.blocked[0]?.reason;
  if (c.warmth === "opted_out" || blocked !== undefined) {
    const optedOut = c.warmth === "opted_out" || (blocked !== undefined && OPT_OUT_REASONS.has(blocked));
    const link = await readLink(db, sink.name, "contact", c.id);
    if (optedOut && link) {
      const day = deps.now.toISOString().slice(0, 10);
      const wrote = await runOnce(db, `crm:${sink.name}:opt_out:${c.id}`, CRM_EFFECT, () =>
        sinkCall(() => sink.logActivity({ contactId: link.external_id, type: "note", at: deps.now.toISOString(), summary: `Opted out of email on ${day}` })),
      );
      if (wrote.ran) tally.optOutNotes += 1;
    }
    return { state: "skip" };
  }

  let accountExternalId: string | undefined;
  if (c.account_key) {
    const account = await db.prepare("SELECT name, domain FROM accounts WHERE account_key = ?1").bind(c.account_key).first<{ name: string; domain: string | null }>();
    const name = oneLine(account?.name, 200) || c.account_key;
    const domain = oneLine(account?.domain, 253) || c.account_key;
    const digest = await sha256Hex(JSON.stringify(["account", name, domain]));
    const link = await readLink(db, sink.name, "account", c.account_key);
    if (link && link.digest === digest) {
      accountExternalId = link.external_id;
    } else {
      const key = c.account_key;
      const { externalId } = await sinkCall(() => sink.upsertAccount({ key, name, domain, attributes: {} }));
      await writeLink(deps, "account", key, externalId, digest);
      accountExternalId = externalId;
    }
  }

  const fields = {
    id: c.id,
    email: c.email,
    ...(c.first_name ? { firstName: oneLine(c.first_name, 100) } : {}),
    ...(c.last_name ? { lastName: oneLine(c.last_name, 100) } : {}),
    ...(c.job_title ? { title: oneLine(c.job_title, 200) } : {}),
    ...(c.account_key ? { accountKey: c.account_key } : {}),
    ...(accountExternalId ? { accountExternalId } : {}),
    warmth: c.warmth,
    attributes: {},
  };
  const digest = await sha256Hex(JSON.stringify(["contact", fields]));
  const link = await readLink(db, sink.name, "contact", c.id);
  if (link && link.digest === digest) return { state: "linked", externalId: link.external_id };
  const { externalId } = await sinkCall(() => sink.upsertContact(fields));
  await writeLink(deps, "contact", c.id, externalId, digest);
  tally.contacts += 1;
  return { state: "linked", externalId };
}

/** Run the mirror once. Throws on a database error; a sink error is returned as `error`. */
export async function runCrmMirror(deps: CrmMirrorDeps): Promise<CrmMirrorResult> {
  const tally: CrmMirrorResult = { rows: 0, contacts: 0, activities: 0, optOutNotes: 0 };
  const until = new Date(deps.now.getTime() - CRM_SETTLE_MS).toISOString();
  const sink = deps.sink.name;
  for (const stream of CRM_STREAMS) {
    const room = Math.min(deps.perRun - tally.rows, stream === "contacts" ? Math.ceil(deps.perRun / 2) : deps.perRun);
    if (room <= 0 || deps.signal?.aborted) break;
    const def = STREAMS[stream];
    let cursor = await readCursor(deps.db, sink, stream);
    const { results } = await deps.db
      .prepare(`${def.select} AND (${def.at} > ?1 OR (${def.at} = ?1 AND ${def.id} > ?2)) AND ${def.at} <= ?3 ORDER BY ${def.at}, ${def.id} LIMIT ?4`)
      .bind(cursor.at, cursor.id, until, room)
      .all<StreamRow>();
    try {
      for (const row of results ?? []) {
        if (deps.signal?.aborted) break;
        if (row.contact_id) {
          const linked = await linkContact(deps, row.contact_id, tally);
          if (linked.state === "linked") {
            for (const activity of def.activities(row)) {
              const wrote = await runOnce(deps.db, `crm:${sink}:${stream}:${activity.key}`, CRM_EFFECT, () =>
                sinkCall(() => deps.sink.logActivity({ contactId: linked.externalId, type: activity.type, at: activity.at, summary: activity.summary })),
              );
              if (wrote.ran) tally.activities += 1;
            }
          }
        }
        cursor = { at: row.cursor_at, id: row.cursor_id };
        tally.rows += 1;
      }
    } catch (error) {
      await saveCursor(deps, stream, cursor);
      if (error instanceof SinkFailure) return { ...tally, error: `${stream}: ${error.message}` };
      throw error;
    }
    await saveCursor(deps, stream, cursor);
  }
  return tally;
}
