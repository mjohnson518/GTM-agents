// GTM-agents: the daily cold batch: select, pick, claim, hold out, compose, gate, store, then send or
// wait for the operator.
//
// One run, in order:
//   1. gates: cold_batch:enabled must be on and cold outreach must not be paused (both fail closed);
//   2. resume: in auto-approve mode, approved drafts from the last 14 days that were never handed
//      over and are due (a YELLOW deferral, an interrupted run) go out first, under the same
//      readiness policy;
//   3. the daily key: today's campaign id is fixed (cb<YYYYMMDD>). If today's campaign exists, the
//      run only resumes it and never starts a second batch;
//   4. volume: the warm-up volume from the send path, lowered by cold_batch:daily_limit, the batch
//      maximum, the job's row ceiling and today's room under the sending domain's daily cap;
//   5. templates (served under the lock rules) and the brain's never list; neither may be missing;
//   6. selection (select.ts), oversampled, then the pure picker (picker.ts), then the canonical
//      suppression check, which fails closed;
//   7. the campaign row is inserted, which is the daily key; a run that loses that race stops;
//   8. an atomic claim per contact in the effects ledger, then the holdout split;
//   9. plan each contact's template, experiment arm, subject line and send slot, pinned before any
//      draft exists (experiments/plan.ts), then compose and gate each draft (compose.ts), then the
//      model reviewer when it is on;
//  10. store the drafts: approved with their digest only when auto-approve applies and the draft
//      passed the whole gate, otherwise pending_approval. Blocked copy is never stored as a draft;
//  11. readiness over the passing drafts, salvaged once when only suppression or the account cap
//      made it RED;
//  12. policy: RED holds everything and pages; manual mode writes the approval manifest and sends
//      the operator samples and the release command; auto mode sends GREEN batches whole and YELLOW
//      batches by half (at least five), deferring the rest 24 hours.
// Every write outside the database is claimed first. Bookkeeping (quality rows, the templates
// table, holdout rows, operator messages) fails open; every gate fails closed.
import { isFlagOn } from "../jobs/loop.ts";
import { intentAllowsFirstTouch } from "../scoring/intent.ts";
import { loadAngles } from "../signals/angles.ts";

const INTENT_ENFORCE_FLAG = "intent_score:enforce";
import { returnAutomaticApprovals } from "../autonomy/incidents.ts";
import { loadBrain } from "../brain/load.ts";
import type { KVReader } from "../brain/load.ts";
import type { GtmConfig } from "../config/schema.ts";
import { claimEffect } from "../events/effects.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { cohortFor, signalledContacts, templateIsTargeted, type SendCohort } from "../metrics/cohort.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { approvedClaimLines } from "../quality/claims.ts";
import { hostFromConfig, summarizeQuality, type LinkPolicy, type QualityFinding, type QualityResult } from "../quality/gate.ts";
import { recordQualityChecks, type QualityRecord } from "../quality/record.ts";
import { planReviewSamples, reviewOutbound, templateReviews, withReview, type ReviewVerdict } from "../quality/reviewer.ts";
import { draftDigest, verifyApproval } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { readColdPause } from "../sending/kill-switch.ts";
import { checkSuppression } from "../sending/suppression.ts";
import type { SendOutreach } from "../sending/types.ts";
import { loadSourcingBrain } from "../sourcing/brain.ts";
import { createSpendGate } from "../sourcing/spend.ts";
import { loadTemplates, serveTemplateFiles, type ServedTemplate, type TemplateFile } from "../templates/store.ts";
import { planAllocation, withWeightOverrides } from "../experiments/plan.ts";
import { readAllocation } from "../experiments/flags.ts";
import { batchTemplates } from "./allocate.ts";
import { composeColdDraft, loadCopy, type ComposeContext } from "./compose.ts";
import {
  OUTREACH_FLAGS,
  OUTREACH_LIMITS,
  readAutoApprove,
  readConfidenceFloor,
  readDailyLimit,
  readHoldoutRate,
  readOn,
  readWholeNumber,
  type AutoApproveDecision,
} from "./flags.ts";
import { holdoutWindow, pickHoldout, recordHoldout, seededRng } from "./holdout.ts";
import { releaseCommand, renderSamples, writeManifest, type Manifest, type ManifestDraft } from "./manifest.ts";
import { pickContacts, type PickResult } from "./picker.ts";
import { readinessLine, readinessWithSalvage, type ReadinessLevel, type ReadinessReport } from "./readiness.ts";
import { RELEASE_MAX_AGE_DAYS, loadAccountState, selectCandidates, type SelectionRow } from "./select.ts";
import { HANDOFF_EFFECT, claimMany, handOff, handoffLine, loadDrafts, recordAutonomyEvent, revalidateDrafts, type HandoffReport, type RevalidateOptions, type StoredDraft } from "./send.ts";

export const PICK_EFFECT = "cold_pick";
export const PAGE_EFFECT = "cold_batch_page";
export const NOTICE_EFFECT = "cold_batch_notice";
/** A YELLOW batch sends at least this many now. */
export const YELLOW_MIN_SEND = 5;
export const YELLOW_DEFER_HOURS = 24;
const SELECTION_OVERSAMPLE = 1.5;
const SELECTION_MAX_ROWS = 5_000;
const SELECTION_MAX_PAGES = 4;
const OPERATOR_TEXT_MAX = 3_800;
const DAY_MS = 86_400_000;

export interface ColdBatchDeps {
  db: D1Database;
  /** Brain files, templates and the kill switch. */
  kv: KVReader | undefined;
  flags: FlagReader;
  config: GtmConfig;
  now: Date;
  job: string;
  runId?: string;
  signal?: AbortSignal;
  log: JobLogger;
  send: SendOutreach;
  /** Today's cold volume from the warm-up ramp. */
  volume: () => Promise<number>;
  model?: ModelGateway | undefined;
  operator?: OperatorChannel | undefined;
  /** Templates bundled with the Worker; without them, templates are served from KV. */
  templates?: readonly TemplateFile[];
  /** The product's app URL, whose host copy may link to. */
  appUrl?: string | undefined;
  /** The job's daily spend cap for the model reviewer, in cents. */
  reviewMaxSpendCents?: number;
  reviewTimeoutMs?: number;
  /** The job's row ceiling: the most drafts one run writes. */
  maxDrafts?: number;
}

export type ColdBatchStatus = "skipped" | "resumed" | "empty" | "held" | "manual" | "sent";

export interface ColdBatchResult {
  status: ColdBatchStatus;
  summary: string;
  campaignId?: string;
  /** Drafts stored this run. */
  drafts: number;
  /** Drafts that passed the whole gate. */
  passed: number;
  held: number;
  blocked: number;
  heldOut: number;
  readiness?: ReadinessLevel;
  manifest?: Manifest;
  handoff?: HandoffReport;
  resumed?: HandoffReport;
  skippedByRule?: PickResult<unknown>["skipped"];
}

interface Composed {
  row: SelectionRow;
  draftId: string;
  idempotencyKey: string;
  template: ServedTemplate | null;
  subject: string;
  body: string;
  result: QualityResult;
  review: ReviewVerdict | null;
  /** Measurement bookkeeping (metrics/cohort.ts); null when the signals could not be read. */
  cohort: SendCohort | null;
}

const empty = (status: ColdBatchStatus, summary: string, extra: Partial<ColdBatchResult> = {}): ColdBatchResult => ({ status, summary, drafts: 0, passed: 0, held: 0, blocked: 0, heldOut: 0, ...extra });

const newDraftId = () => `dr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** Today's campaign id: the daily key. */
export function campaignIdFor(now: Date): string {
  return `cb${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

function linkPolicy(config: Pick<GtmConfig, "company" | "sending">, appUrl: string | undefined): LinkPolicy {
  const domains = [config.company.domain, hostFromConfig(config.company.url), hostFromConfig(appUrl)].filter((d): d is string => Boolean(d));
  return { domains: [...new Set(domains)], exactUrls: config.sending.bookingUrl ? [config.sending.bookingUrl] : [] };
}

async function notify(deps: ColdBatchDeps, text: string): Promise<boolean> {
  if (!deps.operator) return false;
  try {
    await deps.operator.notify({ text });
    return true;
  } catch (error) {
    deps.log.warn("an operator message could not be sent", { error: sanitizeErrorMessage(error) });
    return false;
  }
}

/** Send a page or notice at most once per key. A ledger error still sends: a second page beats none. */
async function notifyOnce(deps: ColdBatchDeps, key: string, effect: string, text: string): Promise<void> {
  let first: boolean;
  try {
    first = await claimEffect(deps.db, key, effect);
  } catch {
    first = true;
  }
  if (first) await notify(deps, text);
}

/** The most first touches this run may hand over or draft. 0 means none today. */
async function dailyRoom(deps: ColdBatchDeps): Promise<{ limit: number; why: string }> {
  let volume: number;
  try {
    volume = await deps.volume();
  } catch (error) {
    return { limit: 0, why: `the day's volume could not be read: ${sanitizeErrorMessage(error)}` };
  }
  if (!Number.isFinite(volume) || volume <= 0) return { limit: 0, why: "the warm-up volume for today is 0" };
  const [operatorLimit, domainCap] = await Promise.all([readDailyLimit(deps.flags), readWholeNumber(deps.flags, OUTREACH_FLAGS.domainDailyCap, OUTREACH_LIMITS.domainDailyCap)]);
  let sentToday: number;
  try {
    const row = await deps.db.prepare("SELECT COUNT(*) AS n FROM outreach_sends WHERE sent_at >= ?1").bind(`${deps.now.toISOString().slice(0, 10)}T00:00:00.000Z`).first<{ n: number }>();
    sentToday = Number(row?.n ?? 0);
  } catch {
    return { limit: 0, why: "today's send count could not be read" };
  }
  const limit = Math.max(0, Math.floor(Math.min(volume, operatorLimit, OUTREACH_LIMITS.batchMax, deps.maxDrafts ?? OUTREACH_LIMITS.batchMax, domainCap - sentToday)));
  return { limit, why: limit === 0 ? `no room today (volume ${volume}, operator limit ${operatorLimit}, domain cap ${domainCap}, ${sentToday} sent)` : "" };
}

function storeDraftStatement(deps: ColdBatchDeps, campaignId: string, c: Composed, mode: AutoApproveDecision, digest: string | null): D1PreparedStatement {
  const at = deps.now.toISOString();
  const approved = digest !== null;
  const name = [c.row.first_name, c.row.last_name].filter(Boolean).join(" ").trim();
  return deps.db
    .prepare(
      `INSERT OR IGNORE INTO drafts (id, contact_id, campaign_id, template_id, kind, recipient_email, recipient_name, subject, body, status,
         approved_digest, approved_at, approved_by, idempotency_key, notes, created_at, updated_at, template_sha256, cohort)
       VALUES (?1, ?2, ?3, ?4, 'cold_intro', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16, ?17)`,
    )
    .bind(
      c.draftId,
      c.row.id,
      campaignId,
      c.template?.id ?? null,
      c.row.email,
      name || null,
      c.subject,
      c.body,
      approved ? "approved" : "pending_approval",
      digest,
      approved ? at : null,
      approved ? `auto:${mode.reason ?? "unknown"}` : null,
      c.idempotencyKey,
      `quality ${c.result.verdict}${c.result.findings.length ? `: ${[...new Set(c.result.findings.map((f) => f.code))].join(", ")}` : ""}`.slice(0, 500),
      at,
      validSha(c.template?.sha256),
      c.cohort,
    );
}

/** Measurement bookkeeping must never drop a draft: a value the column's CHECK would refuse is left out. */
const validSha = (value: string | undefined): string | null => (value && /^[0-9a-f]{64}$/.test(value) ? value : null);

function templateRowStatement(db: D1Database, t: ServedTemplate, at: string): D1PreparedStatement {
  const list = (v: readonly string[] | undefined) => (v ? JSON.stringify(v) : null);
  return db
    .prepare(
      `INSERT INTO templates (id, kind, status, step, angle, subject, body_sha256, volume_weight, segments, personas, team_sizes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, status = excluded.status, step = excluded.step, angle = excluded.angle,
         subject = excluded.subject, body_sha256 = excluded.body_sha256, volume_weight = excluded.volume_weight,
         segments = excluded.segments, personas = excluded.personas, team_sizes = excluded.team_sizes, updated_at = excluded.updated_at`,
    )
    .bind(t.id, t.meta.kind, t.meta.status, t.meta.step ?? null, t.meta.angle, t.subject, t.sha256, t.meta.volume_weight, list(t.meta.segments), list(t.meta.personas), list(t.meta.team_sizes), at);
}

async function batchWrite(db: D1Database, statements: readonly D1PreparedStatement[]): Promise<D1Result[]> {
  const out: D1Result[] = [];
  for (let i = 0; i < statements.length; i += 50) out.push(...(await db.batch(statements.slice(i, i + 50))));
  return out;
}

async function setNextSend(deps: ColdBatchDeps, drafts: readonly StoredDraft[], at: string, status?: "skipped"): Promise<void> {
  const statements = drafts
    .filter((d) => d.campaign_id && d.contact_id)
    .map((d) =>
      status
        ? deps.db.prepare("UPDATE campaign_contacts SET status = 'skipped', updated_at = ?3 WHERE campaign_id = ?1 AND contact_id = ?2 AND status = 'pending'").bind(d.campaign_id, d.contact_id, deps.now.toISOString())
        : deps.db.prepare("UPDATE campaign_contacts SET next_send_at = ?3, updated_at = ?4 WHERE campaign_id = ?1 AND contact_id = ?2").bind(d.campaign_id, d.contact_id, at, deps.now.toISOString()),
    );
  try {
    await batchWrite(deps.db, statements);
  } catch (error) {
    deps.log.warn("campaign rows could not be updated", { error: sanitizeErrorMessage(error) });
  }
}

interface PolicyOutcome {
  readiness: ReadinessReport;
  handoff?: HandoffReport;
  heldRed: boolean;
  deferred: number;
  dropped: number;
}

/**
 * Readiness, then the auto-approve policy over approved drafts that were re-checked: RED holds and
 * pages, YELLOW hands over max(5, half) and defers the rest, GREEN hands over everything.
 */
async function sendUnderPolicy(deps: ColdBatchDeps, label: string, drafts: readonly StoredDraft[], caps: { domainDailyCap: number; accountWeeklyCap: number }): Promise<PolicyOutcome> {
  const items = drafts.map((d) => ({ draftId: d.id, to: d.recipient_email ?? "", accountKey: d.account_key, subject: d.subject ?? "", body: d.body ?? "", draft: d }));
  const decision = await readinessWithSalvage(deps.db, items, { now: deps.now, ...caps });
  if (decision.dropped.length > 0) await setNextSend(deps, decision.dropped.map((i) => i.draft), "", "skipped");
  if (decision.report.overall === "red") {
    await notifyOnce(deps, `${label}:${deps.now.toISOString().slice(0, 10)}`, PAGE_EFFECT, `Cold batch ${label} is held: ${readinessLine(decision.report)}. Nothing was sent. The approved drafts wait and are checked again on the next run.`);
    return { readiness: decision.report, heldRed: true, deferred: 0, dropped: decision.dropped.length };
  }
  const ordered = decision.items.map((i) => i.draft);
  const sendNow = decision.report.overall === "yellow" ? ordered.slice(0, Math.max(YELLOW_MIN_SEND, Math.ceil(ordered.length / 2))) : ordered;
  const later = ordered.slice(sendNow.length);
  if (later.length > 0) await setNextSend(deps, later, new Date(deps.now.getTime() + YELLOW_DEFER_HOURS * 3_600_000).toISOString());
  const handoff = await handOff(
    { db: deps.db, send: deps.send, config: deps.config, now: deps.now, log: deps.log },
    sendNow.map((d) => ({ draft: d, approvedDigest: d.approved_digest ?? "" })),
  );
  return { readiness: decision.report, handoff, heldRed: false, deferred: later.length, dropped: decision.dropped.length };
}

/** Approved, unsent drafts from recent batches that are due, re-checked and sent under the policy. */
/**
 * SQL true when a campaign's run has finished with it (status active), or the run is long past its
 * duration ceiling and was interrupted. A campaign still being written is neither.
 */
function settledCampaignSql(column: string, cutoffParam: string): string {
  return `EXISTS (SELECT 1 FROM campaigns cp WHERE cp.id = ${column} AND (cp.status = 'active' OR cp.updated_at < ${cutoffParam}))`;
}

/** A run still marked as writing its campaign after this long was interrupted. */
const ABANDONED_AFTER_MS = 15 * 60_000;
const abandonedBefore = (now: Date) => new Date(now.getTime() - ABANDONED_AFTER_MS).toISOString();

async function resumeDue(deps: ColdBatchDeps, limit: number, caps: { domainDailyCap: number; accountWeeklyCap: number }, guard: RevalidateOptions): Promise<PolicyOutcome | null> {
  if (limit <= 0) return null;
  const since = new Date(deps.now.getTime() - RELEASE_MAX_AGE_DAYS * DAY_MS).toISOString();
  const { results } = await deps.db
    .prepare(
      `SELECT d.id FROM drafts d
         JOIN campaign_contacts cc ON cc.campaign_id = d.campaign_id AND cc.contact_id = d.contact_id
        WHERE d.kind = 'cold_intro' AND d.status = 'approved' AND d.created_at >= ?1 AND d.campaign_id LIKE 'cb%'
          AND cc.status = 'pending' AND (cc.next_send_at IS NULL OR cc.next_send_at <= ?2)
          AND ${settledCampaignSql("d.campaign_id", "?5")}
          AND NOT EXISTS (SELECT 1 FROM event_effects e WHERE e.event_id = d.idempotency_key AND e.effect = ?3)
        ORDER BY d.created_at ASC, d.id ASC LIMIT ?4`,
    )
    .bind(since, deps.now.toISOString(), HANDOFF_EFFECT, limit, abandonedBefore(deps.now))
    .all<{ id: string }>();
  if (results.length === 0) return null;
  const drafts = await loadDrafts(deps.db, results.map((r) => r.id));
  const refused = await revalidateDrafts(deps.db, drafts, deps.now, guard);
  const ready: StoredDraft[] = [];
  for (const d of drafts) {
    if (refused.has(d.id) || d.status !== "approved" || !d.approved_digest) continue;
    if (await verifyApproval({ to: d.recipient_email, subject: d.subject, body: d.body, status: d.status, approved_digest: d.approved_digest })) ready.push(d);
  }
  const stale = drafts.filter((d) => !ready.includes(d));
  if (stale.length > 0) await setNextSend(deps, stale, "", "skipped");
  if (ready.length === 0) return null;
  return sendUnderPolicy(deps, "resume", ready, caps);
}

function operatorText(header: string[], samples: (max: number) => string, footer: string[]): string {
  for (const max of [900, 500, 250, 0]) {
    const body = max > 0 ? samples(max) : "";
    const text = [...header, ...(body ? ["", body] : []), "", ...footer].join("\n");
    if (text.length <= OPERATOR_TEXT_MAX || max === 0) return text;
  }
  return [...header, "", ...footer].join("\n");
}

function samplesAt(drafts: readonly ManifestDraft[], max: number): string {
  return renderSamples(drafts.map((d) => ({ ...d, body: d.body.length > max ? `${d.body.slice(0, max)}\n[...]` : d.body })));
}

/** In manual mode, write the manifest and send the operator the samples and the release command. */
async function putUpForRelease(deps: ColdBatchDeps, campaignId: string, drafts: readonly StoredDraft[], context: string[]): Promise<Manifest> {
  const proposed: ManifestDraft[] = drafts.map((d) => ({ id: d.id, to: d.recipient_email ?? "", subject: d.subject ?? "", body: d.body ?? "" }));
  const manifest = await writeManifest(deps.db, campaignId, proposed, deps.now);
  // The message shows the manifest as stored, which another run may have written first.
  const manifestDrafts: ManifestDraft[] = (await loadDrafts(deps.db, Object.keys(manifest.entries))).map((d) => ({ id: d.id, to: d.recipient_email ?? "", subject: d.subject ?? "", body: d.body ?? "" }));
  const command = releaseCommand(manifest);
  const text = operatorText(
    [`Cold batch ${campaignId} is waiting for your release: ${manifestDrafts.length} drafts, one per account.`, ...context],
    (max) => samplesAt(manifestDrafts, max),
    [`To send exactly these ${manifestDrafts.length} drafts, reply with:`, command, "The code confirms this set. Every draft is checked again before it is sent, and one edited since this message is refused."],
  );
  await notify(deps, text);
  return manifest;
}

/** Manual mode, recovery: today's campaign has passing drafts but no manifest (an interrupted run). */
async function ensureManifest(deps: ColdBatchDeps, campaignId: string, caps: { domainDailyCap: number; accountWeeklyCap: number }, guard: RevalidateOptions): Promise<Manifest | null> {
  const existing = await deps.db.prepare("SELECT 1 AS hit FROM approval_manifests WHERE id = ?1").bind(campaignId).first();
  if (existing) return null;
  // A batch still being written by another run is never recovered.
  const settled = await deps.db.prepare(`SELECT 1 AS hit WHERE ${settledCampaignSql("?1", "?2")}`).bind(campaignId, abandonedBefore(deps.now)).first();
  if (!settled) return null;
  const { results } = await deps.db
    .prepare(
      `SELECT d.id FROM drafts d WHERE d.campaign_id = ?1 AND d.status = 'pending_approval'
          AND (SELECT q.verdict FROM quality_checks q WHERE q.subject_type = 'draft' AND q.subject_id = d.id ORDER BY q.created_at DESC LIMIT 1) = 'pass'
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .bind(campaignId)
    .all<{ id: string }>();
  if (results.length === 0) return null;
  const drafts = await loadDrafts(deps.db, results.map((r) => r.id));
  const refused = await revalidateDrafts(deps.db, drafts, deps.now, guard);
  const open = drafts.filter((d) => !refused.has(d.id));
  if (open.length === 0) return null;
  const decision = await readinessWithSalvage(deps.db, open.map((d) => ({ draftId: d.id, to: d.recipient_email ?? "", accountKey: d.account_key, subject: d.subject ?? "", body: d.body ?? "", draft: d })), { now: deps.now, ...caps });
  if (decision.report.overall === "red" || decision.items.length === 0) return null;
  return putUpForRelease(deps, campaignId, decision.items.map((i) => i.draft), [readinessLine(decision.report)]);
}

/** Run the daily cold batch. Throws only on a database error in a gate; bookkeeping errors are logged. */
export async function runColdBatch(deps: ColdBatchDeps): Promise<ColdBatchResult> {
  const { db, config, now, log } = deps;
  if (!(await readOn(deps.flags, OUTREACH_FLAGS.enabled))) return empty("skipped", "the cold batch is switched off");
  const pause = await readColdPause(deps.kv);
  if (pause.paused) return empty("skipped", `cold outreach is paused (${pause.severity ?? "critical"})`);

  const mode = await readAutoApprove(deps.flags, config, db);
  const caps = {
    domainDailyCap: await readWholeNumber(deps.flags, OUTREACH_FLAGS.domainDailyCap, OUTREACH_LIMITS.domainDailyCap),
    accountWeeklyCap: await readWholeNumber(deps.flags, OUTREACH_FLAGS.accountWeeklyCap, OUTREACH_LIMITS.accountWeeklyCap),
  };
  if (caps.accountWeeklyCap === 0) return empty("skipped", "the account weekly cap is 0 or could not be read");
  const campaignId = campaignIdFor(now);
  const day = now.toISOString().slice(0, 10);

  const companyDomain = config.company.domain;
  const load = deps.templates ? await serveTemplateFiles(deps.templates, { companyDomain }) : await loadTemplates(deps.kv, { companyDomain });
  // Approved weight overrides (experiments/proposals.ts) replace a template file's volume_weight.
  const templates = batchTemplates(await withWeightOverrides(load.templates, deps.flags));
  if (templates.length === 0) {
    const why = load.error ?? (load.skipped.length ? `no approved cold_intro template is servable (${load.skipped.map((s) => `${s.file}: ${s.reason}`).join("; ")})` : "no approved cold_intro template is uploaded");
    await notifyOnce(deps, `${campaignId}:templates`, NOTICE_EFFECT, `Cold batch ${campaignId} did not run: ${why}.`);
    return empty("skipped", why);
  }
  const brain = await loadSourcingBrain(deps.kv);
  if (brain.degraded) return empty("skipped", "the brain could not be read whole, so its never list cannot be applied");

  const guard: RevalidateOptions = { never: brain.never, servedTemplates: new Set(load.templates.map((t) => t.id)) };

  let room = await dailyRoom(deps);
  const resumed = mode.auto ? await resumeDue(deps, room.limit, caps, guard) : null;
  if (resumed?.handoff?.submitted) {
    await recordAutonomyEvent(db, "auto_sent", "resume", `resumed ${resumed.handoff.submitted} (${mode.reason ?? "unknown"})`, now);
    room = await dailyRoom(deps);
  }

  const existing = await db.prepare("SELECT id FROM campaigns WHERE id = ?1").bind(campaignId).first<{ id: string }>();
  if (existing) {
    const manifest = mode.auto ? null : await ensureManifest(deps, campaignId, caps, guard);
    const parts = [`today's batch ${campaignId} already exists`];
    if (resumed?.handoff) parts.push(`resumed: ${handoffLine(resumed.handoff)}`);
    if (manifest) parts.push(`manifest written: ${releaseCommand(manifest)}`);
    return empty("resumed", parts.join("; "), { campaignId, ...(manifest ? { manifest } : {}), ...(resumed?.handoff ? { resumed: resumed.handoff } : {}) });
  }
  if (room.limit <= 0) return empty("skipped", room.why, resumed?.handoff ? { resumed: resumed.handoff } : {});

  // Selection and the picker.
  const holdoutRate = await readHoldoutRate(deps.flags);
  const floor = await readConfidenceFloor(deps.flags);
  const want = holdoutWindow(room.limit, holdoutRate);
  const state = await loadAccountState(db, now);
  const pageSize = Math.min(Math.ceil(want * SELECTION_OVERSAMPLE) + 50, SELECTION_MAX_ROWS);
  const rows: SelectionRow[] = [];
  let pick: PickResult<SelectionRow> = pickContacts([], { limit: want, weeklyCap: caps.accountWeeklyCap, perBatch: 1, live: state.live, optedOut: state.optedOut, recent: state.recent, never: brain.never });
  for (let page = 0; page < SELECTION_MAX_PAGES; page++) {
    const pageRows = await selectCandidates(db, { limit: pageSize, offset: page * pageSize, floor, now });
    rows.push(...pageRows);
    pick = pickContacts(rows, { limit: want, weeklyCap: caps.accountWeeklyCap, perBatch: 1, live: state.live, optedOut: state.optedOut, recent: state.recent, never: brain.never });
    if (pick.picked.length >= want || pageRows.length < pageSize) break;
  }
  const suppression = await checkSuppression(db, pick.picked.map((r) => r.email));
  if (suppression.blocked.some((b) => b.reason === "check_failed")) return empty("skipped", "the suppression list could not be read", { skippedByRule: pick.skipped });
  const suppressed = new Set(suppression.blocked.map((b) => b.recipient));
  const picked = pick.picked.filter((r) => !suppressed.has(r.email));
  const skippedText = Object.entries(pick.skipped).filter(([, n]) => n > 0).map(([r, n]) => `${r} ${n}`).join(", ");
  if (picked.length === 0) return empty("empty", `no eligible contacts${skippedText ? ` (skipped: ${skippedText})` : ""}`, { skippedByRule: pick.skipped });

  // The daily key.
  const seed = `${day}:${crypto.randomUUID()}`;
  const allocation = await readAllocation(deps.flags);
  const created = await db
    .prepare("INSERT OR IGNORE INTO campaigns (id, name, description, status, target_count, notes, created_at, updated_at) VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?6)")
    .bind(campaignId, `Cold batch ${day}`, "The daily cold batch: first touches assembled from approved templates.", picked.length, `seed ${seed}; holdout rate ${holdoutRate}; allocation ${allocation.mode}`, now.toISOString())
    .run();
  if ((created.meta.changes ?? 0) === 0) return empty("resumed", `another run started today's batch ${campaignId}`, { campaignId });

  // The intent score filters selection only while intent_score:enforce is on; an unreadable switch
  // counts as on, so a read error writes fewer first touches, never more.
  let intentEnforced: boolean;
  try {
    intentEnforced = isFlagOn(await deps.flags.get(INTENT_ENFORCE_FLAG));
  } catch {
    intentEnforced = true;
  }
  const eligible = picked.filter((r) => intentAllowsFirstTouch(r.attributes, intentEnforced));

  // Claims, then the holdout.
  const claimedKeys = await claimMany(db, eligible.map((r) => `${PICK_EFFECT}:${day}:${r.id}`), PICK_EFFECT, now);
  const claimed = eligible.filter((r) => claimedKeys.has(`${PICK_EFFECT}:${day}:${r.id}`));
  // Walk in rank order and stop once the batch is full, so held and treated contacts come from the
  // same ranked range and the control never includes a tail the treatment did not reach.
  const held = pickHoldout(claimed.map((r) => r.id), holdoutRate, seededRng(seed));
  const heldOut: SelectionRow[] = [];
  const toWrite: SelectionRow[] = [];
  for (const r of claimed) {
    if (toWrite.length >= room.limit) break;
    if (held.has(r.id)) heldOut.push(r);
    else toWrite.push(r);
  }
  await recordHoldout(db, heldOut.map((r) => r.id), day, now);

  // Compose and gate.
  const judgeSlice = await loadBrain({ KV: deps.kv ?? { get: () => Promise.resolve(null) } }, "judge");
  const copy = await loadCopy(db);
  // Angles come only from each contact's own real, unexpired signal. A failed read gives none, so a
  // template that needs one is held rather than sent without its reason.
  let angles: Awaited<ReturnType<typeof loadAngles>> = new Map();
  try {
    angles = await loadAngles(db, toWrite.map((r) => ({ contactId: r.id, accountKey: r.account_key, accountName: r.account_name })), now);
  } catch (error) {
    log.warn("signal angles could not be read; templates that need one are held", { error: error instanceof Error ? error.message : String(error) });
  }
  const ctx: ComposeContext = { config, ...copy, links: linkPolicy(config, deps.appUrl), approvedClaims: approvedClaimLines(judgeSlice.text), angles };
  // Templates, experiment arms, subject lines and send slots are planned and pinned before any
  // draft is composed (experiments/plan.ts); weighted rotation by volume_weight is the default.
  const plan = await planAllocation({ db, flags: deps.flags, now, seed, campaignId, rows: toWrite, templates, sending: config.sending, log });
  // Measurement bookkeeping: which contacts had a recent signal, for each draft's cohort. A failed
  // read records no cohort; it never stops the batch.
  const signalled = await signalledContacts(db, toWrite.map((r) => ({ contactId: r.id, accountKey: r.account_key })), now);
  const composed: Composed[] = [];
  for (const row of toWrite) {
    if (deps.signal?.aborted) break;
    const outcome = composeColdDraft(row, templates, plan.rotationFor(row), ctx);
    composed.push({
      row,
      draftId: newDraftId(),
      idempotencyKey: `cold:${day}:${row.id}`,
      template: outcome.template,
      subject: outcome.status === "composed" ? outcome.subject : "",
      body: outcome.status === "composed" ? outcome.body : "",
      result: outcome.result,
      review: null,
      cohort: outcome.template ? cohortFor(signalled, row.id, templateIsTargeted(outcome.template.meta)) : null,
    });
  }

  // The model reviewer: one sample per template plus one; each template keeps its worst review.
  const reviewable = composed.filter((c) => c.template && c.subject !== "" && c.result.verdict !== "block");
  const reviewOn = await readOn(deps.flags, OUTREACH_FLAGS.modelReview);
  let reviewNote = reviewOn ? "" : mode.auto ? "the model reviewer is switched off, so nothing is approved automatically" : "";
  if (reviewOn && reviewable.length > 0) {
    const samples = planReviewSamples(reviewable.map((c) => ({ key: c.draftId, templateId: c.template?.id ?? "", c })));
    const spend = createSpendGate({ db, flags: deps.flags, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), ...(deps.reviewMaxSpendCents !== undefined ? { jobCapCents: deps.reviewMaxSpendCents } : {}), log });
    const outcome = await reviewOutbound(
      { model: deps.model, config, brain: judgeSlice.text, spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), ...(deps.reviewTimeoutMs !== undefined ? { timeoutMs: deps.reviewTimeoutMs } : {}), log },
      samples.map((s) => ({ key: s.key, kind: "cold_intro", subject: s.c.subject, body: s.c.body, context: `cold intro from template ${s.templateId}` })),
    );
    if (outcome.ok) {
      const byTemplate = templateReviews(outcome.verdicts, new Map(samples.map((s) => [s.key, s.templateId])));
      for (const c of reviewable) {
        c.review = byTemplate.get(c.template?.id ?? "") ?? null;
        c.result = withReview(c.result, c.review, "no review covered this template");
      }
    } else {
      reviewNote = `the model reviewer was unavailable (${outcome.reason})`;
      for (const c of reviewable) c.result = withReview(c.result, null, outcome.reason);
    }
  } else if (!reviewOn && mode.auto) {
    for (const c of reviewable) c.result = withReview(c.result, null, "the model reviewer is switched off (quality:model_review_enabled), so a person decides");
  }

  // Store: drafts for everything that is not blocked, campaign rows, quality rows, the templates table.
  const at = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  const stored: Composed[] = [];
  for (const c of composed) {
    const hasCopy = c.subject !== "" && c.result.verdict !== "block";
    if (hasCopy) {
      const digest = mode.auto && c.result.verdict === "pass" ? await draftDigest({ to: c.row.email, subject: c.subject, body: c.body }) : null;
      statements.push(storeDraftStatement(deps, campaignId, c, mode, digest));
      stored.push(c);
    }
    // The experiment arm the contact was pinned to rides on its campaign row to the send ledger.
    const arm = hasCopy ? plan.experimentFor(c.row.id) : undefined;
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, draft_id, status, experiment_id, experiment_arm, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
        .bind(campaignId, c.row.id, hasCopy ? c.draftId : null, hasCopy ? "pending" : "skipped", arm?.experimentId ?? null, arm?.arm ?? null, at),
    );
  }
  const results = await batchWrite(db, statements);
  // A draft whose insert was ignored (its idempotency key already exists) is not this run's.
  const insertedDrafts = new Set<string>();
  let r = 0;
  for (const c of composed) {
    const hasCopy = c.subject !== "" && c.result.verdict !== "block";
    if (hasCopy && (results[r]?.meta.changes ?? 0) > 0) insertedDrafts.add(c.draftId);
    r += hasCopy ? 2 : 1;
  }
  await plan.record(stored.filter((c) => insertedDrafts.has(c.draftId)).map((c) => ({ contactId: c.row.id, draftId: c.draftId })));
  const qualityRecords: QualityRecord[] = composed.map((c) => ({ subjectType: "draft", subjectId: stored.includes(c) ? c.draftId : c.idempotencyKey, result: c.result, review: c.review }));
  await recordQualityChecks(db, qualityRecords, now);
  try {
    await batchWrite(db, templates.map((t) => templateRowStatement(db, t, at)));
  } catch (error) {
    log.warn("the templates table could not be updated", { error: sanitizeErrorMessage(error) });
  }

  const passing = stored.filter((c) => c.result.verdict === "pass" && insertedDrafts.has(c.draftId));
  const counts = {
    drafts: insertedDrafts.size,
    passed: passing.length,
    held: composed.filter((c) => c.result.verdict === "hold").length,
    blocked: composed.filter((c) => c.result.verdict === "block").length,
    heldOut: heldOut.length,
  };
  const quality = summarizeQuality(composed.map((c) => c.result));
  const context = [
    `Quality: ${quality}${reviewNote ? `; ${reviewNote}` : ""}.`,
    ...(counts.held > 0 ? [`${counts.held} held draft(s) wait for individual review and are not part of this batch.`] : []),
    ...(counts.heldOut > 0 ? [`Holdout: ${counts.heldOut} contact(s) held out as the no-send control.`] : []),
    ...plan.lines,
  ];
  // The campaign is marked active only when this run has finished with it, so a concurrent rerun
  // never resumes or recovers a batch that is still being written (see settledCampaignSql).
  const activate = () => db.prepare("UPDATE campaigns SET status = 'active', target_count = ?2, updated_at = ?3 WHERE id = ?1").bind(campaignId, counts.drafts, now.toISOString()).run().catch(() => undefined);

  if (passing.length === 0) {
    await activate();
    await notify(deps, [`Cold batch ${campaignId}: no draft passed the quality gate, so nothing waits for release.`, ...context].join("\n"));
    return { status: "held", summary: `no draft passed the gate (${quality})`, campaignId, ...counts, skippedByRule: pick.skipped };
  }

  const drafts = await loadDrafts(db, passing.map((c) => c.draftId));
  const refused = await revalidateDrafts(db, drafts, now, guard);
  const open = drafts.filter((d) => !refused.has(d.id));
  if (refused.size > 0) await setNextSend(deps, drafts.filter((d) => refused.has(d.id)), "", "skipped");

  if (!mode.auto) {
    const decision = await readinessWithSalvage(db, open.map((d) => ({ draftId: d.id, to: d.recipient_email ?? "", accountKey: d.account_key, subject: d.subject ?? "", body: d.body ?? "", draft: d })), { now, ...caps });
    await recordQualityChecks(db, [readinessRecord(campaignId, decision.report)], now);
    if (decision.report.overall === "red" || decision.items.length === 0) {
      await notifyOnce(deps, `${campaignId}:${day}`, PAGE_EFFECT, [`Cold batch ${campaignId} is held: ${readinessLine(decision.report)}. No release code was issued.`, ...context].join("\n"));
      await activate();
      return { status: "held", summary: `readiness RED: ${readinessLine(decision.report)}`, campaignId, ...counts, readiness: decision.report.overall, skippedByRule: pick.skipped };
    }
    const manifest = await putUpForRelease(deps, campaignId, decision.items.map((i) => i.draft), [...context, readinessLine(decision.report)]);
    await activate();
    return {
      status: "manual",
      summary: `${counts.drafts} drafts, ${Object.keys(manifest.entries).length} waiting for release with ${releaseCommand(manifest)}; ${quality}`,
      campaignId,
      ...counts,
      readiness: decision.report.overall,
      manifest,
      skippedByRule: pick.skipped,
    };
  }

  // A demotion recorded after the mode was read did not see these drafts, which were approved
  // since: read it again now that they are stored, and hand nothing over if it no longer holds.
  if (!(await readAutoApprove(deps.flags, config, db)).auto) {
    await returnAutomaticApprovals(db, "cold_batch", now);
    await activate();
    await notify(deps, [`Cold batch ${campaignId} was not sent: automatic approval stopped while it was being built (a demotion, or a switch or level change). Its drafts are back for review.`, ...context].join("\n"));
    return { status: "held", summary: "automatic approval stopped while the batch was being built; drafts returned to review", campaignId, ...counts, skippedByRule: pick.skipped };
  }
  const policy = await sendUnderPolicy(deps, campaignId, open, caps);
  await activate();
  await recordQualityChecks(db, [readinessRecord(campaignId, policy.readiness)], now);
  if (policy.heldRed) {
    return { status: "held", summary: `readiness RED: ${readinessLine(policy.readiness)}`, campaignId, ...counts, readiness: policy.readiness.overall, skippedByRule: pick.skipped };
  }
  const handoff = policy.handoff;
  if (handoff && handoff.submitted > 0) await recordAutonomyEvent(db, "auto_sent", campaignId, `handed over ${handoff.submitted} (${mode.reason ?? "unknown"})`, now);
  const sentLine = handoff ? handoffLine(handoff) : "nothing handed over";
  await notify(
    deps,
    [
      `Cold batch ${campaignId} went out automatically (${mode.reason === "flag" ? OUTREACH_FLAGS.autoApprove : `cold_batch at level ${mode.level}`}): ${sentLine}.`,
      ...(policy.deferred > 0 ? [`${policy.deferred} deferred ${YELLOW_DEFER_HOURS} hours because readiness is YELLOW.`] : []),
      readinessLine(policy.readiness),
      ...context,
    ].join("\n"),
  );
  return {
    status: "sent",
    summary: `${counts.drafts} drafts; ${sentLine}${policy.deferred ? `; ${policy.deferred} deferred` : ""}; ${quality}`,
    campaignId,
    ...counts,
    readiness: policy.readiness.overall,
    ...(handoff ? { handoff } : {}),
    ...(resumed?.handoff ? { resumed: resumed.handoff } : {}),
    skippedByRule: pick.skipped,
  };
}

/** The batch's readiness as a quality_checks row: one finding per dimension that did not pass. */
function readinessRecord(campaignId: string, report: ReadinessReport): QualityRecord {
  const findings: QualityFinding[] = Object.entries(report.dimensions)
    .filter(([, d]) => d.status !== "pass")
    .map(([name, d]) => ({ code: `READINESS_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`, severity: d.status === "block" ? "block" : "hold", detail: d.detail }));
  const verdict = report.overall === "red" ? "block" : report.overall === "yellow" ? "hold" : "pass";
  return { subjectType: "batch", subjectId: campaignId, result: { verdict, score: verdict === "pass" ? 100 : verdict === "hold" ? 70 : 0, findings } };
}
