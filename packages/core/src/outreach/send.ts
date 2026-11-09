// GTM-agents: handing approved cold drafts to the send function, and re-checking them first.
//
// revalidateDrafts is what every path runs right before a draft leaves (the batch, a resumed batch
// and a release): the draft is still open and at most RELEASE_MAX_AGE_DAYS old, its recipient is
// still the contact's address, the contact is still cold and not opted out, held out or suppressed,
// nobody at that address replied, inquired or unsubscribed since it was drafted, and nothing was
// sent to the contact since. The account is checked again too: nobody there may have entered a
// conversation, opted out or complained since, and when the caller passes them, the brain's never
// list and the set of templates still served apply. Inbound mail counts unless it is classified as a
// bounce, an auto-reply, out of office or spam, so mail still waiting for triage blocks. Any read
// error fails closed and refuses the draft.
//
// handOff claims each item's idempotency key in the effects ledger (HANDOFF_EFFECT) and passes the
// claimed items to the SendOutreach function with approvedDigest set. The claim is what keeps a
// re-run, a resumed batch and a release from handing the same draft over twice. It is released only
// when the send function reports a retryable failure, which means nothing was sent; an ambiguous
// failure (the function threw, or returned no outcome for an item) keeps the claim, because a second
// attempt could send twice. The send function runs every boundary check itself (halt, kill switch,
// suppression, lint, caps, windows) and records each send in the ledger.
//
// After the outcomes come back, the bookkeeping here is fire-and-forget and idempotent: a sent draft
// is marked sent, its campaign row records step 1 and when the next step is due, the contact's
// warmth moves from cold to contacted (compare-and-set) and last_contacted_at is set.
import { recordAutonomyEvidence } from "../autonomy/evidence.ts";
import type { GtmConfig } from "../config/schema.ts";
import { advanceWarmth } from "../data/contacts.ts";
import { inChunks, placeholders } from "../data/d1.ts";
import { releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { draftDigest } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { checkSuppression } from "../sending/suppression.ts";
import type { OutreachItem, OutreachOutcome, SendOutreach } from "../sending/types.ts";
import { matchNeverList, type NeverList } from "../sourcing/identity.ts";
import { heldOutContacts } from "./holdout.ts";
import { RELEASE_MAX_AGE_DAYS, loadAccountState } from "./select.ts";

export const HANDOFF_EFFECT = "cold_handoff";
const DAY_MS = 86_400_000;

export interface StoredDraft {
  id: string;
  contact_id: string | null;
  campaign_id: string | null;
  template_id: string | null;
  kind: string;
  recipient_email: string | null;
  recipient_name: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  approved_digest: string | null;
  created_at: string;
  idempotency_key: string | null;
  contact_email: string | null;
  warmth: string | null;
  account_key: string | null;
  job_title: string | null;
  last_contacted_at: string | null;
  lifecycle_state: string | null;
  /** Measurement bookkeeping set at composition: the template file's SHA-256 and the send's cohort. */
  template_sha256?: string | null;
  cohort?: string | null;
}

/** Load drafts with their contact, in the order given. Throws on a database error. */
export async function loadDrafts(db: D1Database, ids: readonly string[]): Promise<StoredDraft[]> {
  const byId = new Map<string, StoredDraft>();
  for (const chunk of inChunks([...new Set(ids)])) {
    const { results } = await db
      .prepare(
        `SELECT d.id, d.contact_id, d.campaign_id, d.template_id, d.kind, d.recipient_email, d.recipient_name, d.subject, d.body,
                d.status, d.approved_digest, d.created_at, d.idempotency_key, d.template_sha256, d.cohort,
                c.email AS contact_email, c.warmth, c.account_key, c.job_title, c.last_contacted_at, l.state AS lifecycle_state
           FROM drafts d
           LEFT JOIN contacts c ON c.id = d.contact_id
           LEFT JOIN contact_lifecycle l ON l.contact_id = d.contact_id
          WHERE d.id IN (${placeholders(chunk.length)})`,
      )
      .bind(...chunk)
      .all<StoredDraft>();
    for (const r of results) byId.set(r.id, r);
  }
  return ids.map((id) => byId.get(id)).filter((d): d is StoredDraft => d !== undefined);
}

/** The digest of a draft's current content. */
export function currentDigest(draft: Pick<StoredDraft, "recipient_email" | "subject" | "body">): Promise<string> {
  return draftDigest({ to: draft.recipient_email, subject: draft.subject, body: draft.body });
}

/**
 * Re-check drafts right before they leave. Returns a refusal reason per draft id; drafts not in the
 * map passed. Never throws: anything that cannot be read refuses every draft it covers.
 */
export interface RevalidateOptions {
  /** The brain's never list; a draft at an account or title on it is refused. */
  never?: NeverList;
  /** Template ids still served; a draft built from any other template is refused. */
  servedTemplates?: ReadonlySet<string>;
}

export async function revalidateDrafts(db: D1Database, drafts: readonly StoredDraft[], now: Date, options: RevalidateOptions = {}): Promise<Map<string, string>> {
  const refused = new Map<string, string>();
  const oldest = new Date(now.getTime() - RELEASE_MAX_AGE_DAYS * DAY_MS).toISOString();
  const open: StoredDraft[] = [];
  for (const d of drafts) {
    const recipient = d.recipient_email?.trim().toLowerCase() ?? "";
    if (d.status !== "pending_approval" && d.status !== "approved") refused.set(d.id, `the draft is ${d.status}`);
    else if (d.created_at < oldest) refused.set(d.id, `the draft is older than ${RELEASE_MAX_AGE_DAYS} days`);
    else if (!d.contact_id || !d.contact_email) refused.set(d.id, "the contact no longer exists");
    else if (recipient === "" || recipient !== d.contact_email.toLowerCase()) refused.set(d.id, "the recipient is not the contact's address");
    else if (d.warmth !== "cold") refused.set(d.id, `the contact is no longer cold (${d.warmth ?? "unknown"})`);
    else if (d.lifecycle_state === "opted_out" || d.lifecycle_state === "deleted") refused.set(d.id, "the contact opted out");
    else if (d.last_contacted_at !== null && d.last_contacted_at >= d.created_at) refused.set(d.id, "the contact was written to after this was drafted");
    else if (options.servedTemplates && (!d.template_id || !options.servedTemplates.has(d.template_id))) refused.set(d.id, "its template is no longer served");
    else if (options.never && matchNeverList(options.never, { domain: d.account_key, title: d.job_title })) refused.set(d.id, "the account or title is on the never list");
    else open.push(d);
  }
  if (open.length === 0) return refused;

  const failAll = (reason: string) => {
    for (const d of open) if (!refused.has(d.id)) refused.set(d.id, reason);
  };
  try {
    const check = await checkSuppression(db, open.map((d) => d.recipient_email ?? ""));
    if (check.blocked.some((b) => b.reason === "check_failed")) {
      failAll("the suppression list could not be read");
      return refused;
    }
    const blocked = new Map(check.blocked.map((b) => [b.recipient, b.reason]));
    for (const d of open) {
      const reason = blocked.get(d.recipient_email ?? "");
      if (reason) refused.set(d.id, `the recipient is suppressed (${reason})`);
    }
  } catch {
    failAll("the suppression list could not be read");
    return refused;
  }

  try {
    const accounts = await loadAccountState(db, now);
    for (const d of open) {
      if (refused.has(d.id)) continue;
      if (!d.account_key) refused.set(d.id, "the contact has no account");
      else if (accounts.live.has(d.account_key)) refused.set(d.id, "someone at the account is now in a conversation");
      else if (accounts.optedOut.has(d.account_key)) refused.set(d.id, "someone at the account opted out or complained");
    }
    const held = await heldOutContacts(db, open.map((d) => d.contact_id ?? ""), now);
    for (const d of open) if (d.contact_id && held.has(d.contact_id) && !refused.has(d.id)) refused.set(d.id, "the contact is in the holdout");
    for (const chunk of inChunks(open.map((d) => d.id))) {
      const [replied, sent] = await db.batch<{ id: string }>([
        db
          .prepare(
            `SELECT d.id FROM drafts d WHERE d.id IN (${placeholders(chunk.length)}) AND EXISTS (
               SELECT 1 FROM inbound_emails ie
                WHERE (ie.contact_id = d.contact_id OR lower(ie.sender_email) = lower(d.recipient_email))
                  AND (ie.classification IS NULL OR ie.classification NOT IN ('bounce', 'auto_reply', 'out_of_office', 'spam'))
                  AND ie.received_at >= d.created_at)`,
          )
          .bind(...chunk),
        db
          .prepare(
            `SELECT d.id FROM drafts d WHERE d.id IN (${placeholders(chunk.length)}) AND EXISTS (
               SELECT 1 FROM outreach_sends os WHERE os.contact_id = d.contact_id AND os.sent_at >= d.created_at)`,
          )
          .bind(...chunk),
      ]);
      for (const r of replied?.results ?? []) if (!refused.has(r.id)) refused.set(r.id, "mail from the contact arrived after this was drafted (a reply, an inquiry, an unsubscribe or mail not yet triaged)");
      for (const r of sent?.results ?? []) if (!refused.has(r.id)) refused.set(r.id, "something was sent to the contact after this was drafted");
    }
  } catch {
    failAll("the contact's recent history could not be read");
  }
  return refused;
}

export interface HandoffItem {
  draft: StoredDraft;
  /** The digest the approval covers; the send function re-checks it. */
  approvedDigest: string;
}

export interface HandoffReport {
  submitted: number;
  sent: number;
  deferred: number;
  blocked: number;
  duplicate: number;
  failed: number;
  /** Items missing a recipient, subject, body, key or digest: never handed over. */
  incomplete: number;
  /** Already handed over by an earlier run or release. */
  alreadyHandedOff: number;
  /** Items the send function returned no outcome for, or all of them when it threw. Their claims stay. */
  unknown: number;
  outcomes: Map<string, OutreachOutcome>;
}

export interface HandoffDeps {
  db: D1Database;
  send: SendOutreach;
  config: Pick<GtmConfig, "sequences">;
  now: Date;
  log?: JobLogger;
}

function toItem(draft: StoredDraft, approvedDigest: string): OutreachItem | null {
  // Skip rather than fill in: an item missing any part is never handed over.
  if (!draft.idempotency_key || !draft.contact_id || !draft.recipient_email || !draft.subject || !draft.body || !/^[0-9a-f]{64}$/.test(approvedDigest)) return null;
  return {
    idempotencyKey: draft.idempotency_key,
    path: "cold",
    contactId: draft.contact_id,
    to: draft.recipient_email,
    ...(draft.recipient_name ? { toName: draft.recipient_name } : {}),
    subject: draft.subject,
    body: draft.body,
    draftId: draft.id,
    ...(draft.campaign_id ? { campaignId: draft.campaign_id } : {}),
    ...(draft.template_id ? { templateId: draft.template_id } : {}),
    sequenceStep: 1,
    approvedDigest,
    ...(draft.template_sha256 ? { templateSha256: draft.template_sha256 } : {}),
    ...(draft.cohort ? { cohort: draft.cohort } : {}),
  };
}

/**
 * Claim many effects at once: the keys this caller won, exactly as claimEffect would decide them one
 * by one (each is its own INSERT OR IGNORE on the ledger's primary key). Throws on a database error.
 */
export async function claimMany(db: D1Database, keys: readonly string[], effect: string, now: Date): Promise<Set<string>> {
  const claimed = new Set<string>();
  const at = now.toISOString();
  for (const chunk of inChunks(keys, { perValue: 1 })) {
    const results = await db.batch(chunk.map((key) => db.prepare("INSERT OR IGNORE INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(key, effect, at)));
    results.forEach((r, i) => {
      const key = chunk[i];
      if (key !== undefined && (r.meta.changes ?? 0) > 0) claimed.add(key);
    });
  }
  return claimed;
}

async function bookkeep(deps: HandoffDeps, draft: StoredDraft, outcome: OutreachOutcome): Promise<void> {
  const { db, now } = deps;
  const at = now.toISOString();
  const campaignRow = (sql: string, ...values: unknown[]) =>
    draft.campaign_id && draft.contact_id ? db.prepare(sql).bind(draft.campaign_id, draft.contact_id, at, ...values).run() : Promise.resolve(null);
  try {
    if (outcome.status === "sent") {
      await db.prepare("UPDATE drafts SET status = 'sent', sent_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(draft.id, at).run();
      // The send function schedules the follow-up when it records the send. This write only fills a
      // row it could not, and never overwrites one a bounce, reply or opt-out has already moved on.
      const next = deps.config.sequences.cold.steps[1];
      const nextAt = next ? new Date(now.getTime() + next.delayDays * DAY_MS).toISOString() : null;
      await campaignRow(
        `UPDATE campaign_contacts SET status = 'sent', sequence_step = 1,
                sequence_active = CASE WHEN status = 'pending' AND sequence_paused_at IS NULL THEN ?4 ELSE sequence_active END,
                next_send_at = CASE WHEN status = 'pending' AND sequence_paused_at IS NULL THEN ?5 ELSE next_send_at END,
                updated_at = ?3
          WHERE campaign_id = ?1 AND contact_id = ?2 AND status IN ('pending', 'skipped')`,
        next ? 1 : 0,
        nextAt,
      );
      if (draft.contact_id) {
        await db.prepare("UPDATE contacts SET last_contacted_at = COALESCE(last_contacted_at, ?2), updated_at = ?2 WHERE id = ?1").bind(draft.contact_id, at).run();
        await advanceWarmth(db, draft.contact_id, "contacted", now);
      }
    } else if (outcome.status === "deferred") {
      await campaignRow("UPDATE campaign_contacts SET next_send_at = ?4, updated_at = ?3 WHERE campaign_id = ?1 AND contact_id = ?2 AND status = 'pending'", outcome.nextAttemptAt);
    } else if (outcome.status === "blocked" || (outcome.status === "failed" && !outcome.retryable)) {
      await campaignRow("UPDATE campaign_contacts SET status = 'skipped', updated_at = ?3 WHERE campaign_id = ?1 AND contact_id = ?2 AND status = 'pending'");
    }
  } catch (error) {
    deps.log?.warn("send bookkeeping failed", { draftId: draft.id, error: sanitizeErrorMessage(error) });
  }
}

/** Hand approved drafts to the send function, once each. Throws only when the claims cannot be written. */
export async function handOff(deps: HandoffDeps, items: readonly HandoffItem[]): Promise<HandoffReport> {
  const report: HandoffReport = { submitted: 0, sent: 0, deferred: 0, blocked: 0, duplicate: 0, failed: 0, incomplete: 0, alreadyHandedOff: 0, unknown: 0, outcomes: new Map() };
  if (items.length === 0) return report;
  const byKey = new Map<string, HandoffItem>();
  for (const i of items) {
    const item = toItem(i.draft, i.approvedDigest);
    if (item) byKey.set(item.idempotencyKey, i);
    else report.incomplete++;
  }
  // The claim is a gate: a database error here propagates, and nothing is handed over.
  const claimed = await claimMany(deps.db, [...byKey.keys()], HANDOFF_EFFECT, deps.now);
  report.alreadyHandedOff = byKey.size - claimed.size;
  const batch = [...claimed].map((key) => {
    const item = byKey.get(key);
    return item ? toItem(item.draft, item.approvedDigest) : null;
  }).filter((x): x is OutreachItem => x !== null);
  if (batch.length === 0) return report;
  report.submitted = batch.length;

  let outcomes: OutreachOutcome[];
  try {
    outcomes = await deps.send(batch);
  } catch (error) {
    // Ambiguous: some may have gone out. Keep every claim so nothing is sent twice.
    deps.log?.error("the send function threw; the batch's claims are kept", { error: sanitizeErrorMessage(error) });
    report.unknown = batch.length;
    return report;
  }
  const outcomeByKey = new Map((Array.isArray(outcomes) ? outcomes : []).map((o) => [o.idempotencyKey, o]));
  for (const item of batch) {
    const source = byKey.get(item.idempotencyKey);
    const outcome = outcomeByKey.get(item.idempotencyKey);
    if (!source) continue;
    if (!outcome) {
      report.unknown++;
      continue;
    }
    report.outcomes.set(source.draft.id, outcome);
    report[outcome.status]++;
    if (outcome.status === "failed" && outcome.retryable) await releaseEffect(deps.db, item.idempotencyKey, HANDOFF_EFFECT);
    await bookkeep(deps, source.draft, outcome);
  }
  return report;
}

/** One line for operator messages. */
export function handoffLine(report: HandoffReport): string {
  const parts = [`${report.sent} sent`, `${report.deferred} deferred`, `${report.blocked} blocked`, `${report.failed} failed`];
  if (report.duplicate) parts.push(`${report.duplicate} duplicate`);
  if (report.alreadyHandedOff) parts.push(`${report.alreadyHandedOff} already handed over`);
  if (report.unknown) parts.push(`${report.unknown} with no outcome`);
  if (report.incomplete) parts.push(`${report.incomplete} incomplete and not handed over`);
  return parts.join(", ");
}

/** A cold_batch autonomy evidence row, through the evidence module (autonomy/evidence.ts). Bookkeeping: never throws. */
export async function recordAutonomyEvent(db: D1Database, outcome: "approved_unchanged" | "auto_sent", subjectId: string, detail: string, now: Date): Promise<void> {
  // Evidence is bookkeeping; a lost row never changes what was sent.
  await recordAutonomyEvidence(db, { actionClass: "cold_batch", outcome, subjectId, detail, now });
}
