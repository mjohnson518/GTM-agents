// GTM-agents: the qualify stage: enriched candidates are scored and sorted into qualified,
// borderline or rejected.
//
// The score is deterministic and free (no provider or model call). It reads only what enrichment
// recorded and what the database already holds:
//   - a work address: +0.30 when its fresh verification is deliverable, +0.15 when risky;
//   - a full name +0.15, a company name +0.10;
//   - person fit: +0.20 for keep, +0.05 for maybe;
//   - account fit: the model fit score / 10 * 0.25 when the account is scored, otherwise the
//     prescore / 100 * 0.10.
// Clamped to [0, 1]: 0.5 or more is qualified, under 0.3 rejected, anything between borderline.
// Borderline and rejected are terminal, and both record a reason code (sourcing/reasons.ts). Hard
// stops win over the score: the brain's never list, a person-fit drop, or an account fit score below
// the floor rejects outright.
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { classifyTitle, type PersonFitDecision } from "../scoring/titles.ts";
import { freshVerification } from "../enrichment/verification.ts";
import type { VerificationStatus } from "../ports/contact.ts";
import { fitAttribute, loadTitleReviews, parseAttributes, updateCandidate, type CandidateRow } from "./candidates.ts";
import type { StageContext } from "./context.ts";
import { matchNeverList } from "./identity.ts";
import type { RejectReason } from "./reasons.ts";

export const QUALIFIED_AT = 0.5;
export const REJECTED_BELOW = 0.3;

export interface QualificationInput {
  verification: VerificationStatus | null;
  hasFullName: boolean;
  hasAccountName: boolean;
  personFit: PersonFitDecision;
  fitScore: number | null;
  prescore: number | null;
}

/** The qualification score, from 0 to 1. Pure. */
export function qualificationScore(input: QualificationInput): number {
  let score = 0;
  if (input.verification === "deliverable") score += 0.3;
  else if (input.verification === "risky") score += 0.15;
  if (input.hasFullName) score += 0.15;
  if (input.hasAccountName) score += 0.1;
  if (input.personFit === "keep") score += 0.2;
  else if (input.personFit === "maybe") score += 0.05;
  if (input.fitScore !== null) score += (Math.max(0, Math.min(10, input.fitScore)) / 10) * 0.25;
  else if (input.prescore !== null) score += (Math.max(0, Math.min(100, input.prescore)) / 100) * 0.1;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

export function qualificationStatus(score: number): "qualified" | "borderline" | "rejected" {
  if (score >= QUALIFIED_AT) return "qualified";
  return score < REJECTED_BELOW ? "rejected" : "borderline";
}

export interface QualifyStats {
  processed: number;
  qualified: number;
  borderline: number;
  rejected: number;
}

export async function qualifyStage(ctx: StageContext, limit: number): Promise<QualifyStats> {
  const stats: QualifyStats = { processed: 0, qualified: 0, borderline: 0, rejected: 0 };
  if (limit <= 0) return stats;
  const reviews = await loadTitleReviews(ctx.db);
  const { results: rows } = await ctx.db.prepare("SELECT * FROM candidates WHERE status = 'enriched' ORDER BY updated_at, id LIMIT ?1").bind(limit).all<CandidateRow>();
  for (const row of rows) {
    if (ctx.signal?.aborted) break;
    const attrs = parseAttributes(row.attributes);
    const fit = classifyTitle(row.job_title, ctx.brain.personas, { never: ctx.brain.never, reviews });
    attrs.person_fit = fitAttribute(fit);
    const account = row.account_key
      ? await ctx.db.prepare("SELECT status, fit_score, prescore FROM account_fit WHERE account_key = ?1").bind(row.account_key).first<{ status: string; fit_score: number | null; prescore: number }>()
      : null;
    const fitScore = account?.status === "scored" ? account.fit_score : null;
    const never = matchNeverList(ctx.brain.never, { domain: row.account_key, accountName: row.account_name, title: row.job_title });
    let status: "qualified" | "borderline" | "rejected";
    let score: number;
    let notes: string;
    if (never || fit.decision === "drop" || (fitScore !== null && fitScore < LOW_FIT_SCORE)) {
      score = 0;
      status = "rejected";
      notes = never ?? (fit.decision === "drop" ? `person fit: ${fit.reason}` : `the account's fit score is below ${LOW_FIT_SCORE}`);
      attrs.reject_reason = never ? "never_list" : fit.decision === "drop" ? "person_fit_drop" : "low_fit";
    } else {
      const verification = row.email ? await freshVerification(ctx.db, row.email, ctx.now) : null;
      score = qualificationScore({
        verification: verification?.status ?? null,
        hasFullName: Boolean(row.first_name && row.last_name),
        hasAccountName: Boolean(row.account_name),
        personFit: fit.decision,
        fitScore,
        prescore: account ? account.prescore : null,
      });
      status = qualificationStatus(score);
      const reason: RejectReason | null = status === "rejected" ? "low_score" : status === "borderline" ? "borderline_score" : null;
      if (reason) attrs.reject_reason = reason;
      notes = `score ${score}; person fit ${fit.decision}; email ${verification?.status ?? (row.email ? "unverified" : "none")}`;
    }
    const changed = await updateCandidate(ctx.db, row.id, "enriched", { status, qualification_score: score, qualification_notes: notes, attributes: JSON.stringify(attrs) }, ctx.now);
    if (!changed) continue;
    stats.processed += 1;
    stats[status] += 1;
  }
  return stats;
}
