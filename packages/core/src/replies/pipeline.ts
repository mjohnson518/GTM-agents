// GTM-agents: one run of reply handling's model-backed work: triage, routing, the qualifier and
// drafting.
//
// In order, within the job's ceilings (rows, spend and time):
//   1. route messages triaged earlier whose routing did not finish (an opt-out that failed to
//      write), so the compliance control is retried, however old the message. The operator is told
//      once when an opt-out could not be written. No model call;
//   2. triage new human mail (reply, new_inquiry, unclassified; intent not set; under 14 days old),
//      oldest first. Each message is tried at most once per UTC day (claimed in the effects
//      ledger), unless the attempt never reached a model (no model, no price, budget refused),
//      which is released and tried again next run. Then route it, and run the meeting qualifier
//      for an interested reply or a question from a known contact;
//   3. with replies:drafting_enabled on, draft every routed message that may have one and has
//      none yet: this run's, and earlier ones (drafting turned on later, or a writer that failed),
//      at most one attempt per message per UTC day, for messages under 14 days old.
// Model spend goes through one spend gate for the run (the job's daily cap, the global limits,
// the run ceiling). The body is read from blob storage once per step; a body that is gone falls
// back to the row's short preview.
// With inbound:auto_send_tier on, each new draft is offered to the auto-send tier before its
// approval request (autonomy/reply-auto-send.ts); it goes out only when every auto-send rule and
// the class's earned level allow it.
import { loadBrain, type KVReader } from "../brain/load.ts";
import type { GtmConfig } from "../config/schema.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import { readInboundBody } from "../inbox/body.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { voiceAvoidPhrases } from "../quality/claims.ts";
import { CLICHE_LINT_FLAG } from "../quality/gate.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { loadSourcingBrain, type PersonaRule } from "../sourcing/brain.ts";
import { createSpendGate } from "../sourcing/spend.ts";
import { draftReply, loadReplyAssets, WRITER_TIMEOUT_MS, type DraftContext } from "./draft.ts";
import { REPLY_FLAGS, replyFlagOn } from "./flags.ts";
import { brainObjections } from "./objections.ts";
import { qualifyReply, saveQualification, type Qualification } from "./qualify.ts";
import { routeReply, ROUTED_SQL, noDraftReason, type RouteDeps, type RouteResult } from "./route.ts";
import { daysAgo, inboundColumns, loadContact, parseStoredTriage, replyEventId, type ContactRow, type InboundRow, type StoredTriage } from "./rows.ts";
import { senderLabel, senderText } from "./text.ts";
import { TRIAGE_TIMEOUT_MS, triageText } from "./triage.ts";
import { AUTONOMY_FLAGS } from "../autonomy/flags.ts";
import { autoSendReply } from "../autonomy/reply-auto-send.ts";
import type { KvStore } from "../shared/kv.ts";

export const TRIAGE_WINDOW_DAYS = 14;
export const DRAFT_WINDOW_DAYS = 14;
const ATTEMPT_EFFECT = "reply_triage_attempt";
const DRAFT_EFFECT = "reply_draft_attempt";
const DRAFTABLE = ["interested", "question", "objection", "warm", "referral", "not_a_fit"] as const;

export interface PipelineDeps {
  db: D1Database;
  /** The KV namespace: the brain, and approval shown records. */
  kv: (KVReader & ShownStore) | undefined;
  bucket: Pick<R2Bucket, "get"> | undefined;
  flags: FlagReader;
  config: GtmConfig;
  model?: ModelGateway;
  inbox?: InboxProvider;
  operator?: OperatorChannel;
  approvalChatId?: string;
  job: string;
  runId?: string;
  signal?: AbortSignal;
  now: Date;
  log: JobLogger;
  /** Messages triaged or drafted per run. */
  maxRows: number;
  /** The job's daily model spend cap, in cents. */
  maxSpendCents?: number;
  triageTimeoutMs?: number;
  writerTimeoutMs?: number;
  /** The KV namespace as a store, for automatic replies (the halt, the kill switch, shown records). */
  store?: KvStore & ShownStore;
  /** For automatic replies: the unsubscribe signing key and the deployment's base URL. */
  unsubscribeSigningKey?: string;
  baseUrl?: string;
}

export interface PipelineResult {
  rerouted: number;
  triaged: number;
  triageFailed: number;
  drafted: number;
  blocked: number;
  draftFailed: number;
  /** Drafts the auto-send tier sent. */
  autoSent: number;
  stopped: string | null;
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** The sender's text for a row: the stored body, or the preview when the body is gone. Throws on a storage error. */
async function readSender(deps: PipelineDeps, row: InboundRow): Promise<string> {
  const body = deps.bucket ? await readInboundBody(deps.bucket, row.body_key) : null;
  return senderText(body ?? row.body_preview ?? "");
}

export async function runReplyPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { db, now, log } = deps;
  const result: PipelineResult = { rerouted: 0, triaged: 0, triageFailed: 0, drafted: 0, blocked: 0, draftFailed: 0, autoSent: 0, stopped: null };
  const day = utcDay(now);
  const brain = await loadBrain({ KV: deps.kv ?? { get: () => Promise.resolve(null) } }, "replies");
  const objections = brainObjections(brain.text);
  const routeDeps: RouteDeps = { db, config: deps.config, ...(deps.inbox ? { inbox: deps.inbox } : {}), objections, now, log };
  const spend = createSpendGate({ db, flags: deps.flags, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), ...(deps.maxSpendCents !== undefined ? { jobCapCents: deps.maxSpendCents } : {}), now: () => now, log });
  const modelDeps = { model: deps.model, config: deps.config, spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), log };
  let personas: readonly PersonaRule[] | null = null;
  const loadPersonas = async () => (personas ??= (await loadSourcingBrain(deps.kv)).personas);
  const aborted = () => deps.signal?.aborted === true;
  let modelRows = 0;

  const qualifyFor = async (row: InboundRow, triage: StoredTriage, contact: ContactRow | null): Promise<Qualification | null> => {
    if (!contact || (triage.intent !== "interested" && triage.intent !== "question")) return null;
    try {
      const q = await qualifyReply(db, { triage, contact, personas: await loadPersonas() });
      await saveQualification(db, row.id, contact.id, q, now).catch((error: unknown) => log.warn("a reply qualification could not be saved", { inboundId: row.id, error: sanitizeErrorMessage(error) }));
      return q;
    } catch (error) {
      log.warn("a reply could not be qualified", { inboundId: row.id, error: sanitizeErrorMessage(error) });
      return null;
    }
  };

  // An opt-out that could not be written is retried every run; the operator is told once.
  const routed = async (row: InboundRow, outcome: RouteResult): Promise<void> => {
    if (outcome.complete || !deps.operator) return;
    const key = replyEventId(row.id);
    try {
      if (!(await claimEffect(db, key, "opt_out_alert"))) return;
      try {
        await deps.operator.notify({
          text: `An opt-out from ${senderLabel(row.sender_email)} could not be written yet [${row.id}]. It is retried every run until it lands; no reply goes to them meanwhile.`,
          ...(deps.approvalChatId ? { chatId: deps.approvalChatId } : {}),
        });
      } catch {
        await releaseEffect(db, key, "opt_out_alert");
      }
    } catch {
      // Bookkeeping: the retry happens either way.
    }
  };

  // 1. Routing that did not finish.
  const { results: unrouted } = await db
    .prepare(`SELECT ${inboundColumns("i")} FROM inbound_emails i WHERE i.intent IS NOT NULL AND i.triage IS NOT NULL AND NOT ${ROUTED_SQL} ORDER BY i.received_at ASC LIMIT ?1`)
    .bind(deps.maxRows)
    .all<InboundRow>();
  for (const row of unrouted) {
    if (aborted()) break;
    const triage = parseStoredTriage(row.triage);
    if (!triage) continue;
    let sender: string;
    try {
      sender = await readSender(deps, row);
    } catch {
      continue;
    }
    await routed(row, await routeReply(routeDeps, row, triage, sender, await loadContact(db, row.contact_id)));
    result.rerouted += 1;
  }

  // 2. Triage.
  const { results: untriaged } = await db
    .prepare(
      `SELECT ${inboundColumns("i")} FROM inbound_emails i
        WHERE i.intent IS NULL AND i.status IN ('new', 'notified') AND COALESCE(i.classification, 'unclassified') IN ('reply', 'new_inquiry', 'unclassified')
          AND i.received_at >= ?1
          AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'reply_triage:' || i.id || ':' || ?2 AND ee.effect = ?3)
        ORDER BY i.received_at ASC LIMIT ?4`,
    )
    .bind(daysAgo(now, TRIAGE_WINDOW_DAYS), day, ATTEMPT_EFFECT, deps.maxRows)
    .all<InboundRow>();
  for (const row of untriaged) {
    if (aborted() || modelRows >= deps.maxRows) break;
    if (spend.stopped) {
      result.stopped = spend.stopped;
      break;
    }
    const attempt = `reply_triage:${row.id}:${day}`;
    if (!(await claimEffect(db, attempt, ATTEMPT_EFFECT))) continue;
    let sender: string;
    try {
      sender = await readSender(deps, row);
    } catch (error) {
      await releaseEffect(db, attempt, ATTEMPT_EFFECT);
      log.warn("an inbound body could not be read; triage will retry", { inboundId: row.id, error: sanitizeErrorMessage(error) });
      continue;
    }
    if (sender === "") {
      // Nothing to read (an image or an attachment only): final for this message, which stays
      // untriaged and on the reply-owed clock. Never a reason to stop the run.
      result.triageFailed += 1;
      continue;
    }
    modelRows += 1;
    const outcome = await triageText({ ...modelDeps, timeoutMs: deps.triageTimeoutMs ?? TRIAGE_TIMEOUT_MS }, { inboundId: row.id, classification: row.classification, subject: row.subject, body: sender }, now);
    if (!outcome.ok) {
      result.triageFailed += 1;
      if (!outcome.called) await releaseEffect(db, attempt, ATTEMPT_EFFECT);
      log.warn("a reply stays untriaged for a later retry", { inboundId: row.id, reason: outcome.reason });
      if (!outcome.called) {
        result.stopped = outcome.reason;
        break;
      }
      continue;
    }
    const triage = outcome.result;
    const priority = triage.confidence >= 0.7 && ["interested", "question", "referral"].includes(triage.intent) ? "high" : triage.confidence >= 0.8 && ["spam", "noise", "auto_reply"].includes(triage.intent) ? "low" : "normal";
    const saved = await db
      .prepare("UPDATE inbound_emails SET intent = ?2, triage = ?3, priority = ?4, updated_at = ?5 WHERE id = ?1 AND intent IS NULL")
      .bind(row.id, triage.intent, JSON.stringify(triage), priority, now.toISOString())
      .run();
    if ((saved.meta.changes ?? 0) === 0) continue;
    result.triaged += 1;
    const triagedRow: InboundRow = { ...row, intent: triage.intent, triage: JSON.stringify(triage) };
    const contact = await loadContact(db, row.contact_id);
    await routed(triagedRow, await routeReply(routeDeps, triagedRow, triage, sender, contact));
    await qualifyFor(triagedRow, triage, contact);
  }

  // 3. Drafting.
  if (!(await replyFlagOn(deps.flags, REPLY_FLAGS.drafting)) || result.stopped !== null) return result;
  // The voice's quoted avoid phrases hold a draft only while the cliche lint flag is on.
  const avoidPhrases = (await replyFlagOn(deps.flags, CLICHE_LINT_FLAG)) ? voiceAvoidPhrases(brain.text) : [];
  const context: DraftContext = { brain, objections, assets: await loadReplyAssets(db), ...(avoidPhrases.length > 0 ? { avoidPhrases } : {}) };
  // The auto-send tier, offered only while its flag is on; every rule is checked again per draft.
  const store = deps.store;
  const autoSend =
    store && (await replyFlagOn(deps.flags, AUTONOMY_FLAGS.replyAutoSend))
      ? async (candidate: Parameters<typeof autoSendReply>[1]) =>
          (
            await autoSendReply(
              {
                db,
                kv: store,
                flags: deps.flags,
                config: deps.config,
                ...(deps.inbox ? { inbox: deps.inbox } : {}),
                ...(deps.operator ? { operator: deps.operator } : {}),
                ...(deps.approvalChatId ? { chatId: deps.approvalChatId } : {}),
                ...(deps.model ? { model: deps.model } : {}),
                spend,
                job: deps.job,
                ...(deps.runId ? { runId: deps.runId } : {}),
                ...(deps.bucket ? { bucket: deps.bucket } : {}),
                judgeBrain: async () => (await loadBrain({ KV: deps.kv ?? { get: () => Promise.resolve(null) } }, "judge")).text,
                ...(deps.unsubscribeSigningKey ? { unsubscribeSigningKey: deps.unsubscribeSigningKey } : {}),
                ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
                now,
                log,
              },
              candidate,
            )
          ).outcome
      : undefined;
  const { results: draftable } = await db
    .prepare(
      `SELECT ${inboundColumns("i")} FROM inbound_emails i
        WHERE i.intent IN (${DRAFTABLE.map((d) => `'${d}'`).join(", ")}) AND i.triage IS NOT NULL AND i.status IN ('new', 'notified')
          AND i.draft_id IS NULL AND i.contact_id IS NOT NULL AND i.received_at >= ?1 AND ${ROUTED_SQL}
          AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'reply:' || i.id AND ee.effect = 'draft_blocked')
          AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'reply_draft:' || i.id || ':' || ?2 AND ee.effect = ?3)
        ORDER BY i.received_at ASC LIMIT ?4`,
    )
    .bind(daysAgo(now, DRAFT_WINDOW_DAYS), day, DRAFT_EFFECT, deps.maxRows)
    .all<InboundRow>();
  for (const row of draftable) {
    if (aborted() || modelRows >= deps.maxRows) break;
    if (spend.stopped) {
      result.stopped = spend.stopped;
      break;
    }
    const triage = parseStoredTriage(row.triage);
    const contact = await loadContact(db, row.contact_id);
    if (!triage || !contact) continue;
    let sender: string;
    try {
      sender = await readSender(deps, row);
    } catch (error) {
      log.warn("an inbound body could not be read; drafting will retry", { inboundId: row.id, error: sanitizeErrorMessage(error) });
      continue;
    }
    if (sender === "" || (await noDraftReason(routeDeps, row, triage, contact, sender)) !== null) continue;
    const attempt = `reply_draft:${row.id}:${day}`;
    if (!(await claimEffect(db, attempt, DRAFT_EFFECT))) continue;
    modelRows += 1;
    const qualification = await qualifyFor(row, triage, contact);
    const outcome = await draftReply(
      {
        ...modelDeps,
        timeoutMs: deps.writerTimeoutMs ?? WRITER_TIMEOUT_MS,
        db,
        shown: deps.kv ?? { get: () => Promise.resolve(null), put: () => Promise.reject(new Error("the KV binding is missing")) },
        config: deps.config,
        context,
        ...(deps.operator ? { operator: deps.operator } : {}),
        ...(deps.approvalChatId ? { approvalChatId: deps.approvalChatId } : {}),
        ...(autoSend ? { autoSend } : {}),
        now,
        log,
      },
      { row, triage, contact, sender, qualification, senderLabel: senderLabel(row.sender_email) },
    );
    if (outcome.status === "drafted") {
      result.drafted += 1;
      if (outcome.autoSent) result.autoSent += 1;
    }
    else if (outcome.status === "blocked") result.blocked += 1;
    else {
      result.draftFailed += 1;
      if (!outcome.called) {
        await releaseEffect(db, attempt, DRAFT_EFFECT);
        result.stopped = outcome.reason;
        break;
      }
    }
  }
  return result;
}
