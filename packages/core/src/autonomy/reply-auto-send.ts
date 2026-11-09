// GTM-agents: automatic replies: the auto-send rules, and sending a reply that passes all of them.
//
// A reply goes out without a person only when its class has earned it and every auto-send rule
// passes (auto-send-rules.ts: fourteen rules, one pure function, failing closed on any missing
// input). This module gathers the rules' inputs, runs the model reviewer for the last rule, and
// sends.
//
// Then autoSendReply approves the draft for the code, bound to its digest (approved_by
// auto:autonomy:<class>:L<level>, and the digest recorded as what was shown, so freshness checks
// hold the send to exactly that text), and sends it through sendApprovedReply: the send lock,
// freshness, and the send function with every gate it runs. A send records auto_sent evidence and
// tells the operator after the fact. Anything else returns the draft to review, and the caller asks
// a person as usual; an answer that leaves it unclear whether the reply went out is never retried.
import { approvedClaimLines } from "../quality/claims.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { QualityResult } from "../quality/gate.ts";
import { reviewOutbound, withReview, type ReviewSample, type ReviewSpend, type ReviewVerdict } from "../quality/reviewer.ts";
import type { ContactRow, InboundRow, StoredTriage } from "../replies/rows.ts";
import type { Qualification } from "../replies/qualify.ts";
import type { ReplyActionClass } from "../replies/evidence.ts";
import { sendApprovedReply } from "../replies/send.ts";
import { draftDigest, markShown, type ShownStore } from "../security/approval-digest.ts";
import { readHalt } from "../security/halt.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { readColdPause } from "../sending/kill-switch.ts";
import { normalizeAddress } from "../sending/suppression.ts";
import type { SendOutreach } from "../sending/types.ts";
import type { KvStore } from "../shared/kv.ts";
import { AUTONOMY_FLAGS, readFlagState } from "./flags.ts";
import { autoSendPrecheck, competitorNames, decideReplyAutoSend, REVIEW_FLAG, SEND_FLAG, type AutoSendFailure, type ReplyAutoSendInput } from "./auto-send-rules.ts";
import { readAutonomyLevel } from "./store.ts";
import { senderAuthentication, TRUSTED_AUTHSERV_IDS } from "./sender-auth.ts";
import { readInboundBody } from "../inbox/body.ts";
import { SENDER_TEXT_MAX_CHARS, senderText } from "../replies/text.ts";

export interface ReplyAutoSendDeps {
  db: D1Database;
  /** The KV namespace: the halt, the kill switch and the shown records. */
  kv: (KvStore & ShownStore) | undefined;
  flags: FlagReader;
  config: GtmConfig;
  inbox?: InboxProvider;
  operator?: OperatorChannel;
  chatId?: string;
  model?: ModelGateway;
  spend: ReviewSpend;
  job: string;
  runId?: string;
  /** The brain's judge slice, for the model reviewer. */
  judgeBrain: () => Promise<string>;
  /**
   * The authserv-ids trusted per inbox provider, for sender authentication (sender-auth.ts).
   * Defaults to TRUSTED_AUTHSERV_IDS.
   */
  trustedAuthservIds?: Readonly<Record<string, readonly string[]>>;
  /** Blob storage, to check the rules read the sender's whole text. Without it, nothing is sent. */
  bucket?: Pick<R2Bucket, "get">;
  unsubscribeSigningKey?: string;
  baseUrl?: string;
  now: Date;
  log: JobLogger;
  /** The send function. Defaults to the provider boundary with the warm mailbox. */
  send?: SendOutreach;
  /** Replaces the model reviewer call (tests). */
  review?: (sample: ReviewSample) => Promise<ReviewVerdict | null>;
}

/** What the drafter hands over: the stored draft and everything it was written from. */
export interface ReplyAutoSendCandidate {
  row: InboundRow;
  triage: StoredTriage;
  contact: ContactRow;
  /** The sender's own text. */
  sender: string;
  qualification: Qualification | null;
  draftId: string;
  subject: string;
  body: string;
  actionClass: ReplyActionClass;
  /** The deterministic gate's result for the draft. */
  quality: QualityResult;
  assetUrls: readonly string[];
  /** The replies brain slice the draft was written from. */
  brainText: string;
}

export type AutoSendOutcome = "sent" | "not_sent" | "uncertain";

export interface AutoSendResult {
  outcome: AutoSendOutcome;
  failures: AutoSendFailure[];
  message?: string;
}

function parseHeaders(raw: string | null | undefined): Record<string, string> | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[k.toLowerCase()] = v;
    return out;
  } catch {
    return null;
  }
}

/**
 * True only when the text the rules read is the sender's whole text: the stored body could be read,
 * it is the text drafting used, and the reading limit did not cut it. A preview never counts.
 */
async function wholeText(deps: ReplyAutoSendDeps, c: ReplyAutoSendCandidate): Promise<boolean | null> {
  if (!deps.bucket || !c.row.body_key) return false;
  try {
    const body = await readInboundBody(deps.bucket, c.row.body_key);
    if (body === null) return false;
    const whole = senderText(body, Number.MAX_SAFE_INTEGER);
    return whole.length <= SENDER_TEXT_MAX_CHARS && whole === c.sender;
  } catch {
    return null;
  }
}

async function readPaused(kv: Pick<KvStore, "get"> | undefined): Promise<boolean | null> {
  try {
    const [halt, pause] = await Promise.all([readHalt(kv), readColdPause(kv)]);
    return halt.halted || pause.paused;
  } catch {
    return null;
  }
}

async function gather(deps: ReplyAutoSendDeps, c: ReplyAutoSendCandidate, quality: QualityResult | null): Promise<ReplyAutoSendInput> {
  const [tier, send, review, reading, paused] = await Promise.all([
    readFlagState(deps.flags, AUTONOMY_FLAGS.replyAutoSend),
    readFlagState(deps.flags, SEND_FLAG),
    readFlagState(deps.flags, REVIEW_FLAG),
    readAutonomyLevel({ flags: deps.flags, db: deps.db, config: deps.config }, c.actionClass),
    readPaused(deps.kv),
  ]);
  let headers: Record<string, string> | null;
  let emailedBefore: boolean | null;
  try {
    const row = await deps.db.prepare("SELECT headers FROM inbound_emails WHERE id = ?1").bind(c.row.id).first<{ headers: string | null }>();
    headers = parseHeaders(row?.headers ?? null);
    const sent = await deps.db
      .prepare("SELECT 1 AS hit FROM outreach_sends WHERE contact_id = ?1 AND send_path IN ('cold', 'sequence') AND sent_at <= ?2 LIMIT 1")
      .bind(c.contact.id, c.row.received_at)
      .first();
    emailedBefore = sent !== null;
  } catch {
    headers = null;
    emailedBefore = null;
  }
  return {
    switches: { tier, send, review },
    level: reading.error ? null : reading.level,
    actionClass: c.actionClass,
    paused,
    message: { classification: c.row.classification, emailedBefore, sender: c.row.sender_email, headers, authenticated: senderAuthentication({ header: headers?.["authentication-results"], sender: c.row.sender_email, trustedIds: (deps.trustedAuthservIds ?? TRUSTED_AUTHSERV_IDS)[c.row.provider] ?? [] }).ok, text: c.sender, subject: c.row.subject, complete: await wholeText(deps, c) },
    contact: { email: c.contact.email },
    triage: { intent: c.triage.intent, confidence: c.triage.confidence, proposedTime: c.triage.proposed_time, assetRequested: c.triage.asset_requested },
    qualification: c.qualification ? { proposedTime: c.qualification.proposedTime } : null,
    draft: { to: c.contact.email, subject: c.subject, body: c.body },
    links: { bookingUrl: deps.config.sending.bookingUrl ?? null, assetUrls: c.assetUrls },
    facts: approvedClaimLines(c.brainText),
    competitors: competitorNames(c.brainText),
    quality,
  };
}

async function tell(deps: ReplyAutoSendDeps, text: string): Promise<void> {
  if (!deps.operator) return;
  const chat = deps.chatId ?? deps.config.operator.allowedChatIds[0];
  try {
    await deps.operator.notify({ text, ...(chat ? { chatId: chat } : {}) });
  } catch {
    deps.log.warn("an automatic reply notice could not be sent");
  }
}

/** Return the draft to review if the code approved it and it did not go out. Never throws. */
async function returnToReview(deps: ReplyAutoSendDeps, draftId: string): Promise<void> {
  try {
    await deps.db
      .prepare("UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'approved' AND approved_by LIKE 'auto:%'")
      .bind(draftId, deps.now.toISOString())
      .run();
  } catch (error) {
    deps.log.warn("an automatically approved reply could not be returned to review", { draftId, error: sanitizeErrorMessage(error) });
  }
}

/**
 * Send one drafted reply automatically when every rule passes. "not_sent" leaves the draft pending
 * for the caller to ask a person; "uncertain" means it may have gone out, so nobody is asked to
 * send it again and the operator is told to check the mailbox. Never throws.
 */
export async function autoSendReply(deps: ReplyAutoSendDeps, c: ReplyAutoSendCandidate): Promise<AutoSendResult> {
  const notSent = (failures: AutoSendFailure[], message?: string): AutoSendResult => ({ outcome: "not_sent", failures, ...(message ? { message } : {}) });
  let handedOver = false;
  try {
    const pre = autoSendPrecheck(await gather(deps, c, null));
    if (!pre.ok) return notSent(pre.failures);

    // 14. The full quality gate: the model reviewer on top of the deterministic gate.
    const sample: ReviewSample = { key: c.draftId, kind: "reply", subject: c.subject, body: c.body, context: `reply, ${c.actionClass}` };
    let verdict: ReviewVerdict | null;
    if (deps.review) verdict = await deps.review(sample);
    else {
      const review = await reviewOutbound(
        { model: deps.model, config: deps.config, brain: await deps.judgeBrain(), spend: deps.spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), log: deps.log },
        [sample],
      );
      verdict = review.ok ? (review.verdicts[0] ?? null) : null;
    }
    const quality = withReview(c.quality, verdict, "the reviewer could not run, so the reply waits for a person");
    // Everything is read again after the review, which takes time: a demotion or a pause in between stops it.
    const decision = decideReplyAutoSend(await gather(deps, c, quality));
    if (!decision.ok) return notSent(decision.failures);
    const level = (await readAutonomyLevel({ flags: deps.flags, db: deps.db, config: deps.config }, c.actionClass)).level;
    if (level < 2) return notSent([{ rule: 1, reason: `${c.actionClass} is at level ${level}` }]);

    // Approve for the code, bound to the digest, and record that digest as what was approved.
    const content = { to: c.contact.email, subject: c.subject, body: c.body };
    const digest = await draftDigest(content);
    if (!deps.kv || !(await markShown(deps.kv, c.draftId, content))) return notSent([], "the approved text could not be recorded");
    const at = deps.now.toISOString();
    const approved = await deps.db
      .prepare(
        `UPDATE drafts SET status = 'approved', approved_digest = ?2, approved_at = ?3, approved_by = ?4, updated_at = ?3
          WHERE id = ?1 AND status = 'pending_approval' AND kind = 'reply' AND recipient_email IS ?5 AND subject IS ?6 AND body IS ?7`,
      )
      .bind(c.draftId, digest, at, `auto:autonomy:${c.actionClass}:L${level}`, content.to, content.subject, content.body)
      .run();
    if ((approved.meta.changes ?? 0) !== 1) return notSent([], "the draft changed or was decided before it could be approved");
    // A demotion recorded before the approval landed would not have returned this draft: read the
    // level once more now that it is approved. One recorded after this read returns it itself.
    const after = await readAutonomyLevel({ flags: deps.flags, db: deps.db, config: deps.config }, c.actionClass);
    if (after.level < 2 || after.demoted) {
      await returnToReview(deps, c.draftId);
      return notSent([{ rule: 1, reason: `${c.actionClass} dropped to level ${after.level} while it was being approved` }]);
    }

    handedOver = true;
    const result = await sendApprovedReply(
      {
        db: deps.db,
        kv: deps.kv,
        shown: deps.kv,
        flags: deps.flags,
        config: deps.config,
        ...(deps.inbox ? { inbox: deps.inbox } : {}),
        unsubscribeSigningKey: deps.unsubscribeSigningKey,
        baseUrl: deps.baseUrl,
        ...(deps.operator ? { operator: deps.operator } : {}),
        now: () => deps.now,
        log: deps.log,
        ...(deps.send ? { send: deps.send } : {}),
      },
      c.draftId,
    );
    const who = normalizeAddress(c.row.sender_email) ?? "the sender";
    if (result.status === "sent") {
      await tell(
        deps,
        [
          `Sent automatically: a reply to ${who} (${c.actionClass} at level ${level}; ${c.triage.intent} at ${c.triage.confidence.toFixed(2)}).`,
          `Subject: ${c.subject}`,
          "",
          c.body,
          "",
          `Every auto-send rule and the quality gate passed. To have ${c.actionClass} ask first again, send autonomy-set ${c.actionClass} 1.`,
        ].join("\n"),
      );
      return { outcome: "sent", failures: [] };
    }
    // It may have gone out, or another run is sending it now: never returned to review, never sent again.
    if (result.status === "failed" || (result.status === "refused" && (result.reason === "maybe_sent" || result.reason === "in_progress" || result.reason === "already_sent"))) {
      await tell(deps, `An automatic reply to ${who} may already have gone out (${result.message}). It is not sent again: check the thread in your mailbox, then mark it with /reply_done or /reply_ignore if it is still owed.`);
      return { outcome: "uncertain", failures: [], message: result.message };
    }
    await returnToReview(deps, c.draftId);
    return notSent([], result.message);
  } catch (error) {
    if (handedOver) {
      // The send may have started: never asked for again, never retried.
      deps.log.error("an automatic reply failed after it was handed to the send path; it is not sent again", { draftId: c.draftId, error: sanitizeErrorMessage(error) });
      await tell(deps, `An automatic reply to ${normalizeAddress(c.row.sender_email) ?? "the sender"} may or may not have gone out. It is not sent again: check the thread in your mailbox.`);
      return { outcome: "uncertain", failures: [], message: sanitizeErrorMessage(error) };
    }
    deps.log.warn("an automatic reply was not sent; it waits for a person", { draftId: c.draftId, error: sanitizeErrorMessage(error) });
    await returnToReview(deps, c.draftId);
    return notSent([], sanitizeErrorMessage(error));
  }
}
