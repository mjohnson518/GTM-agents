// GTM-agents: promotion: the weekly review that proposes raising a class's level from evidence.
//
// Nothing here changes a level. The review proposes, with the evidence, and only the operator's
// autonomy-confirm command applies a proposal (proposals.ts), and only while the class's level and
// its latest recorded change are still the ones the proposal was made against.
//
// The ladder (decidePromotion, pure):
//   L1 to L2  at least MIN_DECISIONS decisions in 60 days (a batch is one decision, so the cold batch
//             needs MIN_DECISIONS_BY_CLASS.cold_batch), at least 90% approved as written, at most 5%
//             rejected, and no incident in 30 days;
//   L2 to L3  at least MIN_AUTO_SENDS automatic sends in 60 days, with no incident and no rejection
//             in 60 days.
// Every proposal also needs:
//   - a class with an automatic path (AUTOMATIC_PATHS): raising a class nothing acts on would mean
//     nothing until a later version reads it, which is a surprise, not a decision;
//   - an eval for every writer of the class (writers.ts, evalGap);
//   - for the cold batch, the outcome gate (outcomeBlock): first touches sent 10 to 40 days ago
//     (matured) against a baseline sent 40 to 130 days ago, at least OUTCOME_MIN_SENDS each, a hard
//     bounce rate under 2% in the recent window, and a positive reply rate at or above the
//     baseline's. Every figure comes from packages/core/src/metrics/, the one definition of each.
// A permanently human-only class is never proposed, whatever its evidence. A class at L0 is never
// proposed either: observe-only was a person's choice. The same proposal (class, from, to) is made
// at most once every PROPOSAL_REPEAT_DAYS.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { hardBounceRate } from "../metrics/delivery-rates.ts";
import { MATURITY_DAYS, firstTouchOutcomes, replyRate, type OutcomeCounts } from "../metrics/outreach.ts";
import { DAY_MS, metricWindow } from "../metrics/window.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { decisionsOf, evidenceLine, loadEvidence, type ClassEvidence } from "./evidence.ts";
import { EARNABLE_ACTION_CLASSES, isPermanentHuman, type ActionClass, type AutonomyLevel } from "./levels.ts";
import { confirmCommand, createProposal, REVIEW_PROPOSAL_TTL_MS, type Proposal } from "./proposals.ts";
import { readAutonomyLevel } from "./store.ts";
import { evalGap } from "./writers.ts";

export const MIN_DECISIONS = 30;
/** Classes whose one decision covers many messages need fewer decisions. */
export const MIN_DECISIONS_BY_CLASS: Readonly<Partial<Record<ActionClass, number>>> = Object.freeze({ cold_batch: 4 });
export const MIN_CLEAN_SHARE = 0.9;
export const MAX_REJECTED_SHARE = 0.05;
export const MIN_AUTO_SENDS = 60;
export const PROPOSAL_REPEAT_DAYS = 14;

/** The outcome gate's windows, in days before now, its smallest sample and its bounce limit. */
export const OUTCOME_GATE = Object.freeze({ recentFromDays: 40, recentToDays: MATURITY_DAYS, baselineFromDays: 130, baselineToDays: 40, minSends: 200, maxHardBounceRate: 0.02 });

/**
 * The classes something acts on at level 2 or above, and what it does. A class not listed here is
 * never proposed: nothing would act on the level yet.
 */
export const AUTOMATIC_PATHS: Readonly<Partial<Record<ActionClass, string>>> = Object.freeze({
  cold_batch: "the cold batch and its follow-up steps send drafts that pass the quality gate and the model reviewer without a release code",
  reply_send: "a reply that passes every auto-send rule goes out at once, and you are told after",
  reply_demo_link: "a reply carrying one approved asset to someone who asked to see the product goes out at once, and you are told after",
});

export function minDecisionsFor(actionClass: string): number {
  return MIN_DECISIONS_BY_CLASS[actionClass as ActionClass] ?? MIN_DECISIONS;
}

/** The cold batch's matured first touches: the recent window and the baseline before it. */
export interface OutcomeEvidence {
  recent: OutcomeCounts;
  baseline: OutcomeCounts;
}

/** The outcome gate's two windows, from the send ledger. Throws on a database error. */
export async function loadColdBatchOutcome(db: D1Database, now: Date): Promise<OutcomeEvidence> {
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const [recent, baseline] = await Promise.all([
    firstTouchOutcomes(db, metricWindow(at(OUTCOME_GATE.recentFromDays), at(OUTCOME_GATE.recentToDays))),
    firstTouchOutcomes(db, metricWindow(at(OUTCOME_GATE.baselineFromDays), at(OUTCOME_GATE.baselineToDays))),
  ]);
  return { recent, baseline };
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

/** Why the outcome gate blocks the cold batch's promotion, or null when it passes. Missing data blocks. Pure. */
export function outcomeBlock(o: OutcomeEvidence | null | undefined): string | null {
  if (!o) return "the cold batch's send outcomes could not be read";
  if (o.recent.sends < OUTCOME_GATE.minSends || o.baseline.sends < OUTCOME_GATE.minSends) {
    return `too few matured first touches to compare (${o.recent.sends} recent, ${o.baseline.sends} baseline; ${OUTCOME_GATE.minSends} each needed)`;
  }
  const bounces = hardBounceRate({ sends: o.recent.sends, hardBounces: o.recent.bounced });
  if (bounces === null || bounces >= OUTCOME_GATE.maxHardBounceRate) return `hard bounce rate ${pct(bounces ?? 1)} in the recent window`;
  const recent = replyRate(o.recent.positiveReplies, o.recent.sends);
  const baseline = replyRate(o.baseline.positiveReplies, o.baseline.sends);
  if (recent === null || baseline === null || recent < baseline) return `positive reply rate ${pct(recent ?? 0, 2)} is below the baseline ${pct(baseline ?? 0, 2)}`;
  return null;
}

export interface PromotionInput {
  actionClass: string;
  level: AutonomyLevel;
  evidence: ClassEvidence;
  /** The outcome gate's evidence; required for the cold batch. */
  outcome?: OutcomeEvidence | null;
}

export type PromotionDecision = { propose: true; from: AutonomyLevel; to: AutonomyLevel; reason: string } | { propose: false; reason: string };

/** The ladder. Pure. */
export function decidePromotion(input: PromotionInput): PromotionDecision {
  const { actionClass, level, evidence: e } = input;
  const no = (reason: string): PromotionDecision => ({ propose: false, reason });
  if (isPermanentHuman(actionClass)) return no("permanently human-only");
  if (!(EARNABLE_ACTION_CLASSES as readonly string[]).includes(actionClass)) return no("not an action class whose level can be earned");
  if (!AUTOMATIC_PATHS[actionClass as ActionClass]) return no("nothing acts on this class's level yet");
  if (level === 0) return no("observe only, a person's choice");
  if (level >= 3) return no("already at the highest level");
  const gap = evalGap(actionClass);
  if (gap) return no(gap);
  if (actionClass === "cold_batch") {
    const block = outcomeBlock(input.outcome);
    if (block) return no(block);
  }
  const decisions = decisionsOf(e);
  if (level === 1) {
    const needed = minDecisionsFor(actionClass);
    if (decisions < needed) return no(`${decisions} decisions in 60 days; ${needed} needed`);
    if (e.incidentsRecent > 0) return no(`${e.incidentsRecent} incidents in the last 30 days`);
    const clean = e.approvedUnchanged / decisions;
    const rejected = e.rejected / decisions;
    if (clean < MIN_CLEAN_SHARE) return no(`${pct(clean, 0)} approved as written; ${pct(MIN_CLEAN_SHARE, 0)} needed`);
    if (rejected > MAX_REJECTED_SHARE) return no(`${pct(rejected, 0)} rejected; at most ${pct(MAX_REJECTED_SHARE, 0)} allowed`);
    return { propose: true, from: 1, to: 2, reason: `${decisions} decisions in 60 days, ${pct(clean, 0)} approved as written, ${pct(rejected, 0)} rejected, no incident in 30 days` };
  }
  if (e.autoSent < MIN_AUTO_SENDS) return no(`${e.autoSent} automatic sends in 60 days; ${MIN_AUTO_SENDS} needed`);
  if (e.incidents > 0) return no(`${e.incidents} incidents in 60 days`);
  if (e.rejected > 0) return no(`${e.rejected} rejections in 60 days`);
  return { propose: true, from: 2, to: 3, reason: `${e.autoSent} automatic sends in 60 days with no incident and no rejection` };
}

export interface ReviewDeps {
  db: D1Database;
  flags: FlagReader;
  config: Pick<GtmConfig, "autonomy" | "operator">;
  operator?: OperatorChannel;
  chatId?: string;
  now: Date;
  log?: JobLogger;
}

export interface ReviewResult {
  classes: number;
  proposals: Proposal[];
  skipped: Array<{ actionClass: string; reason: string }>;
  notified: boolean;
}

/** True when the same proposal was made in the last PROPOSAL_REPEAT_DAYS. Throws on a database error. */
async function proposedRecently(db: D1Database, actionClass: string, from: number, to: number, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - PROPOSAL_REPEAT_DAYS * DAY_MS).toISOString();
  const row = await db
    .prepare("SELECT 1 AS hit FROM autonomy_proposals WHERE action_class = ?1 AND origin = 'review' AND from_level = ?2 AND to_level = ?3 AND created_at >= ?4 LIMIT 1")
    .bind(actionClass, from, to, since)
    .first();
  return row !== null;
}

/**
 * The weekly review: one proposal at most per class, each sent to the operator with its evidence
 * and the command that applies it. Throws when the evidence cannot be read; a proposal that cannot
 * be written or sent is skipped and tried again next week.
 */
export async function runAutonomyReview(deps: ReviewDeps): Promise<ReviewResult> {
  const { db, now } = deps;
  const evidence = await loadEvidence(db, now);
  let outcome: OutcomeEvidence | null = null;
  try {
    outcome = await loadColdBatchOutcome(db, now);
  } catch (error) {
    deps.log?.warn("the cold batch's send outcomes could not be read; it is not proposed this week", { error: sanitizeErrorMessage(error) });
  }
  const result: ReviewResult = { classes: 0, proposals: [], skipped: [], notified: false };
  const lines: string[] = [];
  for (const actionClass of Object.keys(AUTOMATIC_PATHS) as ActionClass[]) {
    result.classes += 1;
    const reading = await readAutonomyLevel({ flags: deps.flags, db, config: deps.config }, actionClass);
    if (reading.error) {
      result.skipped.push({ actionClass, reason: reading.error });
      continue;
    }
    const e = evidence.get(actionClass);
    if (!e) continue;
    const decision = decidePromotion({ actionClass, level: reading.level, evidence: e, outcome });
    if (!decision.propose) {
      result.skipped.push({ actionClass, reason: decision.reason });
      continue;
    }
    try {
      if (await proposedRecently(db, actionClass, decision.from, decision.to, now)) {
        result.skipped.push({ actionClass, reason: `proposed in the last ${PROPOSAL_REPEAT_DAYS} days` });
        continue;
      }
      const proposal = await createProposal(db, {
        actionClass,
        from: decision.from,
        to: decision.to,
        origin: "review",
        basedOnChange: reading.latest?.id ?? 0,
        evidence: { reason: decision.reason, evidence: e, ...(actionClass === "cold_batch" && outcome ? { outcome } : {}) },
        requestedBy: "system:autonomy_review",
        ttlMs: REVIEW_PROPOSAL_TTL_MS,
        now,
      });
      result.proposals.push(proposal);
      lines.push(
        [
          `Propose ${actionClass} level ${decision.from} to level ${decision.to}: ${decision.reason}.`,
          `Evidence: ${evidenceLine(e)}.`,
          `At level ${decision.to}, ${AUTOMATIC_PATHS[actionClass] ?? "it acts on its own"}.`,
          `To apply it, send: ${confirmCommand(proposal)} (valid ${PROPOSAL_REPEAT_DAYS} days, and only while ${actionClass} is still at level ${decision.from}).`,
        ].join("\n"),
      );
    } catch (error) {
      result.skipped.push({ actionClass, reason: `the proposal could not be written: ${sanitizeErrorMessage(error)}` });
    }
  }
  if (lines.length > 0 && deps.operator) {
    const chat = deps.chatId ?? deps.config.operator.allowedChatIds[0];
    try {
      await deps.operator.notify({ text: [`Autonomy review: ${lines.length} proposal(s). Nothing changes until you confirm.`, ...lines].join("\n\n"), ...(chat ? { chatId: chat } : {}) });
      result.notified = true;
    } catch (error) {
      // Never seen, so never decided: withdrawn, and proposed again by next week's review.
      deps.log?.warn("the autonomy review could not be sent; its proposals are withdrawn and made again next week", { error: sanitizeErrorMessage(error) });
      try {
        await db.prepare("DELETE FROM autonomy_proposals WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'open'").bind(JSON.stringify(result.proposals.map((p) => p.id))).run();
      } catch {
        // Bookkeeping: an undelivered proposal then waits out its repeat window.
      }
      result.proposals = [];
    }
  }
  return result;
}
