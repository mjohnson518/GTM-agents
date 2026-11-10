// GTM-agents: autonomy evidence for lifecycle follow-ups. Each decision on a follow-up writes one
// autonomy_events row for the action class its rule names, through the autonomy module's evidence
// functions (autonomy/evidence.ts), which the promotion review reads:
//   - fu-approve: approved_unchanged when the approved text is the text the writer rendered from the
//     template, approved_edited when the draft was changed before it was approved;
//   - fu-reject: rejected;
//   - the sweep sending at an earned level (2 or above): auto_sent.
// A follow-up that is withdrawn (the contact moved on), expires unapproved or is skipped records
// nothing: no one judged its text.
//
// Only earnable classes are recorded. The offers (the upgrade offer and the win-back) belong to the
// permanently human class `offers`: they record no evidence at all, so nothing about them can ever
// count toward a level, and no follow-up is ever recorded under another class than its rule's.
// One row per follow-up, claimed in the effects ledger. Recording is bookkeeping: it never throws,
// and a lost row never changes what was sent.
import { recordAutonomyEvidenceOnce } from "../autonomy/evidence.ts";
import { EARNABLE_ACTION_CLASSES, isPermanentHuman, type ActionClass } from "../autonomy/levels.ts";
import type { FollowupRule } from "./followup-rules.ts";

export type FollowupEvidence = "approved_unchanged" | "approved_edited" | "rejected" | "auto_sent";

const earnable: ReadonlySet<string> = new Set(EARNABLE_ACTION_CLASSES);

/** The class a follow-up's decisions count toward, or null when they count toward none (offers). Pure. */
export function followupEvidenceClass(rule: Pick<FollowupRule, "actionClass" | "offer">): ActionClass | null {
  if (rule.offer || isPermanentHuman(rule.actionClass) || !earnable.has(rule.actionClass)) return null;
  return rule.actionClass;
}

/** The once-key of a follow-up's evidence row. */
export const followupEvidenceKey = (followupId: string): string => `lifecycle_followup_evidence:${followupId}`;

/** The notes a follow-up draft is stored with: its follow-up, its kind and the digest of the text the writer rendered. */
export const followupDraftNotes = (input: { followupId: string; kind: string; generatedDigest: string }): string =>
  JSON.stringify({ followup: input.followupId, kind: input.kind, generated_digest: input.generatedDigest });

/** The digest of the text the writer rendered, from a follow-up draft's notes, or null. Pure. */
export function generatedDigestOf(notes: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(notes ?? "") as { generated_digest?: unknown };
    return typeof parsed.generated_digest === "string" && /^[0-9a-f]{64}$/.test(parsed.generated_digest) ? parsed.generated_digest : null;
  } catch {
    return null;
  }
}

/**
 * How an approval counts: unchanged only when the approved digest is the one the writer rendered.
 * A draft with no recorded rendering counts as edited, the cautious reading. Pure.
 */
export const approvalEvidence = (approvedDigest: string, notes: string | null | undefined): FollowupEvidence => (generatedDigestOf(notes) === approvedDigest ? "approved_unchanged" : "approved_edited");

/**
 * Record one decision on a follow-up, once. True when a row was written now; false for an offer,
 * a repeat, or a write that failed. Never throws.
 */
export async function recordFollowupEvidence(
  db: D1Database,
  input: { followupId: string; rule: Pick<FollowupRule, "kind" | "actionClass" | "offer">; outcome: FollowupEvidence; detail: string; now: Date },
): Promise<boolean> {
  const actionClass = followupEvidenceClass(input.rule);
  if (!actionClass) return false;
  try {
    return await recordAutonomyEvidenceOnce(db, followupEvidenceKey(input.followupId), {
      actionClass,
      outcome: input.outcome,
      subjectId: input.followupId,
      detail: `${input.rule.kind}: ${input.detail}`.slice(0, 200),
      now: input.now,
    });
  } catch {
    return false;
  }
}
