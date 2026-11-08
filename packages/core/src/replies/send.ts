// GTM-agents: sending an approved reply.
//
//   const result = await sendApprovedReply(deps, draftId);
//
// In order, failing closed at every step:
//   1. the draft is a reply, approved, and its content still hashes to the approved digest;
//   2. a send lock is claimed in the effects ledger, so two approvals or runs never send it twice;
//   3. freshness (freshness.ts): what was shown, no mailbox draft, no newer message, nothing already
//      sent on the thread, the mailbox readable;
//   4. the provider boundary sends it, path "reply", through the warm mailbox on the message's
//      thread. The boundary runs the halt, suppression, the content lint, the approved-digest check
//      and the exactly-once claim itself; a reply never goes through the cold email provider.
// After a send: the message is marked responded, and the decision is recorded as autonomy evidence
// (approved_unchanged when the approved text is the text the writer produced, approved_edited
// otherwise). A refusal says why and what to do. Nothing that might have been sent is ever retried:
// an uncertain provider answer keeps the lock.
import type { GtmConfig } from "../config/schema.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { verifyApproval, type DraftStatus, type ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { createOutreachSender } from "../sending/boundary.ts";
import { SEND_EFFECT } from "../sending/ledger.ts";
import type { SendOutreach } from "../sending/types.ts";
import type { KvStore } from "../shared/kv.ts";
import { closeReplyEvidence, recordReplyEvidence, type ReplyEvidence } from "./evidence.ts";
import { checkFreshness, type FreshnessRefusal } from "./freshness.ts";
import { mailboxCan } from "./mailbox.ts";
import { inboundColumns, type InboundRow } from "./rows.ts";

export const SEND_LOCK_EFFECT = "reply_send_lock";
/** One lock per draft and approved content: re-approving an edited draft takes a fresh lock. */
export const sendLockKey = (draftId: string, digest = "") => `reply_send:${draftId}${digest ? `:${digest.slice(0, 16)}` : ""}`;
/** A lock this old whose message the send function never claimed was left by an attempt that died before sending. */
export const STALE_SEND_LOCK_MS = 15 * 60_000;
const replyKey = (draftId: string, digest: string) => `reply:${draftId}:${digest.slice(0, 16)}`;

/**
 * Take the send lock. When it is already held, it is taken over only if it is older than
 * STALE_SEND_LOCK_MS and the send function never claimed this message (event_effects, email_send):
 * the earlier attempt stopped before anything could leave. A claimed message is never retried,
 * because it may have been sent.
 */
async function takeSendLock(db: D1Database, draftId: string, digest: string, now: Date): Promise<"locked" | "busy" | "maybe_sent"> {
  const key = sendLockKey(draftId, digest);
  if (await claimEffect(db, key, SEND_LOCK_EFFECT)) return "locked";
  const [lock, claimed] = await Promise.all([
    db.prepare("SELECT created_at FROM event_effects WHERE event_id = ?1 AND effect = ?2").bind(key, SEND_LOCK_EFFECT).first<{ created_at: string }>(),
    db.prepare("SELECT 1 AS one FROM event_effects WHERE event_id = ?1 AND effect = ?2").bind(replyKey(draftId, digest), SEND_EFFECT).first<{ one: number }>(),
  ]);
  if (claimed) return "maybe_sent";
  if (!lock || !(now.getTime() - Date.parse(lock.created_at) > STALE_SEND_LOCK_MS)) return "busy";
  const taken = await db
    .prepare("UPDATE event_effects SET created_at = ?3 WHERE event_id = ?1 AND effect = ?2 AND created_at = ?4")
    .bind(key, SEND_LOCK_EFFECT, now.toISOString(), lock.created_at)
    .run();
  return (taken.meta.changes ?? 0) === 1 ? "locked" : "busy";
}

export interface ReplySenderDeps {
  db: D1Database;
  /** Holds the halt and the kill switch for the send function. Missing counts as halted. */
  kv: KvStore | undefined | null;
  /** Where approval shown records live: the KV namespace. */
  shown: ShownStore;
  flags?: FlagReader;
  config: Pick<GtmConfig, "company" | "sending"> & Partial<Pick<GtmConfig, "sequences">>;
  /** The warm mailbox: reads the thread and sends the reply. Without it, nothing is sent. */
  inbox?: InboxProvider;
  unsubscribeSigningKey: string | undefined;
  baseUrl: string | undefined;
  operator?: OperatorChannel;
  now?: () => Date;
  log?: JobLogger;
  /** The send function. Defaults to the provider boundary with the warm mailbox and no email provider. */
  send?: SendOutreach;
}

export type ReplySendResult =
  | { status: "sent"; draftId: string; inboundId: string; providerMessageId: string; evidence: ReplyEvidence }
  /** Not sent, and it will not be with this approval. `reason` names the check. */
  | { status: "refused"; draftId: string; reason: FreshnessRefusal | "not_found" | "not_reply" | "not_approved" | "already_sent" | "in_progress" | "maybe_sent" | "blocked"; message: string }
  /** Not sent; it may go later (the system is halted, delivery is off, the mailbox is unreadable). */
  | { status: "held"; draftId: string; message: string }
  /** It may have been sent: never retried automatically. */
  | { status: "failed"; draftId: string; message: string };

interface DraftRow {
  id: string;
  contact_id: string | null;
  kind: string;
  recipient_email: string | null;
  subject: string | null;
  body: string | null;
  status: DraftStatus;
  approved_digest: string | null;
  action_class: string | null;
  notes: string | null;
}

/** The writer's digest recorded in a reply draft's notes, or null. */
export function generatedDigest(notes: string | null): string | null {
  try {
    const parsed = JSON.parse(notes ?? "") as { generated_digest?: unknown };
    return typeof parsed.generated_digest === "string" ? parsed.generated_digest : null;
  } catch {
    return null;
  }
}

export async function sendApprovedReply(deps: ReplySenderDeps, draftId: string): Promise<ReplySendResult> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log;
  const refused = (reason: Extract<ReplySendResult, { status: "refused" }>["reason"], message: string): ReplySendResult => ({ status: "refused", draftId, reason, message });
  const held = (message: string): ReplySendResult => ({ status: "held", draftId, message });

  let draft: DraftRow | null;
  let inbound: InboundRow | null;
  try {
    draft = await deps.db
      .prepare("SELECT id, contact_id, kind, recipient_email, subject, body, status, approved_digest, action_class, notes FROM drafts WHERE id = ?1")
      .bind(draftId)
      .first<DraftRow>();
    inbound = draft ? await deps.db.prepare(`SELECT ${inboundColumns()} FROM inbound_emails WHERE draft_id = ?1 LIMIT 1`).bind(draftId).first<InboundRow>() : null;
  } catch (error) {
    return held(`the draft could not be read (${sanitizeErrorMessage(error)}); nothing was sent.`);
  }
  if (!draft) return refused("not_found", "that draft does not exist.");
  if (draft.kind !== "reply" || !inbound) return refused("not_reply", "that draft is not a reply to an inbound message.");
  if (draft.status === "sent") return refused("already_sent", "that reply was already sent.");
  if (draft.status !== "approved" || !(await verifyApproval({ to: draft.recipient_email, subject: draft.subject, body: draft.body, status: draft.status, approved_digest: draft.approved_digest }))) {
    return refused("not_approved", "that reply is not approved in its current form; approve it first.");
  }
  if (!draft.contact_id || !draft.recipient_email || draft.subject === null || draft.body === null) return refused("not_reply", "that draft has no contact, recipient, subject or body.");
  if (!mailboxCan(deps.inbox, "send")) return held("no connected mailbox can send replies. Send it from your mail client, then mark it answered with /reply_done.");

  const lockDigest = draft.approved_digest as string;
  let lock: "locked" | "busy" | "maybe_sent";
  try {
    lock = await takeSendLock(deps.db, draftId, lockDigest, now);
  } catch (error) {
    return held(`the send lock could not be taken (${sanitizeErrorMessage(error)}); nothing was sent.`);
  }
  if (lock === "maybe_sent") return refused("maybe_sent", "an earlier attempt handed this reply to the mailbox and may have sent it, so it is not sent again. Check the thread in your mail client, then mark it with /reply_done or /reply_ignore.");
  if (lock === "busy") return refused("in_progress", "that reply is being sent right now; check again in a few minutes.");
  const unlock = () => releaseEffect(deps.db, sendLockKey(draftId, lockDigest), SEND_LOCK_EFFECT);

  const content = { to: draft.recipient_email, subject: draft.subject, body: draft.body };
  const fresh = await checkFreshness({ db: deps.db, shown: deps.shown, inbox: deps.inbox }, { draftId, content, inbound });
  if (!fresh.ok) {
    await unlock();
    if (fresh.reason === "unverifiable") return held(fresh.message);
    await settleRefusal(deps, draft, inbound, fresh.reason, now);
    return refused(fresh.reason, fresh.message);
  }

  const send =
    deps.send ??
    createOutreachSender({
      db: deps.db,
      kv: deps.kv,
      ...(deps.flags ? { flags: deps.flags } : {}),
      config: deps.config,
      provider: undefined,
      mailbox: deps.inbox,
      unsubscribeSigningKey: deps.unsubscribeSigningKey,
      baseUrl: deps.baseUrl,
      ...(deps.operator ? { operator: deps.operator } : {}),
      now: () => now,
      ...(log ? { log } : {}),
    });
  const digest = draft.approved_digest as string;
  const [outcome] = await send([
    {
      idempotencyKey: replyKey(draftId, digest),
      path: "reply",
      contactId: draft.contact_id,
      to: draft.recipient_email,
      subject: draft.subject,
      body: draft.body,
      draftId,
      approvedDigest: digest,
      ...(inbound.provider_thread_id ? { threadId: inbound.provider_thread_id } : {}),
      inReplyTo: inbound.message_id ?? inbound.provider_message_id,
    },
  ]);
  if (!outcome) {
    await unlock();
    return held("the send function returned nothing; nothing was sent.");
  }
  switch (outcome.status) {
    case "sent": {
      try {
        await deps.db
          .prepare("UPDATE inbound_emails SET status = 'responded', updated_at = ?2 WHERE id = ?1 AND status IN ('new', 'notified', 'draft_created')")
          .bind(inbound.id, now.toISOString())
          .run();
      } catch (error) {
        log?.warn("a sent reply's message could not be marked responded", { inboundId: inbound.id, error: sanitizeErrorMessage(error) });
      }
      const evidence: ReplyEvidence = generatedDigest(draft.notes) === digest ? "approved_unchanged" : "approved_edited";
      await recordReplyEvidence(deps.db, { draftId, actionClass: draft.action_class, outcome: evidence, detail: "approved in chat, sent from the mailbox", now });
      return { status: "sent", draftId, inboundId: inbound.id, providerMessageId: outcome.providerMessageId, evidence };
    }
    case "duplicate":
      return refused("already_sent", "a reply with this exact content was already sent.");
    case "deferred":
      await unlock();
      return held(`it is held (${outcome.reason}); approve again, or run /reply_send, once that clears.`);
    case "blocked":
      await unlock();
      return refused("blocked", outcome.message);
    case "failed":
      if (outcome.retryable) {
        await unlock();
        return held(outcome.message);
      }
      // The mailbox definitely refused it, and the boundary released its claim: nothing went out.
      if (outcome.message.startsWith("[SEND BLOCKED:provider_rejected]")) {
        await unlock();
        return refused("blocked", outcome.message);
      }
      return { status: "failed", draftId, message: outcome.message };
  }
}

/**
 * What a freshness refusal leaves behind. Shown text that changed goes back for approval; a draft
 * a newer message overtook, or one already answered on the thread, is closed (no evidence: the
 * decision was not about its text). A mailbox draft is left for the mailbox reconciliation.
 */
async function settleRefusal(deps: ReplySenderDeps, draft: DraftRow, inbound: InboundRow, reason: FreshnessRefusal, now: Date): Promise<void> {
  const at = now.toISOString();
  try {
    if (reason === "not_shown") {
      await deps.db
        .prepare("UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'approved'")
        .bind(draft.id, at)
        .run();
    } else if (reason === "newer_message" || reason === "already_answered") {
      await closeReplyEvidence(deps.db, draft.id);
      await deps.db.batch([
        deps.db.prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status IN ('pending_approval', 'approved')").bind(draft.id, at),
        deps.db
          .prepare("UPDATE inbound_emails SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('new', 'notified', 'draft_created')")
          .bind(inbound.id, reason === "already_answered" ? "responded" : "archived", at),
      ]);
    }
  } catch (error) {
    deps.log?.warn("a refused reply could not be settled", { draftId: draft.id, reason, error: sanitizeErrorMessage(error) });
  }
}
