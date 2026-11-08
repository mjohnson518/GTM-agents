// GTM-agents: the sourcing module's public surface: the discovery cycle and its stages, identity
// rules, the typed brain items sourcing reads, the spend gate and the job factory.
// docs/SOURCING.md describes how it works and how to deploy it.
export { DEFAULT_SOURCING_JOB_OPTIONS, DISCOVERY_JOB, FIT_JOB, PRESCORE_JOB, createSourcingJobs } from "./jobs.ts";
export type { SourcingDeps, SourcingEnv, SourcingJobOptions } from "./jobs.ts";
export type { SourcingAdapters, StageContext } from "./context.ts";
export { runDiscoveryCycle, summarizeCycle } from "./cycle.ts";
export type { DiscoveryCycleInput, DiscoveryCycleResult } from "./cycle.ts";
export { MAX_EXCLUDED_DOMAINS, brainQueryId, exclusionDomains, planQueries, resolveAccountByName, searchStage } from "./search.ts";
export type { PlannedQuery, SearchLimits, SearchStats } from "./search.ts";
export { QUALIFIED_AT, REJECTED_BELOW, qualificationScore, qualificationStatus, qualifyStage } from "./qualify.ts";
export type { QualificationInput, QualifyStats } from "./qualify.ts";
export { promoteStage } from "./promote.ts";
export type { PromoteOptions, PromoteStats } from "./promote.ts";
export { EMPTY_SOURCING_BRAIN, SENIORITY_LEVELS, loadSourcingBrain } from "./brain.ts";
export type { PersonaRole, PersonaRule, PersonaSeat, Seniority, SourcingBrain, SourcingQuery } from "./brain.ts";
export {
  EMPTY_NEVER_LIST,
  ROLE_MAILBOXES,
  accountNameKey,
  isRoleAddress,
  matchNeverList,
  normalizePhrase,
  screenAddress,
  splitPersonName,
} from "./identity.ts";
export type { AddressScreen, AddressVerdict, NeverList, PersonName } from "./identity.ts";
export { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "./text.ts";
export { MICRO_CENTS_PER_USD, costMicroCents, createSpendGate } from "./spend.ts";
export type { SpendGate, SpendGateOptions } from "./spend.ts";
export { PROMOTION_POLICIES, SOURCING_FLAGS, SOURCING_LIMITS, readCeiling, readFlagOn, readPromotionPolicy } from "./flags.ts";
export type { PromotionPolicy } from "./flags.ts";
export { insertCandidate, parseAttributes, parseSteps, updateCandidate } from "./candidates.ts";
export type { CandidateAttributes, CandidateRow, NewCandidate } from "./candidates.ts";
