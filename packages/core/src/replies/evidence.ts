// GTM-agents: autonomy evidence for reply drafts.
//
// Every reply draft is filed under one action class (drafts.action_class):
//   - reply_demo_link: they asked to see the product, and the draft carries exactly one approved
//     asset link and no other link except the booking URL;
//   - reply_question: a question triaged at 0.8 or above, answered with approved facts available;
//   - reply_send: everything else.
// Each decision a person makes on a draft writes one autonomy_events row for its class:
// approved_unchanged (sent as drafted), approved_edited (sent after a change), or rejected. The
// promotion ladder reads them. One row per draft, claimed in the effects ledger. Recording is
// bookkeeping: it never throws.
import type { ActionClass } from "../autonomy/levels.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";

export const REPLY_ACTION_CLASSES = ["reply_send", "reply_demo_link", "reply_question"] as const satisfies readonly ActionClass[];
export type ReplyActionClass = (typeof REPLY_ACTION_CLASSES)[number];

export function replyActionClass(value: unknown): ReplyActionClass {
  return typeof value === "string" && (REPLY_ACTION_CLASSES as readonly string[]).includes(value) ? (value as ReplyActionClass) : "reply_send";
}

export type ReplyEvidence = "approved_unchanged" | "approved_edited" | "rejected";

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
  try {
    await db
      .prepare("INSERT INTO autonomy_events (id, action_class, outcome, subject_id, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(`ae_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, replyActionClass(input.actionClass), input.outcome, input.draftId, input.detail.slice(0, 200), input.now.toISOString())
      .run();
    return true;
  } catch {
    await releaseEffect(db, evidenceKey(input.draftId), EVIDENCE_EFFECT);
    return false;
  }
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
