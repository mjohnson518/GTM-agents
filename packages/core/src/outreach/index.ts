// GTM-agents: the outreach module's public surface: the daily cold batch, its selection and picker,
// template allocation and composing, the holdout, readiness, approval manifests and the release
// command. docs/OUTREACH.md is the deployer's guide.
export { COLD_BATCH_JOB, DEFAULT_OUTREACH_JOB_OPTIONS, createOutreachJobs } from "./jobs.ts";
export type { OutreachDeps, OutreachEnv, OutreachJobOptions } from "./jobs.ts";
export { NOTICE_EFFECT, PAGE_EFFECT, PICK_EFFECT, YELLOW_DEFER_HOURS, YELLOW_MIN_SEND, campaignIdFor, runColdBatch } from "./batch.ts";
export type { ColdBatchDeps, ColdBatchResult, ColdBatchStatus } from "./batch.ts";
export {
  CONFIDENCE_FLOORS,
  HOLDOUT_RATE_DEFAULT,
  HOLDOUT_RATE_MAX,
  OUTREACH_FLAGS,
  OUTREACH_LIMITS,
  readAutoApprove,
  readConfidenceFloor,
  readDailyLimit,
  readHoldoutRate,
} from "./flags.ts";
export type { AutoApproveDecision, ConfidenceFloor } from "./flags.ts";
export { MAX_BATCH_TEMPLATES, batchTemplates, createRotation, eligibleTemplates, isTargeted, templateMatches } from "./allocate.ts";
export type { Rotation, TargetFacts } from "./allocate.ts";
export { claimSources, composeColdDraft, contactValues, copyableAttributes, loadCopy, targetFacts } from "./compose.ts";
export type { ComposeContext, ComposeOutcome, CopyLines } from "./compose.ts";
export { HOLDOUT_DAYS, heldOutContacts, holdoutWindow, pickHoldout, recordHoldout, seededRng } from "./holdout.ts";
export type { Rng } from "./holdout.ts";
export { PICK_SKIP_REASONS, pickContacts, selectionWeeklyCap } from "./picker.ts";
export type { AccountUse, PickOptions, PickResult, PickSkipReason, PickableContact } from "./picker.ts";
export { LIVE_DEAL_STAGES, LIVE_THREAD_DAYS, LIVE_WARMTH, RELEASE_MAX_AGE_DAYS, loadAccountState, selectCandidates } from "./select.ts";
export type { AccountState, SelectionRow } from "./select.ts";
export { BOUNCE_CRITICAL, BOUNCE_MIN_SENDS, BOUNCE_WARN, READINESS_DIMENSIONS, assessReadiness, lintSample, readinessLine, readinessWithSalvage, salvageable } from "./readiness.ts";
export type { DimensionResult, DimensionStatus, ReadinessDecision, ReadinessDimension, ReadinessItem, ReadinessLevel, ReadinessOptions, ReadinessReport } from "./readiness.ts";
export { RELEASE_PREFIX, readManifest, releaseCommand, renderSamples, writeManifest } from "./manifest.ts";
export type { Manifest, ManifestDraft } from "./manifest.ts";
export { parseReleaseCommand, releaseBatch } from "./release.ts";
export type { ReleaseCommand, ReleaseDeps, ReleaseResult } from "./release.ts";
export { HANDOFF_EFFECT, claimMany, handOff, handoffLine, loadDrafts, revalidateDrafts } from "./send.ts";
export type { HandoffItem, HandoffReport, RevalidateOptions, StoredDraft } from "./send.ts";
