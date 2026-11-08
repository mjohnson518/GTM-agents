// GTM-agents: the follow-up sweep: the cold sequence's later steps, threaded under the first email,
// stopped by any reply from the account.
//
// One run, in order:
//   1. gates: sequences:enabled must be on and cold outreach must not be paused (both fail closed);
//      the brain must be readable whole, so its never list applies to every step;
//   2. due rows: active, not paused, next_send_at passed, oldest first, up to the row ceiling;
//   3. the checks (checks.ts): the reply check over the whole account, the account rules and the
//      contact rules. A reply stops every sequence at the account; the other rules end or pause the
//      one row. If any of them cannot be read, nothing is drafted or sent for any row this run;
//   4. the ledger: a step the send ledger shows went out moves the row on (a write that failed
//      earlier); a step beyond the configured last one finishes the sequence (exhausted); a row
//      whose first email is not in the ledger pauses; a row due early by the ledger waits;
//   5. existing drafts for the step: a sent one moves the row on, a rejected one pauses it, an
//      approved one not yet gone is sent as approved: one a person released, or one approved
//      automatically while automatic approval still applies (otherwise it returns to review);
//   6. the manual channel step before the last step, behind followup:manual_channel_enabled;
//   7. threading: every earlier step's Message-ID, looked up from the provider once and stored on
//      the ledger. A step that cannot be threaded is held and stays due;
//   8. templates: a step with no template, or a template that fails the fixture check, holds every
//      row due for that step (the rows stay due, the operator is told once a day). Each contact's
//      draft passes the deterministic gate; a draft that does not pass pauses that contact;
//   9. the model reviewer (quality:model_review_enabled), one review per template, judge role,
//      budget-gated. An outage leaves the steps due; a template that fails holds its step;
//  10. approval, as in the cold batch (readAutoApprove): at the default level the drafts are stored
//      pending approval and put up in one manifest, and the operator gets samples and the command
//      `sequence-release-<id>-<code>`. With cold_batch:auto_approve on, or the cold_batch class at
//      level 2 or above, and the reviewer on, drafts that pass are approved bound to their digest
//      and sent. With the reviewer off, a person releases them even then;
//  11. send (send.ts): path "sequence", the step's idempotency key, In-Reply-To and References, the
//      approved digest. A failure for one contact pauses that contact until `sequence-resume-<id>`.
// Every write outside the database is claimed first (the send function claims each step's key);
// bookkeeping (quality rows, notices, row updates after a send) fails open; every gate fails closed.
import { checkReplyIntake } from "./intake.ts";
import { loadBrain, type KVReader } from "../brain/load.ts";
import type { GtmConfig } from "../config/schema.ts";
import { claimEffect } from "../events/effects.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { createRotation, type Rotation } from "../outreach/allocate.ts";
import { loadCopy, type ComposeContext } from "../outreach/compose.ts";
import { OUTREACH_FLAGS, readAutoApprove, readOn, type AutoApproveDecision } from "../outreach/flags.ts";
import { releaseCommand, renderSamples, writeManifest, type Manifest, type ManifestDraft } from "../outreach/manifest.ts";
import { recordAutonomyEvent } from "../outreach/send.ts";
import type { EmailProvider } from "../ports/email.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { approvedClaimLines } from "../quality/claims.ts";
import { hostFromConfig, summarizeQuality, type LinkPolicy, type QualityResult } from "../quality/gate.ts";
import { recordQualityChecks, type QualityRecord } from "../quality/record.ts";
import { planReviewSamples, reviewOutbound, templateReviews, type ReviewVerdict } from "../quality/reviewer.ts";
import { draftDigest, verifyApproval } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { readColdPause } from "../sending/kill-switch.ts";
import { runWrites } from "../sending/ledger.ts";
import type { SendOutreach } from "../sending/types.ts";
import type { KvStore } from "../shared/kv.ts";
import { loadSourcingBrain } from "../sourcing/brain.ts";
import { createSpendGate } from "../sourcing/spend.ts";
import { loadTemplates, serveTemplateFiles, type ServedTemplate, type TemplateFile } from "../templates/store.ts";
import { checkRows } from "./checks.ts";
import { composeStep, planSteps, type StepPlan } from "./compose.ts";
import {
  draftsInLiveManifests,
  insertDraftStatement,
  loadStepDrafts,
  newDraftId,
  refreshDraftStatement,
  retireDraftsStatement,
  returnAutoApprovalToReview,
  sequenceManifestId,
  stepKey,
  type NewStepDraft,
  type StepDraft,
} from "./drafts.ts";
import { SEQUENCE_FLAGS, SEQUENCE_LIMITS } from "./flags.ts";
import { manualGates, manualTouchText, type ManualTouch } from "./manual.ts";
import { keyOf, loadDueRows, loadPriorSends, rowKey, type DueRow, type PriorSend } from "./rows.ts";
import { advanceAfter, sendLine, sendSteps, type ReadyStep, type SendReport } from "./send.ts";
import { endSequenceStatement, EXHAUSTED_REASON, pauseSequenceStatement, rescheduleSequenceStatement, stopSequences, type SequenceRowKey } from "./state.ts";
import { resolveMessageIds, threadFor, type LookupBudget, type LookupMiss, type Thread } from "./threading.ts";

export const SWEEP_NOTICE_EFFECT = "sequence_notice";
export const DEFAULT_SWEEP_MAX_ROWS = 200;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OPERATOR_TEXT_MAX = 3_800;
/** A row the ledger says is not due yet by more than this waits instead. */
const EARLY_SLACK_MS = 60_000;
/** How long a held row waits before the sweep looks at it again. */
const HELD_BACKOFF_MS = 3 * HOUR_MS;

export interface SweepDeps {
  db: D1Database;
  /** The brain, templates and the kill switch. */
  kv: (KVReader & Pick<KvStore, "get">) | undefined;
  flags: FlagReader;
  config: GtmConfig;
  now: Date;
  job: string;
  runId?: string;
  signal?: AbortSignal;
  log: JobLogger;
  /** The send function for sequence steps (createSequenceSender). */
  send: SendOutreach;
  /** The email provider, for Message-ID lookups. */
  provider: EmailProvider | undefined;
  model?: ModelGateway | undefined;
  operator?: OperatorChannel | undefined;
  /** Templates bundled with the Worker; without them, templates are served from KV. */
  templates?: readonly TemplateFile[];
  /** The product's app URL, whose host copy may link to. */
  appUrl?: string | undefined;
  reviewMaxSpendCents?: number;
  reviewTimeoutMs?: number;
  /** Rows one run reads, at most. */
  maxRows?: number;
  messageIdLookups?: number;
  manualTouchesPerDay?: number;
}

export interface SweepCounts {
  due: number;
  sent: number;
  deferred: number;
  /** Drafts put up for a release. */
  drafted: number;
  /** Rows stopped by a reply from the account. */
  stopped: number;
  ended: number;
  exhausted: number;
  paused: number;
  /** Rows that stay due: a template, the reviewer, threading, or a check that could not be read. */
  held: number;
  /** Rows waiting: for a manual touch, for a release, or not due yet by the ledger. */
  waiting: number;
  reconciled: number;
  failed: number;
}

export interface SweepResult extends SweepCounts {
  status: "skipped" | "held" | "ran";
  summary: string;
  manifest?: Manifest;
  send?: SendReport;
}

interface Candidate {
  row: DueRow;
  key: SequenceRowKey;
  id: string;
  step: number;
  nextDelayDays: number | null;
  earlier: PriorSend[];
  first: PriorSend & { subject: string };
  stepKey: string;
  existing?: StepDraft;
  thread?: Thread;
}

interface Composed {
  c: Candidate;
  template: ServedTemplate;
  subject: string;
  body: string;
  result: QualityResult;
  review: ReviewVerdict | null;
}

const zero = (): SweepCounts => ({ due: 0, sent: 0, deferred: 0, drafted: 0, stopped: 0, ended: 0, exhausted: 0, paused: 0, held: 0, waiting: 0, reconciled: 0, failed: 0 });

function linkPolicy(config: Pick<GtmConfig, "company" | "sending">, appUrl: string | undefined): LinkPolicy {
  const domains = [config.company.domain, hostFromConfig(config.company.url), hostFromConfig(appUrl)].filter((d): d is string => Boolean(d));
  return { domains: [...new Set(domains)], exactUrls: config.sending.bookingUrl ? [config.sending.bookingUrl] : [] };
}

async function notify(deps: Pick<SweepDeps, "operator" | "log">, text: string): Promise<void> {
  if (!deps.operator) return;
  try {
    await deps.operator.notify({ text: text.length > OPERATOR_TEXT_MAX ? `${text.slice(0, OPERATOR_TEXT_MAX)}\n[...]` : text });
  } catch (error) {
    deps.log.warn("an operator message could not be sent", { error: sanitizeErrorMessage(error) });
  }
}

/** A notice at most once per key. A ledger error still sends: a second notice beats none. */
async function notifyOnce(deps: Pick<SweepDeps, "db" | "operator" | "log">, key: string, text: string): Promise<void> {
  if (!deps.operator) return;
  let first: boolean;
  try {
    first = await claimEffect(deps.db, key, SWEEP_NOTICE_EFFECT);
  } catch {
    first = true;
  }
  if (first) await notify(deps, text);
}

function summarize(counts: SweepCounts, extra: string[] = []): string {
  const parts = Object.entries(counts)
    .filter(([name, n]) => n > 0 || name === "due")
    .map(([name, n]) => `${name} ${n}`);
  return [...parts, ...extra].join(", ");
}

const lines = (items: readonly string[], max: number = SEQUENCE_LIMITS.listed): string[] => [...items.slice(0, max), ...(items.length > max ? [`and ${items.length - max} more`] : [])];

/** Run the follow-up sweep. Throws only on a database error before anything was decided; nothing is sent then. */
export async function runFollowUpSweep(deps: SweepDeps): Promise<SweepResult> {
  const { db, config, now, log } = deps;
  const counts = zero();
  const day = now.toISOString().slice(0, 10);
  const done = (status: SweepResult["status"], why: string, extra: Partial<SweepResult> = {}): SweepResult => ({ ...counts, status, summary: why, ...extra });

  if (!(await readOn(deps.flags, SEQUENCE_FLAGS.enabled))) return done("skipped", "sequences are switched off");
  const pause = await readColdPause(deps.kv);
  if (pause.paused) return done("skipped", `cold outreach is paused (${pause.severity ?? "critical"}), and follow-ups with it`);

  const rows = await loadDueRows(db, { now, limit: deps.maxRows ?? DEFAULT_SWEEP_MAX_ROWS });
  counts.due = rows.length;
  if (rows.length === 0) return done("ran", "nothing is due");

  // The reply check below is only meaningful while replies are being recorded.
  const intake = await checkReplyIntake(db, deps.flags, now);
  if (!intake.ok) {
    counts.held = rows.length;
    await notifyOnce(deps, `sequences:intake:${day}`, `Follow-ups are held: ${intake.reason}. Nothing was drafted or sent; ${rows.length} step(s) stay due. Set up the inbox (docs/INBOX.md) and these go on the next sweep.`);
    return done("held", intake.reason);
  }

  const kv = deps.kv;
  const brain = await loadSourcingBrain(kv);
  if (!kv || brain.degraded) {
    counts.held = rows.length;
    await notifyOnce(deps, `sequences:brain:${day}`, `Follow-ups are held: the brain could not be read whole, so its never list cannot be applied. ${rows.length} step(s) wait and stay due.`);
    return done("held", "the brain could not be read whole, so its never list cannot be applied");
  }

  // 3. The checks. A read error holds every row.
  const checks = await checkRows(db, rows, { now, never: brain.never });
  if (!checks.ok) {
    counts.held = rows.length;
    log.warn("the sequence checks could not be read; nothing is drafted or sent", { reason: checks.reason });
    await notifyOnce(deps, `sequences:checks:${day}`, `Follow-ups are held: ${checks.reason}. Nothing was drafted or sent; ${rows.length} step(s) stay due and are checked again on the next sweep.`);
    return done("held", checks.reason);
  }

  const statements: D1PreparedStatement[] = [];
  const pausedNow: Array<{ row: DueRow; step: number | null; reason: string }> = [];
  const pauseRow = (row: DueRow, step: number | null, reason: string) => {
    counts.paused++;
    pausedNow.push({ row, step, reason });
    statements.push(pauseSequenceStatement(db, keyOf(row), { reason, now }));
  };
  const endRow = (row: DueRow, reason: string) => {
    statements.push(endSequenceStatement(db, keyOf(row), { reason, now }), retireDraftsStatement(db, row.campaign_id, row.contact_id, reason, now));
  };

  // A row held by threading, a template or the reviewer waits a few hours, so held rows never crowd
  // newer due rows out of the row ceiling. It stays active and unpaused.
  const backOff = (key: SequenceRowKey) => statements.push(rescheduleSequenceStatement(db, key, { until: new Date(now.getTime() + HELD_BACKOFF_MS).toISOString(), now }));

  const go: DueRow[] = [];
  const stoppedAccounts = new Set<string>();
  for (const row of rows) {
    const verdict = checks.verdicts.get(rowKey(keyOf(row))) ?? { kind: "pause", reason: "the row was not checked" };
    if (verdict.kind === "go") go.push(row);
    else if (verdict.kind === "stop") {
      counts.stopped++;
      if (!row.account_key || !stoppedAccounts.has(row.account_key)) {
        try {
          await stopSequences(db, { contactIds: [row.contact_id], ...(row.account_key ? { accountKey: row.account_key } : {}) }, { reason: verdict.reason, status: "replied", now });
          if (row.account_key) stoppedAccounts.add(row.account_key);
        } catch (error) {
          // Bookkeeping: nothing was sent, and the next sweep's reply check stops it again.
          log.warn("a sequence could not be stopped after a reply; the next sweep stops it again", { error: sanitizeErrorMessage(error) });
        }
      }
      statements.push(retireDraftsStatement(db, row.campaign_id, row.contact_id, verdict.reason, now));
    } else if (verdict.kind === "end") {
      counts.ended++;
      endRow(row, verdict.reason);
    } else pauseRow(row, row.sequence_step === null ? null : row.sequence_step + 1, verdict.reason);
  }

  // 4. The ledger.
  const steps = config.sequences.cold.steps;
  const lastStep = steps.length;
  const candidates: Candidate[] = [];
  let priors = new Map<string, PriorSend[]>();
  if (go.length > 0) {
    try {
      priors = await loadPriorSends(db, go.map(keyOf));
    } catch (error) {
      counts.held += go.length;
      log.warn("the send ledger could not be read; due steps wait", { error: sanitizeErrorMessage(error) });
      go.length = 0;
    }
  }
  for (const row of go) {
    const key = keyOf(row);
    const id = rowKey(key);
    const s = row.sequence_step;
    if (!Number.isInteger(s) || (s as number) < 1) {
      pauseRow(row, null, "the row has no sequence step");
      continue;
    }
    const current = s as number;
    const sends = priors.get(id) ?? [];
    const latest = sends.at(-1);
    if (latest && latest.sequence_step > current) {
      // The ledger is ahead of the row: a write after an earlier send was lost.
      const next = steps.find((x) => x.step === latest.sequence_step + 1);
      counts.reconciled++;
      statements.push(advanceAfter(db, key, latest.sequence_step, next ? next.delayDays : null, new Date(latest.sent_at), now));
      continue;
    }
    const stepConfig = steps.find((x) => x.step === current + 1);
    if (!stepConfig) {
      counts.exhausted++;
      endRow(row, EXHAUSTED_REASON);
      continue;
    }
    const first = sends.find((x) => x.sequence_step === 1);
    if (!first?.subject) {
      pauseRow(row, stepConfig.step, "the first email is not in the send ledger, so a follow-up cannot thread under it");
      continue;
    }
    const previous = sends.find((x) => x.sequence_step === current);
    const dueAt = previous ? Date.parse(previous.sent_at) + stepConfig.delayDays * DAY_MS : Number.NaN;
    if (Number.isFinite(dueAt) && dueAt > now.getTime() + EARLY_SLACK_MS) {
      counts.waiting++;
      statements.push(rescheduleSequenceStatement(db, key, { until: new Date(dueAt).toISOString(), now }));
      continue;
    }
    const afterNext = steps.find((x) => x.step === stepConfig.step + 1);
    candidates.push({
      row,
      key,
      id,
      step: stepConfig.step,
      nextDelayDays: afterNext ? afterNext.delayDays : null,
      earlier: sends.filter((x) => x.sequence_step < stepConfig.step),
      first: { ...first, subject: first.subject },
      stepKey: stepKey(row.campaign_id, row.contact_id, stepConfig.step),
    });
  }

  // Whether drafts that pass may be approved without a person: the cold batch's rule, and the reviewer on.
  const mode: AutoApproveDecision = await readAutoApprove(deps.flags, config);
  const reviewOn = await readOn(deps.flags, OUTREACH_FLAGS.modelReview);
  const auto = mode.auto && reviewOn;

  // 5. Existing drafts for the step.
  let open: Candidate[] = [];
  const approvedReady: Candidate[] = [];
  if (candidates.length > 0) {
    let drafts: Map<string, StepDraft>;
    try {
      drafts = await loadStepDrafts(db, candidates.map((c) => c.stepKey));
    } catch (error) {
      counts.held += candidates.length;
      log.warn("follow-up drafts could not be read; due steps wait", { error: sanitizeErrorMessage(error) });
      drafts = new Map();
      candidates.length = 0;
    }
    for (const c of candidates) {
      const existing = drafts.get(c.stepKey);
      if (!existing) {
        open.push(c);
        continue;
      }
      c.existing = existing;
      if (existing.status === "sent") {
        counts.reconciled++;
        statements.push(advanceAfter(db, c.key, c.step, c.nextDelayDays, existing.sent_at ? new Date(existing.sent_at) : now, now));
      } else if (existing.status === "rejected") {
        pauseRow(c.row, c.step, `step ${c.step}'s draft was rejected`);
      } else if (existing.status === "approved" && !auto && (existing.approved_by ?? "").startsWith("auto:")) {
        // Approved automatically, but automatic approval no longer applies: a person releases it.
        let returned = false;
        try {
          returned = await returnAutoApprovalToReview(db, existing.id, now);
        } catch (error) {
          log.warn("an automatically approved draft could not be returned to review; its step waits", { error: sanitizeErrorMessage(error) });
        }
        if (returned) {
          existing.status = "pending_approval";
          existing.approved_digest = null;
          existing.approved_by = null;
          open.push(c);
        } else counts.held++;
      } else if (existing.status === "approved") {
        const valid = existing.recipient_email === c.row.email && (await verifyApproval({ to: existing.recipient_email, subject: existing.subject, body: existing.body, status: existing.status, approved_digest: existing.approved_digest }));
        if (valid) approvedReady.push(c);
        else {
          pauseRow(c.row, c.step, `step ${c.step}'s approved draft no longer matches its approval or the contact's address`);
          // Retired, so resuming drafts the step afresh instead of pausing on the same draft again.
          statements.push(db.prepare("UPDATE drafts SET status = 'rejected', notes = 'the approved draft no longer matched', updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(existing.id, now.toISOString()));
        }
      } else open.push(c);
    }
  }

  // 6. The manual channel step before the last step, for steps not yet approved.
  const touches: Array<{ touch: ManualTouch; to: string; accountName: string | null }> = [];
  if (lastStep >= 2 && (await readOn(deps.flags, SEQUENCE_FLAGS.manualChannel))) {
    const lastOnes = open.filter((c) => c.step === lastStep);
    const gates = await manualGates(db, lastOnes.map((c) => ({ row: c.row, firstSubject: c.first.subject })), {
      now,
      senderName: config.agent.name,
      ...(deps.manualTouchesPerDay !== undefined ? { perDay: deps.manualTouchesPerDay } : {}),
    });
    open = open.filter((c) => {
      const gate = gates.get(c.id);
      if (!gate || gate.kind === "proceed") return true;
      counts.waiting++;
      statements.push(rescheduleSequenceStatement(db, c.key, { until: gate.until, now }));
      if (gate.created) touches.push({ touch: gate.created, to: c.row.email, accountName: c.row.account_name });
      return false;
    });
  }

  // 7. Threading.
  const budget: LookupBudget = { remaining: deps.messageIdLookups ?? SEQUENCE_LIMITS.messageIdLookups };
  const missReasons = new Set<LookupMiss>();
  const threaded = async (list: Candidate[]): Promise<Candidate[]> => {
    const out: Candidate[] = [];
    for (const c of list) {
      const misses = await resolveMessageIds(db, deps.provider, c.earlier, budget, log);
      for (const m of misses.values()) missReasons.add(m);
      const thread = threadFor(c.earlier);
      if (!thread) {
        counts.held++;
        backOff(c.key);
        continue;
      }
      c.thread = thread;
      out.push(c);
    }
    return out;
  };
  const sendApproved = await threaded(approvedReady);
  open = await threaded(open);

  // 8. Templates and composing.
  const templateProblems = new Map<number, string>();
  const noTemplate: string[] = [];
  const composed: Composed[] = [];
  const qualityRecords: QualityRecord[] = [];
  let ctx: ComposeContext | null = null;
  if (open.length > 0) {
    const judgeSlice = await loadBrain({ KV: kv }, "judge");
    const copy = await loadCopy(db);
    ctx = { config, ...copy, links: linkPolicy(config, deps.appUrl), approvedClaims: approvedClaimLines(judgeSlice.text) };
    const load = deps.templates ? await serveTemplateFiles(deps.templates, { companyDomain: config.company.domain }) : await loadTemplates(kv, { companyDomain: config.company.domain });
    const plans: Map<number, StepPlan> = planSteps(load.templates, steps, ctx);
    const skipped = load.skipped.map((x) => `${x.file}: ${x.reason}`).join("; ");
    for (const plan of plans.values()) {
      if (load.error) plan.problem ??= `the templates could not be served (${load.error})`;
      else if (plan.templates.length === 0 && skipped) plan.problem = `${plan.problem ?? "no template"} (not served: ${skipped.slice(0, 300)})`;
    }
    const angles = await firstAngles(db, load.templates, open.map((c) => c.first.template_id));
    const rotations = new Map<number, Rotation>();
    for (const c of open) {
      const plan = plans.get(c.step);
      if (!plan || plan.problem) {
        counts.held++;
        backOff(c.key);
        templateProblems.set(c.step, plan?.problem ?? `no step ${c.step} is configured`);
        continue;
      }
      let rotation = rotations.get(c.step);
      if (!rotation) {
        rotation = createRotation();
        rotations.set(c.step, rotation);
      }
      const outcome = composeStep(c.row, plan, rotation, ctx, { subject: c.first.subject, angle: angles.get(c.first.template_id ?? "") ?? "none" }, c.existing?.template_id ?? null);
      if (outcome.status === "held" && outcome.result.findings.some((f) => f.code === "NO_TEMPLATE")) {
        counts.held++;
        backOff(c.key);
        noTemplate.push(`${c.row.email} (step ${c.step})`);
        continue;
      }
      if (outcome.status === "held" || outcome.result.verdict !== "pass") {
        qualityRecords.push({ subjectType: "followup", subjectId: c.stepKey, result: outcome.result });
        pauseRow(c.row, c.step, `the draft did not pass the quality gate: ${[...new Set(outcome.result.findings.map((f) => f.code))].join(", ")}`);
        continue;
      }
      composed.push({ c, template: outcome.template, subject: outcome.subject, body: outcome.body, result: outcome.result, review: null });
    }
  }

  // Steps waiting in a live manifest with unchanged content are left alone.
  let live = new Map<string, string>();
  if (!auto && composed.some((x) => x.c.existing?.status === "pending_approval")) {
    try {
      live = await draftsInLiveManifests(db, new Date(now.getTime() - SEQUENCE_LIMITS.releaseMaxAgeHours * HOUR_MS));
    } catch {
      live = new Map();
    }
  }
  const fresh: Composed[] = [];
  for (const x of composed) {
    const e = x.c.existing;
    if (!auto && e?.status === "pending_approval" && live.has(e.id)) {
      const same = e.recipient_email === x.c.row.email && e.subject === x.subject && e.body === x.body;
      const unedited = live.get(e.id) === (await draftDigest({ to: e.recipient_email, subject: e.subject, body: e.body }));
      // Waiting for its release; and a draft someone edited since is never overwritten (its old command refuses it).
      if ((same && unedited) || !unedited) {
        counts.waiting++;
        continue;
      }
    }
    fresh.push(x);
  }

  // 9. The model reviewer: one review per template.
  let reviewNote = "";
  let reviewed = fresh;
  if (reviewOn && fresh.length > 0) {
    const samples = planReviewSamples(fresh.map((x) => ({ key: x.c.stepKey, templateId: x.template.id, x })), 0);
    const spend = createSpendGate({ db, flags: deps.flags, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), ...(deps.reviewMaxSpendCents !== undefined ? { jobCapCents: deps.reviewMaxSpendCents } : {}), log });
    const judgeSlice = await loadBrain({ KV: kv }, "judge");
    const outcome = await reviewOutbound(
      { model: deps.model, config, brain: judgeSlice.text, spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), ...(deps.reviewTimeoutMs !== undefined ? { timeoutMs: deps.reviewTimeoutMs } : {}), log },
      samples.slice(0, 20).map((s) => ({ key: s.key, kind: s.x.template.meta.kind, subject: s.x.subject, body: s.x.body, context: `step ${s.x.c.step} of a cold sequence, template ${s.templateId}` })),
    );
    if (!outcome.ok) {
      reviewNote = `the model reviewer was unavailable (${outcome.reason})`;
      counts.held += fresh.length;
      for (const x of fresh) backOff(x.c.key);
      reviewed = [];
      await notifyOnce(deps, `sequences:review:${day}`, `Follow-ups wait: ${reviewNote}. ${fresh.length} step(s) stay due and are reviewed on the next sweep. Nothing was paused or sent.`);
    } else {
      const byTemplate = templateReviews(outcome.verdicts, new Map(samples.map((s) => [s.key, s.templateId])));
      const failedSteps = new Map<number, string>();
      for (const x of fresh) {
        const verdict = byTemplate.get(x.template.id);
        if (verdict && !verdict.pass) failedSteps.set(x.c.step, `template ${x.template.id} did not pass the model reviewer (${verdict.reasons.join("; ").slice(0, 200) || "no reason given"})`);
      }
      reviewed = [];
      for (const x of fresh) {
        const verdict = byTemplate.get(x.template.id) ?? null;
        const failed = failedSteps.get(x.c.step);
        if (failed) {
          counts.held++;
          backOff(x.c.key);
          templateProblems.set(x.c.step, failed);
        } else if (!verdict) {
          counts.held++;
        } else {
          x.review = verdict;
          reviewed.push(x);
        }
      }
    }
  } else if (!reviewOn && mode.auto && fresh.length > 0) {
    reviewNote = `the model reviewer is switched off (${OUTREACH_FLAGS.modelReview}), so a person releases these`;
  }

  // 10. Store, then send or put up for release.
  const ready: ReadyStep[] = [];
  for (const c of sendApproved) {
    const e = c.existing as StepDraft;
    ready.push({
      row: c.key,
      step: c.step,
      nextDelayDays: c.nextDelayDays,
      idempotencyKey: c.stepKey,
      draft: { id: e.id, to: e.recipient_email ?? "", toName: e.recipient_name, subject: e.subject ?? "", body: e.body ?? "", templateId: e.template_id, approvedDigest: e.approved_digest ?? "" },
      thread: c.thread as Thread,
    });
  }
  const forRelease: ManifestDraft[] = [];
  const forReleaseCampaigns: string[] = [];
  if (reviewed.length > 0) {
    const writes: D1PreparedStatement[] = [];
    const approvals = new Map<string, string>();
    for (const x of reviewed) {
      const name = [x.c.row.first_name, x.c.row.last_name].filter(Boolean).join(" ").trim();
      const digest = auto ? await draftDigest({ to: x.c.row.email, subject: x.subject, body: x.body }) : null;
      if (digest) approvals.set(x.c.stepKey, digest);
      const draft: NewStepDraft = {
        id: newDraftId(),
        key: x.c.stepKey,
        contactId: x.c.row.contact_id,
        campaignId: x.c.row.campaign_id,
        templateId: x.template.id,
        kind: x.template.meta.kind,
        to: x.c.row.email,
        toName: name || null,
        subject: x.subject,
        body: x.body,
        notes: `step ${x.c.step} from template ${x.template.id}; quality ${x.result.verdict}`,
        approval: digest ? { digest, by: `auto:${mode.reason ?? "unknown"}` } : null,
      };
      writes.push(x.c.existing ? refreshDraftStatement(db, x.c.existing.id, draft, now) : insertDraftStatement(db, draft, now));
    }
    const written = await runWrites(db, writes);
    if (written.some((ok) => !ok)) log.warn("some follow-up drafts could not be stored; their steps stay due", { lost: written.filter((ok) => !ok).length });
    let stored = new Map<string, StepDraft>();
    try {
      stored = await loadStepDrafts(db, reviewed.map((x) => x.c.stepKey));
    } catch (error) {
      log.warn("stored follow-up drafts could not be read back; their steps stay due", { error: sanitizeErrorMessage(error) });
    }
    for (const x of reviewed) {
      const d = stored.get(x.c.stepKey);
      const matches = d !== undefined && d.recipient_email === x.c.row.email && d.subject === x.subject && d.body === x.body;
      qualityRecords.push({ subjectType: "followup", subjectId: d?.id ?? x.c.stepKey, result: x.result, review: x.review });
      if (!d || !matches) {
        counts.held++;
        continue;
      }
      if (auto) {
        const digest = approvals.get(x.c.stepKey);
        if (d.status !== "approved" || !digest || d.approved_digest !== digest) {
          counts.held++;
          continue;
        }
        ready.push({
          row: x.c.key,
          step: x.c.step,
          nextDelayDays: x.c.nextDelayDays,
          idempotencyKey: x.c.stepKey,
          draft: { id: d.id, to: d.recipient_email ?? "", toName: d.recipient_name, subject: d.subject ?? "", body: d.body ?? "", templateId: d.template_id, approvedDigest: digest },
          thread: x.c.thread as Thread,
        });
      } else if (d.status === "pending_approval") {
        forRelease.push({ id: d.id, to: d.recipient_email ?? "", subject: d.subject ?? "", body: d.body ?? "" });
        forReleaseCampaigns.push(x.c.row.campaign_id);
      } else counts.held++;
    }
  }

  // The row writes so far, before anything is sent.
  const written = await runWrites(db, statements);
  if (written.some((ok) => !ok)) log.warn("some sequence rows could not be updated; the next sweep reconciles them", { lost: written.filter((ok) => !ok).length });

  // 11. Send.
  let report: SendReport | undefined;
  if (ready.length > 0 && !deps.signal?.aborted) {
    report = await sendSteps({ db, send: deps.send, now, log }, ready);
    counts.sent += report.sent + report.duplicate;
    counts.deferred += report.deferred;
    counts.failed += report.failed;
    counts.held += report.retry + report.withheld;
    counts.ended += report.ended.length;
    const rowsByKey = new Map(rows.map((r) => [rowKey(keyOf(r)), r]));
    for (const p of report.paused) {
      const row = rowsByKey.get(rowKey(p.row));
      if (row) {
        counts.paused++;
        pausedNow.push({ row, step: p.step, reason: p.reason });
      }
    }
    if (auto && report.submitted > 0) await recordAutonomyEvent(db, "auto_sent", `sequence:${day}`, `follow-ups: ${sendLine(report)} (${mode.reason ?? "unknown"})`, now);
  } else if (ready.length > 0) {
    counts.held += ready.length;
  }

  // Put drafts up for release.
  let manifest: Manifest | undefined;
  if (forRelease.length > 0) {
    const firstCampaign = [...forReleaseCampaigns].sort()[0] ?? "";
    try {
      manifest = await writeManifest(db, firstCampaign, forRelease, now, { id: sequenceManifestId(now), kind: "sequence" });
      counts.drafted += Object.keys(manifest.entries).length;
      await notify(deps, releaseText(manifest, forRelease, reviewNote, ctx ? summarizeQuality(reviewed.map((x) => x.result)) : ""));
    } catch (error) {
      counts.held += forRelease.length;
      log.warn("the follow-up manifest could not be written; the drafts are put up again on the next sweep", { error: sanitizeErrorMessage(error) });
    }
  }
  await recordQualityChecks(db, qualityRecords, now);

  // Notices.
  if (templateProblems.size > 0 || noTemplate.length > 0) {
    const text = [
      "Follow-up steps are held by their templates; the rows stay due and nothing ended:",
      ...[...templateProblems.entries()].map(([step, why]) => `- step ${step}: ${why}`),
      ...(noTemplate.length > 0 ? [`- no template may be offered to: ${lines(noTemplate).join(", ")}`] : []),
      "Fix the template (and re-lock it), and the next sweep drafts these steps.",
    ].join("\n");
    await notifyOnce(deps, `sequences:templates:${day}`, text);
  }
  if (missReasons.has("no_lookup") || missReasons.has("other_provider")) {
    await notifyOnce(
      deps,
      `sequences:threading:${day}`,
      "Follow-ups wait: the first email's Message-ID cannot be looked up (the email provider has no Message-ID lookup, or the first email went through another provider), and a follow-up is never sent unthreaded.",
    );
  }
  if (pausedNow.length > 0) {
    await notify(
      deps,
      [
        `${pausedNow.length} follow-up sequence(s) paused for a person:`,
        ...lines(pausedNow.map((p) => `- ${p.row.email}${p.step ? ` (step ${p.step})` : ""}: ${p.reason}. Resume: sequence-resume-${p.row.contact_id}`)),
        "Resuming runs every check again before the next step goes.",
      ].join("\n"),
    );
  }
  if (touches.length > 0) await notify(deps, manualTouchText(touches));
  if (report && report.submitted > 0 && auto) {
    await notify(deps, `Follow-ups went out automatically (${mode.reason === "flag" ? OUTREACH_FLAGS.autoApprove : `cold_batch at level ${mode.level}`}): ${sendLine(report)}.`);
  }

  const extra = [...(reviewNote ? [reviewNote] : []), ...(manifest ? [`release with ${releaseCommand(manifest)}`] : [])];
  return done("ran", summarize(counts, extra), { ...(manifest ? { manifest } : {}), ...(report ? { send: report } : {}) });
}

/** The step-1 template angles: from the served templates, then the templates table. Bookkeeping: unknown is none. */
async function firstAngles(db: D1Database, served: readonly ServedTemplate[], ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of served) out.set(t.id, t.meta.angle);
  const missing = [...new Set(ids.filter((id): id is string => typeof id === "string" && !out.has(id)))];
  for (let i = 0; i < missing.length; i += 90) {
    const chunk = missing.slice(i, i + 90);
    try {
      const { results } = await db.prepare(`SELECT id, angle FROM templates WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(", ")})`).bind(...chunk).all<{ id: string; angle: string | null }>();
      for (const r of results) out.set(r.id, r.angle ?? "none");
    } catch {
      // Unknown angles fall back to templates written for every angle.
    }
  }
  return out;
}

function releaseText(manifest: Manifest, drafts: readonly ManifestDraft[], reviewNote: string, quality: string): string {
  const shown = drafts.filter((d) => Object.hasOwn(manifest.entries, d.id));
  const header = [`Follow-ups waiting for your release: ${shown.length} step(s), each threaded under its first email.`, ...(quality ? [`Quality: ${quality}${reviewNote ? `; ${reviewNote}` : ""}.`] : reviewNote ? [`${reviewNote}.`] : [])];
  const footer = [
    `To send exactly these ${shown.length} follow-up(s), reply with:`,
    releaseCommand(manifest),
    `The code confirms this set and works for ${SEQUENCE_LIMITS.releaseMaxAgeHours} hours. Every step is checked again before it goes (a reply from anyone at the account stops it), and one edited since this message is refused.`,
  ];
  for (const max of [900, 500, 250, 0]) {
    const samples = max > 0 ? renderSamples(shown.map((d) => ({ ...d, body: d.body.length > max ? `${d.body.slice(0, max)}\n[...]` : d.body }))) : "";
    const text = [...header, ...(samples ? ["", samples] : []), "", ...footer].join("\n");
    if (text.length <= OPERATOR_TEXT_MAX || max === 0) return text;
  }
  return [...header, "", ...footer].join("\n");
}
