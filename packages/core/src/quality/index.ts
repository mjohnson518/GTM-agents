// GTM-agents: the quality module's public surface: the content lint, the deterministic quality gate,
// the claims check, the model reviewer and quality_checks rows. docs/OUTREACH.md lists every code.
export { lintOutbound } from "./lint.ts";
export type { LintFinding, LintResult } from "./lint.ts";
export {
  QUALITY_CODES,
  REPLY_WORD_BOUNDS,
  checkOutboundQuality,
  heldResult,
  hostFromConfig,
  isUsableAccountName,
  summarizeQuality,
  usableFirstName,
  withFinding,
} from "./gate.ts";
export type { FindingSeverity, LinkPolicy, QualityCode, QualityContact, QualityFinding, QualityInput, QualityKind, QualityResult, QualityVerdict } from "./gate.ts";
export { approvedClaimLines, checkClaims } from "./claims.ts";
export type { ClaimCheck } from "./claims.ts";
export {
  REVIEW_MAX_SAMPLES,
  REVIEW_MIN_SCORE,
  REVIEW_OUTPUT_SCHEMA,
  REVIEW_RUBRIC,
  REVIEW_TIMEOUT_MS,
  buildReviewSystem,
  buildReviewUserTurn,
  parseReviewOutput,
  planReviewSamples,
  reviewOutbound,
  templateReviews,
  withReview,
} from "./reviewer.ts";
export type { ReviewOutcome, ReviewSample, ReviewScores, ReviewSpend, ReviewVerdict, ReviewerDeps } from "./reviewer.ts";
export { qualityCheckStatement, recordQualityChecks } from "./record.ts";
export type { QualityRecord, QualitySubject } from "./record.ts";
