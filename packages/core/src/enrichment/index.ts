// GTM-agents: the enrichment module's public surface: the enrichment stage, the email waterfall,
// verification semantics, per-field evidence with conflict holds, and account research.
export { MAX_ENRICH_ATTEMPTS, PEOPLE_LOOKUP_LIMIT, enrichStage } from "./enrich.ts";
export type { EnrichOptions, EnrichStats } from "./enrich.ts";
export { runEmailWaterfall } from "./waterfall.ts";
export type { FoundEmail, WaterfallInput, WaterfallOptions, WaterfallResult, WaterfallStep } from "./waterfall.ts";
export { findPeopleAtAccount } from "./people.ts";
export type { PeopleLookup, PeopleLookupOptions, PersonAtAccount } from "./people.ts";
export {
  MAX_UNKNOWN_ATTEMPTS,
  UNKNOWN_TTL_DAYS,
  VERIFICATION_TTL_DAYS,
  cacheVerification,
  emailConfidence,
  freshVerification,
  isFresh,
  passesPromotionPolicy,
  readCachedVerification,
  verificationTtlDays,
  verifyAddress,
} from "./verification.ts";
export type { EmailConfidence, VerificationRecord, VerifyOptions, VerifyOutcome } from "./verification.ts";
export {
  RESEARCH_EFFECT,
  RESEARCH_MAX_ATTEMPTS,
  RESEARCH_PENDING_TIMEOUT_MS,
  RESEARCH_REFRESH_DAYS,
  RESEARCH_RETRY_DAYS,
  researchEffectId,
  runAccountResearch,
  summarizeResearch,
} from "./research.ts";
export type { AccountResearchOptions, AccountResearchResult } from "./research.ts";
export { EVIDENCE_FIELDS, EVIDENCE_RETENTION_DAYS, hasOpenConflict, recordEvidence, valuesConflict } from "./evidence.ts";
export type { EvidenceField, EvidenceInput, EvidenceResult } from "./evidence.ts";
