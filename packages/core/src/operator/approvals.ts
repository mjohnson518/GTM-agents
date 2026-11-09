// GTM-agents: draft approvals through the operator channel.
//
// requestDraftApproval reads the draft back from the database (never from model output), sends an
// approval request bound to the digest of exactly that content, and records what was shown with
// markShown. The request never truncates the draft: if a channel cannot show it whole, the request
// fails and nothing is recorded as shown.
//
// handleApprovalCallback runs when the operator taps a button. It trusts nothing in the callback
// but the operator's identity, which the webhook has already verified and allowlisted:
//   1. the payload must parse as an approval id and digest prefix;
//   2. the draft is re-resolved by id from the database;
//   3. the payload's digest must match the draft's current digest, and wasShown must confirm the
//      operator was shown exactly this content (a gate: an unreadable record refuses);
//   4. approveDraft checks the shown digest once more, and the update is a compare-and-set on the
//      status and the content, so an edit that lands in between is not approved.
// Approving marks the draft approved. It never sends anything: sending is a separate path with its
// own gates, and it verifies the approval digest again before relying on it. Each approve or reject
// of a meeting draft is autonomy evidence for its class (autonomy/evidence.ts, recordDraftDecision).
import { recordDraftDecision } from "../autonomy/evidence.ts";
import { approveDraft, draftDigest, markShown, wasShown, type DraftContent, type DraftStatus, type ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { constantTimeEqual } from "../http/auth.ts";
import type { OperatorChannel, OperatorUpdate } from "../ports/operator.ts";
import { parseApprovalPayload, payloadMatchesDigest } from "./approval-payload.ts";

export interface ApprovalDeps {
  db: D1Database;
  /** Where shown records live: the KV namespace. */
  shown: ShownStore;
  operator: OperatorChannel;
  now?: () => Date;
  logger?: { warn(msg: string, data?: Record<string, unknown>): void };
}

interface DraftRow {
  id: string;
  kind: string;
  recipient_email: string | null;
  subject: string | null;
  body: string | null;
  status: DraftStatus;
  approved_digest: string | null;
}

async function loadDraft(db: D1Database, id: string): Promise<DraftRow | null> {
  return db.prepare("SELECT id, kind, recipient_email, subject, body, status, approved_digest FROM drafts WHERE id = ?1").bind(id).first<DraftRow>();
}

function contentOf(row: DraftRow): DraftContent {
  return { to: row.recipient_email, subject: row.subject, body: row.body };
}

export const APPROVAL_SUMMARY = "Approve this draft? Approving marks it approved; nothing is sent from this chat.";

export function draftPreview(row: Pick<DraftRow, "id" | "kind" | "recipient_email" | "subject" | "body">): string {
  return [`Draft ${row.id} (${row.kind})`, `To: ${row.recipient_email ?? "(none)"}`, `Subject: ${row.subject ?? ""}`, "", row.body ?? ""].join("\n");
}

export type ApprovalRequestResult = { ok: true; digest: string; messageId: string } | { ok: false; reason: string };

/** Send an approval request for a pending draft and record what was shown. */
export async function requestDraftApproval(deps: ApprovalDeps, draftId: string, chatId: string): Promise<ApprovalRequestResult> {
  const row = await loadDraft(deps.db, draftId);
  if (!row) return { ok: false, reason: "the draft was not found" };
  if (row.status !== "pending_approval" && row.status !== "draft") return { ok: false, reason: `the draft is ${row.status}` };
  const content = contentOf(row);
  const digest = await draftDigest(content);
  let messageId: string;
  try {
    ({ messageId } = await deps.operator.requestApproval({
      approvalId: row.id,
      chatId,
      kind: "send",
      digest,
      summary: APPROVAL_SUMMARY,
      preview: draftPreview(row),
      actions: ["approve", "reject"],
    }));
  } catch (error) {
    return { ok: false, reason: `the approval request could not be sent: ${sanitizeErrorMessage(error)}` };
  }
  // Bookkeeping: if it is not recorded, a tap is refused (wasShown fails closed), never approved blind.
  if (!(await markShown(deps.shown, row.id, content))) deps.logger?.warn("shown record could not be written", { draftId: row.id });
  return { ok: true, digest, messageId };
}

export type ApprovalOutcome = { outcome: "approved" | "rejected"; draftId: string } | { outcome: "refused"; reason: string; draftId?: string };

type Commit = { ok: true } | { ok: false; reason: string };

/**
 * Mark a draft approved for `actor`, given the digest of its current content. The update is a
 * compare-and-set on the status and the content, so an edit that lands in between is not approved.
 */
async function commitApproval(deps: Pick<ApprovalDeps, "db" | "now">, row: DraftRow, current: string, actor: string): Promise<Commit> {
  const approval = await approveDraft({ ...contentOf(row), status: row.status, approved_digest: row.approved_digest }, current);
  if (!approval.ok) return { ok: false, reason: `The approval was refused: ${approval.reason}.` };
  const at = (deps.now?.() ?? new Date()).toISOString();
  const result = await deps.db
    .prepare(
      `UPDATE drafts SET status = 'approved', approved_digest = ?2, approved_at = ?3, approved_by = ?4, updated_at = ?3
        WHERE id = ?1 AND status = ?5 AND recipient_email IS ?6 AND subject IS ?7 AND body IS ?8`,
    )
    .bind(row.id, current, at, actor, row.status, row.recipient_email, row.subject, row.body)
    .run();
  if ((result.meta.changes ?? 0) === 0) return { ok: false, reason: "That draft changed while it was being approved, so the approval was refused." };
  await recordDraftDecision(deps.db, row.id, "approved", deps.now?.() ?? new Date());
  return { ok: true };
}

/** Mark a draft rejected. A sent or already rejected draft is refused. */
async function commitRejection(deps: Pick<ApprovalDeps, "db" | "now">, row: DraftRow): Promise<Commit> {
  if (row.status === "sent") return { ok: false, reason: "That draft was already sent and cannot be rejected." };
  if (row.status === "rejected") return { ok: false, reason: "That draft was already rejected." };
  const result = await deps.db
    .prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status IN ('draft', 'pending_approval', 'approved')")
    .bind(row.id, (deps.now?.() ?? new Date()).toISOString())
    .run();
  if ((result.meta.changes ?? 0) === 0) return { ok: false, reason: "That draft changed state and was not rejected." };
  await recordDraftDecision(deps.db, row.id, "rejected", deps.now?.() ?? new Date());
  return { ok: true };
}

export type DraftDecision = { ok: true; draftId: string } | { ok: false; code: "not_found" | "conflict" | "stale"; reason: string };

/**
 * Approve a draft for an operator who was shown it outside a chat button (the dashboard). The same
 * rules as a tap: the draft is re-resolved by id; `shownDigest`, the full digest the operator was
 * shown, must equal the digest of its current content, and the shown record must confirm that
 * content was shown (a gate: an unreadable record refuses); then the same compare-and-set approves
 * it. Approving never sends anything.
 */
export async function approveShownDraft(deps: Pick<ApprovalDeps, "db" | "shown" | "now">, draftId: string, shownDigest: string, actor: string): Promise<DraftDecision> {
  const row = await loadDraft(deps.db, draftId);
  if (!row) return { ok: false, code: "not_found", reason: "That draft no longer exists." };
  if (row.status === "approved") return { ok: false, code: "conflict", reason: "That draft is already approved." };
  if (row.status !== "pending_approval" && row.status !== "draft") return { ok: false, code: "conflict", reason: `That draft is ${row.status} and cannot be approved.` };
  const content = contentOf(row);
  const current = await draftDigest(content);
  const fresh = (await constantTimeEqual(shownDigest, current)) && (await wasShown(deps.shown, row.id, content));
  if (!fresh) return { ok: false, code: "stale", reason: "This draft changed after it was shown, so the approval was refused. Reload it and review it again." };
  const approved = await commitApproval(deps, row, current, actor);
  return approved.ok ? { ok: true, draftId: row.id } : { ok: false, code: "conflict", reason: approved.reason };
}

/** Reject a draft by id (the dashboard's reject). Rejecting needs no digest: it can only stop a send. */
export async function rejectDraftById(deps: Pick<ApprovalDeps, "db" | "now">, draftId: string): Promise<DraftDecision> {
  const row = await loadDraft(deps.db, draftId);
  if (!row) return { ok: false, code: "not_found", reason: "That draft no longer exists." };
  const rejected = await commitRejection(deps, row);
  return rejected.ok ? { ok: true, draftId: row.id } : { ok: false, code: "conflict", reason: rejected.reason };
}

type Callback = Extract<OperatorUpdate, { type: "callback" }>;

async function answer(deps: ApprovalDeps, update: Callback, text: string): Promise<void> {
  try {
    await deps.operator.acknowledgeCallback(update.callbackId, text);
  } catch (error) {
    deps.logger?.warn("callback acknowledgement failed", { error: sanitizeErrorMessage(error) });
  }
}

async function settle(deps: ApprovalDeps, update: Callback, text: string): Promise<void> {
  try {
    await deps.operator.editMessage(update.messageId, { text, chatId: update.chatId });
  } catch (error) {
    deps.logger?.warn("approval message could not be updated", { error: sanitizeErrorMessage(error) });
  }
}

/** Handle an approve or reject tap. The callback's sender must already be verified and allowlisted. */
export async function handleApprovalCallback(deps: ApprovalDeps, update: Callback): Promise<ApprovalOutcome> {
  const refuse = async (reason: string, draftId?: string): Promise<ApprovalOutcome> => {
    await answer(deps, update, reason);
    return { outcome: "refused", reason, ...(draftId ? { draftId } : {}) };
  };
  if (update.action !== "approve" && update.action !== "reject") return refuse("That button is not one this agent understands.");
  const payload = parseApprovalPayload(update.payload);
  if (!payload) return refuse("That button is not valid.");

  const row = await loadDraft(deps.db, payload.approvalId);
  if (!row) return refuse("That draft no longer exists.", payload.approvalId);
  const content = contentOf(row);
  const current = await draftDigest(content);

  if (update.action === "reject") {
    const rejected = await commitRejection(deps, row);
    if (!rejected.ok) return refuse(rejected.reason, row.id);
    await answer(deps, update, "Rejected.");
    await settle(deps, update, `Rejected draft ${row.id} for ${row.recipient_email ?? "(none)"}.`);
    return { outcome: "rejected", draftId: row.id };
  }

  if (row.status === "approved") return refuse("That draft is already approved.", row.id);
  if (row.status !== "pending_approval" && row.status !== "draft") return refuse(`That draft is ${row.status} and cannot be approved.`, row.id);
  const stale = !(await payloadMatchesDigest(payload.digest, current)) || !(await wasShown(deps.shown, row.id, content));
  if (stale) {
    await answer(deps, update, "This draft changed after it was shown, so the approval was refused.");
    const again = await requestDraftApproval(deps, row.id, update.chatId);
    if (!again.ok) deps.logger?.warn("fresh approval request failed", { draftId: row.id, reason: again.reason });
    return { outcome: "refused", reason: "the draft changed after it was shown", draftId: row.id };
  }

  const approved = await commitApproval(deps, row, current, `operator:${update.userId}`);
  if (!approved.ok) return refuse(approved.reason, row.id);
  await answer(deps, update, "Approved. Nothing was sent.");
  await settle(deps, update, `Approved draft ${row.id} for ${row.recipient_email ?? "(none)"}. Nothing was sent.`);
  return { outcome: "approved", draftId: row.id };
}
