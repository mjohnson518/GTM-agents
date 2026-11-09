// GTM-agents: autonomy evidence for reply drafts.
//
// Every reply draft is filed under one action class (drafts.action_class):
//   - reply_demo_link: they asked to see the product, and the draft carries exactly one approved
//     asset link and no other link except the booking URL;
//   - reply_question: a question triaged at 0.8 or above, answered with approved facts available;
//   - reply_send: everything else.
// Each decision on a draft writes one autonomy_events row for its class, through the evidence
// module (autonomy/evidence.ts): approved_unchanged (sent as drafted), approved_edited (sent after
// a change), rejected, or auto_sent (approved and sent by the auto-send tier, docs/AUTONOMY.md).
// The promotion review reads them. One row per draft, claimed in the effects ledger. Recording is
// bookkeeping: it never throws.
import { recordAutonomyEvidence } from "../autonomy/evidence.ts";
import type { ActionClass } from "../autonomy/levels.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";

export const REPLY_ACTION_CLASSES = ["reply_send", "reply_demo_link", "reply_question"] as const satisfies readonly ActionClass[];
export type ReplyActionClass = (typeof REPLY_ACTION_CLASSES)[number];

export function replyActionClass(value: unknown): ReplyActionClass {
  return typeof value === "string" && (REPLY_ACTION_CLASSES as readonly string[]).includes(value) ? (value as ReplyActionClass) : "reply_send";
}

export type ReplyEvidence = "approved_unchanged" | "approved_edited" | "rejected" | "auto_sent";

const EVIDENCE_EFFECT = "autonomy_evidence";
const evidenceKey = (draftId: string) => `reply_evidence:${draftId}`;

/** Record one decision on a draft, once. True when a row was written now. Never throws. */
export async function recordReplyEvidence(
  db: D1Database,
  input: { draftId: string; actionClass: unknown; outcome: ReplyEvidence; detail: string; now: Date },
): Promise<boolean> {
  try {
    if (!(await claimEffect(db, evidenceKey(input.draftId), EVIDENCE_EFFECT))) return false;
  } catch {
    return false;
  }
  if (await recordAutonomyEvidence(db, { actionClass: replyActionClass(input.actionClass), outcome: input.outcome, subjectId: input.draftId, detail: input.detail.slice(0, 200), now: input.now })) return true;
  await releaseEffect(db, evidenceKey(input.draftId), EVIDENCE_EFFECT);
  return false;
}

/**
 * Close a draft's evidence without a row, for a draft closed by something other than a decision on
 * its text (the reply was answered by hand, or the draft went stale). Never throws.
 */
export async function closeReplyEvidence(db: D1Database, draftId: string): Promise<void> {
  try {
    await claimEffect(db, evidenceKey(draftId), EVIDENCE_EFFECT);
  } catch {
    // Bookkeeping: at worst the draft later counts as rejected.
  }
}

/** The SQL condition "this draft's evidence is not closed yet", for a drafts row aliased `d`. */
export const EVIDENCE_OPEN_SQL = `NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'reply_evidence:' || d.id AND ee.effect = '${EVIDENCE_EFFECT}')`;
