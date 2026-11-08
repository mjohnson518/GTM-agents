// GTM-agents: the reply outbox: approved reply drafts go out from the warm mailbox.
//
// An approval in chat (operator/approvals.ts) marks a draft approved and sends nothing. This run
// picks up approved reply drafts and hands each to sendApprovedReply, which checks freshness and
// sends through the provider boundary. Then:
//   - sent: the operator is told;
//   - refused or failed: the operator is told why, once for that approval (claimed per draft and
//     approved digest), and the draft is not tried again until it is approved again. A refusal
//     because the shown text changed sends a fresh approval request;
//   - held (halted, delivery off, the mailbox unreadable): tried again next run, and the operator is
//     told at most once a day per draft.
// It also records rejected evidence for reply drafts rejected in chat. No model calls.
import { claimEffect } from "../events/effects.ts";
import { requestDraftApproval } from "../operator/approvals.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { EVIDENCE_OPEN_SQL, recordReplyEvidence } from "./evidence.ts";
import { daysAgo } from "./rows.ts";
import { sendApprovedReply, type ReplySendResult, type ReplySenderDeps } from "./send.ts";

const OUTCOME_EFFECT = "reply_send_outcome";
const HELD_EFFECT = "reply_send_held";
const WINDOW_DAYS = 14;

export interface OutboxDeps extends ReplySenderDeps {
  /** Where notices go; the channel's default chat when omitted. */
  chatId?: string;
  maxRows: number;
}

export interface OutboxResult {
  sent: number;
  refused: number;
  held: number;
  failed: number;
  rejectedRecorded: number;
}

/** The operator's line for a send result. */
export function describeSend(result: ReplySendResult, recipient: string): string {
  switch (result.status) {
    case "sent":
      return `Sent your reply to ${recipient} from the mailbox (draft ${result.draftId}).`;
    case "refused":
      return `The reply to ${recipient} was not sent (draft ${result.draftId}): ${result.message}`;
    case "held":
      return `The reply to ${recipient} is waiting (draft ${result.draftId}): ${result.message}`;
    case "failed":
      return `The reply to ${recipient} may or may not have gone out (draft ${result.draftId}), so it will not be retried: ${result.message} Check the mailbox's sent folder.`;
  }
}

export async function runOutbox(deps: OutboxDeps): Promise<OutboxResult> {
  const now = deps.now?.() ?? new Date();
  const result: OutboxResult = { sent: 0, refused: 0, held: 0, failed: 0, rejectedRecorded: 0 };
  const tell = async (text: string): Promise<boolean> => {
    if (!deps.operator) return false;
    try {
      await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
      return true;
    } catch (error) {
      deps.log?.warn("an outbox notice could not be sent", { error: sanitizeErrorMessage(error) });
      return false;
    }
  };

  // Rejections made in chat are evidence for the draft's class.
  const { results: rejected } = await deps.db
    .prepare(`SELECT d.id, d.action_class FROM drafts d WHERE d.kind = 'reply' AND d.status = 'rejected' AND d.updated_at >= ?1 AND ${EVIDENCE_OPEN_SQL} LIMIT 50`)
    .bind(daysAgo(now, WINDOW_DAYS))
    .all<{ id: string; action_class: string | null }>();
  for (const row of rejected) {
    if (await recordReplyEvidence(deps.db, { draftId: row.id, actionClass: row.action_class, outcome: "rejected", detail: "rejected in chat", now })) result.rejectedRecorded += 1;
  }

  const { results: approved } = await deps.db
    .prepare(
      `SELECT d.id, d.recipient_email, d.approved_digest FROM drafts d
        WHERE d.kind = 'reply' AND d.status = 'approved' AND d.approved_digest IS NOT NULL AND d.updated_at >= ?1
          AND EXISTS (SELECT 1 FROM inbound_emails i WHERE i.draft_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'reply_send_outcome:' || d.id || ':' || substr(d.approved_digest, 1, 16) AND ee.effect = ?2)
        ORDER BY d.approved_at ASC LIMIT ?3`,
    )
    .bind(daysAgo(now, WINDOW_DAYS), OUTCOME_EFFECT, deps.maxRows)
    .all<{ id: string; recipient_email: string | null; approved_digest: string }>();
  for (const draft of approved) {
    const send = await sendApprovedReply(deps, draft.id);
    const recipient = draft.recipient_email ?? "(no recipient)";
    if (send.status === "held") {
      result.held += 1;
      try {
        if (await claimEffect(deps.db, `reply_send_held:${draft.id}:${now.toISOString().slice(0, 10)}`, HELD_EFFECT)) await tell(describeSend(send, recipient));
      } catch {
        // Bookkeeping: the notice is skipped; the send is retried next run regardless.
      }
      continue;
    }
    // Another attempt is sending it right now: nothing to say.
    if (send.status === "refused" && send.reason === "in_progress") continue;
    if (send.status === "refused" && send.reason === "maybe_sent") {
      // Tell the operator once per draft, so a reply that may have gone out is never silently stuck.
      try {
        if (await claimEffect(deps.db, `reply_send_stuck:${draft.id}:${draft.approved_digest.slice(0, 16)}`, HELD_EFFECT)) await tell(describeSend(send, recipient));
      } catch {
        // Bookkeeping: the notice is skipped.
      }
      continue;
    }
    if (send.status === "sent") result.sent += 1;
    else if (send.status === "refused") result.refused += 1;
    else result.failed += 1;
    try {
      await claimEffect(deps.db, `reply_send_outcome:${draft.id}:${draft.approved_digest.slice(0, 16)}`, OUTCOME_EFFECT);
    } catch {
      // Bookkeeping: a refused draft may be tried, and refused, once more.
    }
    await tell(describeSend(send, recipient));
    if (send.status === "refused" && send.reason === "not_shown" && deps.operator && deps.chatId) {
      const again = await requestDraftApproval({ db: deps.db, shown: deps.shown, operator: deps.operator, now: () => now }, draft.id, deps.chatId);
      if (!again.ok) deps.log?.warn("a fresh approval request could not be sent", { draftId: draft.id, reason: again.reason });
    }
  }
  return result;
}
