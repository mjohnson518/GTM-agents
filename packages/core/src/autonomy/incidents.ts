// GTM-agents: incidents and immediate demotion.
//
// Autonomy is earned from evidence, so harm after an automatic action takes it back at once, not at
// the weekly review. Three kinds of harm count:
//   hard_bounce   a hard bounce (the provider webhook, a delivery report in the inbox)
//   complaint     a spam complaint (the provider webhook)
//   unsubscribe   the unsubscribe link, a provider's unsubscribe event, an unsubscribe reply, a
//                 triaged opt-out
// A polite decline is never one: it is not an opt-out, so nothing here sees it.
//
// Who it counts against: every class that sent to the contact automatically in the
// INCIDENT_WINDOW_DAYS before the harm, read from the send ledger (outreach_sends) and the drafts
// those sends came from (approved_by auto:...). The cold batch, and the follow-ups that share its
// class, is a volume class: one bounce in a batch of hundreds is normal, so per contact only a
// complaint counts against it, and bounces and opt-outs count through the hourly rate check
// (checkColdBatchRates), over RATE_CHECK.windowDays, with the one definition of each rate in
// packages/core/src/metrics/.
//
// What an incident does, in one D1 batch, so it all lands or none of it does:
//   1. an incident row in autonomy_events (evidence: it blocks promotion);
//   2. a demotion in autonomy_level_changes, to level 1 (or lower, never higher: the reader takes
//      the lower of the flag and the latest change), unless a demotion already stands;
//   3. drafts of the class that were approved automatically and are not sent yet go back to review,
//      so nothing queued under the old level goes out (the send function re-checks the approval);
//   4. the claim, autonomy_incident:<contact>:<kind>:<class>, so the same harm counts once.
// Tightening is always allowed, so no flag guards any of this and no person has to confirm it.
//
// A demotion that cannot be written is not lost: the batch is retried a few times; the hourly watch
// (jobs.ts) finds every hard bounce, complaint and opt-out of the last INCIDENT_WINDOW_DAYS again
// from the suppression list and records whatever is missing, then tells the operator; and while
// the database cannot be read, every level read caps at 1 (store.ts). Recording never throws into
// the opt-out that reported the harm.
import { readOn, OUTREACH_FLAGS } from "../outreach/flags.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { deliveryCounts, hardBounceRate, sinceWindow, trailingDays } from "../metrics/delivery-rates.ts";
import { optOutCounts, unsubscribeRate } from "../metrics/opt-outs.ts";
import { DAY_MS } from "../metrics/window.ts";
import { EARNABLE_ACTION_CLASSES, type ActionClass } from "./levels.ts";
import { readAutonomyLevel } from "./store.ts";

export type IncidentKind = "hard_bounce" | "complaint" | "unsubscribe";

/** Days after an automatic send during which harm to that contact counts against its class. */
export const INCIDENT_WINDOW_DAYS = 14;
/** Classes judged on rates over many sends, not one contact at a time. */
export const VOLUME_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>(["cold_batch"]);
/** The cold batch's rate check: the window, the smallest sample, and the limits. */
export const RATE_CHECK = Object.freeze({ windowDays: 14, minSends: 50, maxHardBounceRate: 0.02, maxUnsubscribeRate: 0.01 });

export const INCIDENT_EFFECT = "autonomy_incident";
export const DEMOTION_ACTOR = "system:autonomy";
const RECONCILED_EFFECT = "autonomy_reconcile";

/** The incident a suppression reason is. */
export function incidentKindFor(reason: "bounce" | "complaint" | "opt_out"): IncidentKind {
  return reason === "bounce" ? "hard_bounce" : reason === "complaint" ? "complaint" : "unsubscribe";
}

/** Whether one contact's harm of `kind` counts against `actionClass`. Pure. */
export function incidentCountsFor(actionClass: string, kind: IncidentKind): boolean {
  if (VOLUME_CLASSES.has(actionClass as ActionClass)) return kind === "complaint";
  return true;
}

const earnable: ReadonlySet<string> = new Set(EARNABLE_ACTION_CLASSES);
const REPLY_CLASSES: ReadonlySet<string> = new Set(["reply_send", "reply_demo_link", "reply_question"]);

/**
 * The class a sent message counts toward, from its send path and its draft's class. Cold and
 * sequence mail is the cold batch's; a reply is its draft's reply class (reply_send when unknown);
 * lifecycle mail is its draft's class, else lifecycle_activation. Null when nothing fits. Pure.
 */
export function classOfSend(path: string, draftClass: string | null): ActionClass | null {
  if (path === "cold" || path === "sequence") return "cold_batch";
  if (path === "reply") return draftClass && REPLY_CLASSES.has(draftClass) ? (draftClass as ActionClass) : "reply_send";
  if (draftClass && earnable.has(draftClass)) return draftClass as ActionClass;
  return path === "lifecycle" ? "lifecycle_activation" : null;
}

const COLD_DRAFT_KINDS = "('cold_intro', 'follow_up', 'breakup')";

/** The drafts filter for a class, its value bound at parameter `index`: the cold batch's kinds, or the draft's own class. */
function draftsOfClass(actionClass: ActionClass, index: number): { sql: string; bind: string[] } {
  return actionClass === "cold_batch" ? { sql: `kind IN ${COLD_DRAFT_KINDS}`, bind: [] } : { sql: `action_class = ?${index}`, bind: [actionClass] };
}

export interface IncidentWrite {
  actionClass: ActionClass;
  /** The claim that makes this incident count once. */
  onceKey: string;
  subjectId: string | null;
  /** The evidence row's detail and the demotion's reason. */
  detail: string;
  /** When the harm happened. */
  at: Date;
  now: Date;
}

/** The statements of one incident, all conditional on its claim, the claim last. */
export function incidentStatements(db: D1Database, w: IncidentWrite): D1PreparedStatement[] {
  const unclaimed = "NOT EXISTS (SELECT 1 FROM event_effects WHERE event_id = ?1 AND effect = ?2)";
  const at = w.at.toISOString();
  const now = w.now.toISOString();
  const detail = w.detail.slice(0, 300);
  const drafts = draftsOfClass(w.actionClass, 4);
  return [
    db
      .prepare(`INSERT INTO autonomy_events (id, action_class, outcome, subject_id, detail, created_at) SELECT ?3, ?4, 'incident', ?5, ?6, ?7 WHERE ${unclaimed}`)
      .bind(w.onceKey, INCIDENT_EFFECT, `ae_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, w.actionClass, w.subjectId, detail, at),
    db
      .prepare(
        `INSERT INTO autonomy_level_changes (action_class, from_level, to_level, source, actor, reason, created_at)
         SELECT ?3, NULL, MIN(1, COALESCE((SELECT to_level FROM autonomy_level_changes WHERE action_class = ?3 ORDER BY id DESC LIMIT 1), 1)), 'demotion', ?4, ?5, ?6
          WHERE ${unclaimed}
            AND COALESCE((SELECT source FROM autonomy_level_changes WHERE action_class = ?3 ORDER BY id DESC LIMIT 1), '') <> 'demotion'`,
      )
      .bind(w.onceKey, INCIDENT_EFFECT, w.actionClass, DEMOTION_ACTOR, detail, now),
    db
      .prepare(
        `UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?3
          WHERE status = 'approved' AND approved_by LIKE 'auto:%' AND ${drafts.sql} AND ${unclaimed}`,
      )
      .bind(w.onceKey, INCIDENT_EFFECT, now, ...drafts.bind),
    db.prepare("INSERT OR IGNORE INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(w.onceKey, INCIDENT_EFFECT, now),
  ];
}

/**
 * Return a class's automatically approved, unsent drafts to review, so nothing approved under a
 * level it no longer has goes out (the send function re-checks every approval). Returns how many.
 * Tightening, so it never throws: a failure is logged, and an incident's own batch does the same.
 */
export async function returnAutomaticApprovals(db: D1Database, actionClass: ActionClass, now: Date): Promise<number> {
  const drafts = draftsOfClass(actionClass, 2);
  try {
    const result = await db
      .prepare(
        `UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?1
          WHERE status = 'approved' AND approved_by LIKE 'auto:%' AND ${drafts.sql}`,
      )
      .bind(now.toISOString(), ...drafts.bind)
      .run();
    return result.meta.changes ?? 0;
  } catch {
    console.error(JSON.stringify({ level: "error", scope: "autonomy", msg: "automatically approved drafts could not be returned to review", actionClass }));
    return 0;
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Tries before giving up. */
  attempts?: number;
  /** Milliseconds before the second try; each later try waits four times longer. */
  pauseMs?: number;
}

/** Write one incident, retrying. "already" when its claim was taken before. Never throws. */
export async function writeIncident(db: D1Database, w: IncidentWrite, retry: RetryOptions = {}): Promise<"written" | "already" | "failed"> {
  const attempts = Math.max(1, retry.attempts ?? 3);
  let wait = retry.pauseMs ?? 25;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const claimed = await db.prepare("SELECT 1 AS hit FROM event_effects WHERE event_id = ?1 AND effect = ?2").bind(w.onceKey, INCIDENT_EFFECT).first();
      if (claimed) return "already";
      const results = await db.batch(incidentStatements(db, w));
      return (results.at(-1)?.meta.changes ?? 0) > 0 ? "written" : "already";
    } catch {
      if (attempt < attempts) {
        await pause(wait);
        wait *= 4;
      }
    }
  }
  return "failed";
}

interface AutoSendRow {
  contact_id: string;
  send_path: string;
  action_class: string | null;
}

/**
 * The classes that sent to these contacts automatically in the INCIDENT_WINDOW_DAYS up to `at`,
 * with the contacts each one reached. Throws on a database error.
 */
export async function autoSentClasses(db: D1Database, contactIds: readonly string[], at: Date): Promise<Map<ActionClass, Set<string>>> {
  const out = new Map<ActionClass, Set<string>>();
  const ids = [...new Set(contactIds.filter((id) => typeof id === "string" && id !== ""))].slice(0, 50);
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT os.contact_id, os.send_path, d.action_class
         FROM outreach_sends os JOIN drafts d ON d.id = os.draft_id
        WHERE os.contact_id IN (SELECT value FROM json_each(?1)) AND os.sent_at >= ?2 AND os.sent_at <= ?3 AND d.approved_by LIKE 'auto:%'`,
    )
    .bind(JSON.stringify(ids), new Date(at.getTime() - INCIDENT_WINDOW_DAYS * DAY_MS).toISOString(), at.toISOString())
    .all<AutoSendRow>();
  for (const r of results) {
    const actionClass = classOfSend(r.send_path, r.action_class);
    if (!actionClass) continue;
    const reached = out.get(actionClass) ?? new Set<string>();
    reached.add(r.contact_id);
    out.set(actionClass, reached);
  }
  return out;
}

export interface ContactIncident {
  contactIds: readonly string[];
  kind: IncidentKind;
  /** When the harm happened. */
  at: Date;
  /** Where it was reported, for the evidence row: "provider_webhook", "unsubscribe_link". */
  source: string;
  now?: Date;
}

export interface IncidentResult {
  /** Incidents written now. */
  recorded: Array<{ actionClass: ActionClass; contactId: string }>;
  /** True when a volume class reached the contact and the harm counts only through its rate check. */
  volumeTouched: boolean;
  /** True when something could not be read or written; the hourly watch records it later. */
  failed: boolean;
}

const incidentKey = (contactId: string, kind: IncidentKind, actionClass: ActionClass) => `autonomy_incident:${contactId}:${kind}:${actionClass}`;

/**
 * Record harm to these contacts against every class that sent to them automatically, and demote
 * those classes. Called from optOutAddress (sending/opt-out.ts), the one routine behind every hard
 * bounce, complaint and opt-out, and from the hourly watch. Never throws.
 */
export async function recordContactIncident(db: D1Database, incident: ContactIncident, retry: RetryOptions = {}): Promise<IncidentResult> {
  const result: IncidentResult = { recorded: [], volumeTouched: false, failed: false };
  if (incident.contactIds.length === 0) return result;
  let classes: Map<ActionClass, Set<string>> | null = null;
  const attempts = Math.max(1, retry.attempts ?? 3);
  let wait = retry.pauseMs ?? 25;
  for (let attempt = 1; attempt <= attempts && classes === null; attempt++) {
    try {
      classes = await autoSentClasses(db, incident.contactIds, incident.at);
    } catch {
      if (attempt < attempts) {
        await pause(wait);
        wait *= 4;
      }
    }
  }
  if (classes === null) {
    result.failed = true;
    logFailure("the classes that sent automatically could not be read; the hourly watch records this incident", incident);
    return result;
  }
  for (const [actionClass, contacts] of classes) {
    if (!incidentCountsFor(actionClass, incident.kind)) {
      result.volumeTouched = true;
      continue;
    }
    for (const contactId of contacts) {
      const outcome = await writeIncident(
        db,
        {
          actionClass,
          onceKey: incidentKey(contactId, incident.kind, actionClass),
          subjectId: contactId,
          detail: `${incident.kind.replace("_", " ")} after an automatic send (${incident.source})`,
          at: incident.at,
          now: incident.now ?? incident.at,
        },
        retry,
      );
      if (outcome === "written") result.recorded.push({ actionClass, contactId });
      else if (outcome === "failed") result.failed = true;
    }
  }
  if (result.failed) logFailure("an incident could not be written; the hourly watch records it", incident);
  return result;
}

function logFailure(msg: string, incident: ContactIncident): void {
  console.error(JSON.stringify({ level: "error", scope: "autonomy", msg, kind: incident.kind, contacts: incident.contactIds.length }));
}

interface SuppressedRow {
  email_sha256: string;
  contact_id: string;
  reason: "bounce" | "complaint" | "opt_out";
  at: string;
}

/**
 * The hourly safety net: every hard bounce, complaint and opt-out recorded in the suppression list
 * in the last INCIDENT_WINDOW_DAYS, for a contact some class sent to automatically before it, is
 * recorded as an incident if it is not already. Returns the incidents written now. Throws on a
 * database error reading the list.
 */
export async function reconcileIncidents(db: D1Database, now: Date, maxRows: number, retry: RetryOptions = {}): Promise<{ checked: number; recorded: Array<{ actionClass: ActionClass; contactId: string }>; failed: number }> {
  const since = new Date(now.getTime() - INCIDENT_WINDOW_DAYS * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.email_sha256 AS email_sha256, c.id AS contact_id, s.reason AS reason, s.created_at AS at
         FROM suppression s
         JOIN contacts c ON c.email_sha256 = s.email_sha256 OR c.mailbox_sha256 = s.email_sha256
        WHERE s.reason IN ('bounce', 'complaint', 'opt_out') AND s.created_at >= ?1
          AND EXISTS (SELECT 1 FROM outreach_sends os JOIN drafts d ON d.id = os.draft_id
                       WHERE os.contact_id = c.id AND os.sent_at <= s.created_at AND d.approved_by LIKE 'auto:%')
          AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'autonomy_reconciled:' || s.email_sha256 || ':' || c.id AND ee.effect = ?3)
        ORDER BY s.created_at DESC
        LIMIT ?2`,
    )
    .bind(since, maxRows, RECONCILED_EFFECT)
    .all<SuppressedRow>();
  const recorded: Array<{ actionClass: ActionClass; contactId: string }> = [];
  let failed = 0;
  for (const row of results) {
    const at = new Date(row.at);
    if (!Number.isFinite(at.getTime())) continue;
    const outcome = await recordContactIncident(db, { contactIds: [row.contact_id], kind: incidentKindFor(row.reason), at, source: "found by the hourly watch", now }, retry);
    recorded.push(...outcome.recorded);
    if (outcome.failed) failed += 1;
    else {
      // Handled: not read again, so newer rows are never starved by older ones.
      try {
        await db.prepare("INSERT OR IGNORE INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(`autonomy_reconciled:${row.email_sha256}:${row.contact_id}`, RECONCILED_EFFECT, now.toISOString()).run();
      } catch {
        // Bookkeeping: the row is read again next hour, and its incidents are claimed already.
      }
    }
  }
  return { checked: results.length, recorded, failed };
}

export interface RateCheckDeps {
  db: D1Database;
  flags: FlagReader;
  config?: Pick<GtmConfig, "autonomy">;
  now: Date;
  retry?: RetryOptions;
}

export interface ColdBatchRates {
  sends: number;
  hardBounceRate: number | null;
  unsubscribeRate: number | null;
}

/** Why the cold batch's rates breach the check, or null. Pure. */
export function coldBatchRateBreach(r: ColdBatchRates): string | null {
  if (r.sends < RATE_CHECK.minSends) return null;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (r.hardBounceRate !== null && r.hardBounceRate >= RATE_CHECK.maxHardBounceRate) return `hard bounce rate ${pct(r.hardBounceRate)} over ${r.sends} outreach sends in ${RATE_CHECK.windowDays} days`;
  if (r.unsubscribeRate !== null && r.unsubscribeRate >= RATE_CHECK.maxUnsubscribeRate) return `unsubscribe rate ${pct(r.unsubscribeRate)} over ${r.sends} outreach sends in ${RATE_CHECK.windowDays} days`;
  return null;
}

export type RateCheckResult =
  | { status: "not_automatic" | "already_demoted" }
  | { status: "ok" | "small_sample"; rates: ColdBatchRates }
  | { status: "demoted"; rates: ColdBatchRates; reason: string; written: boolean }
  | { status: "failed"; rates: ColdBatchRates; reason: string };

/**
 * The cold batch's rate check: while it sends on its own (its level is 2 or more, or the operator's
 * auto-approve switch is on), outreach over the last RATE_CHECK.windowDays with at least
 * RATE_CHECK.minSends sends and a hard bounce rate or an unsubscribe rate at or over its limit is
 * an incident and demotes it. A level that cannot be read is treated as sending on its own: the
 * check runs, and demoting is the safe direction. Throws when the rates cannot be read.
 */
export async function checkColdBatchRates(deps: RateCheckDeps): Promise<RateCheckResult> {
  const reading = await readAutonomyLevel({ flags: deps.flags, db: deps.db, ...(deps.config ? { config: deps.config } : {}) }, "cold_batch");
  if (reading.demoted && reading.error === null) return { status: "already_demoted" };
  const automatic = reading.error !== null || reading.level >= 2 || (await readOn(deps.flags, OUTREACH_FLAGS.autoApprove));
  if (!automatic) return { status: "not_automatic" };
  // The window starts no earlier than the operator's latest raise: sends from before a person
  // raised the class again were already judged, and must not demote it straight back. A lowering
  // does not restart it.
  const trailing = trailingDays(deps.now, RATE_CHECK.windowDays);
  const raised = reading.latest?.source === "operator" && (reading.latest.fromLevel === null || reading.latest.toLevel > reading.latest.fromLevel);
  const since = raised && reading.latest && reading.latest.createdAt > trailing.from ? reading.latest.createdAt : trailing.from;
  const window = sinceWindow(new Date(since));
  const [delivery, optOuts] = await Promise.all([deliveryCounts(deps.db, window), optOutCounts(deps.db, window)]);
  const rates: ColdBatchRates = { sends: delivery.sends, hardBounceRate: hardBounceRate(delivery), unsubscribeRate: unsubscribeRate(optOuts) };
  if (delivery.sends < RATE_CHECK.minSends) return { status: "small_sample", rates };
  const reason = coldBatchRateBreach(rates);
  if (!reason) return { status: "ok", rates };
  const day = deps.now.toISOString().slice(0, 10);
  const outcome = await writeIncident(
    deps.db,
    { actionClass: "cold_batch", onceKey: `autonomy_incident:cold_batch_rate:${reading.latest?.id ?? 0}:${day}`, subjectId: null, detail: reason, at: deps.now, now: deps.now },
    deps.retry ?? {},
  );
  if (outcome === "failed") return { status: "failed", rates, reason };
  return { status: "demoted", rates, reason, written: outcome === "written" };
}
