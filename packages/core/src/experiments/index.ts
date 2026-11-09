// GTM-agents: the experiments module's public surface: Thompson allocation with guardrails,
// account-clustered assignment, template experiments with pre-registration and honest conclusion,
// subject and send-time tests, the copy-change gate, proposals, the weekly self-review, the A/B
// dashboard command and the jobs. docs/EXPERIMENTS.md is the deployer's guide.
export { EXPERIMENT_CYCLE_JOB, SELF_REVIEW_JOB, DEFAULT_EXPERIMENT_JOB_OPTIONS, createExperimentJobs, servedTemplates } from "./jobs.ts";
export type { ExperimentDeps, ExperimentEnv, ExperimentJobOptions } from "./jobs.ts";
export { EXPERIMENT_FLAGS, MAX_TEMPLATE_WEIGHT, parseWeight, readAllocation, readControlTemplate, readSwitch, readWeightOverride, templateWeightKey } from "./flags.ts";
export type { AllocationMode } from "./flags.ts";
export {
  ARM_FLOOR,
  CELL_MIN_PER_ARM,
  CONTROL_FLOOR,
  MAX_ARMS,
  MAX_FLOOR_TOTAL,
  MIN_MATURED_PER_ARM,
  PSEUDO_SENDS,
  applyFloors,
  buildCellTable,
  cellKeys,
  chooseArms,
  decideCell,
  guardrailFloors,
  thompsonReady,
  thompsonShares,
  weightShares,
} from "./thompson.ts";
export type { CellDecision, CellFacts, CellTable, ThompsonArm } from "./thompson.ts";
export { EXCLUDED_ARM, armLoads, hashOrder, loadPins, pinArm, planAssignments, saltedHash, unitKey, unitSizes } from "./assignment.ts";
export type { AssignmentPlan, AssignmentPlanInput, AssignmentScope, ExperimentUnitInput, PlannedArm } from "./assignment.ts";
export { ALLOCATION_LOOKBACK_DAYS, planAllocation, withWeightOverrides } from "./plan.ts";
export type { AllocationPlan, PlanInput } from "./plan.ts";
export {
  MAX_DURATION_DAYS,
  MAX_RUNNING,
  MIN_SAMPLE_PER_ARM,
  ageDays,
  amendExperiment,
  copyChanged,
  createExperiment,
  experimentInputSchema,
  listExperiments,
  loadExperiment,
  markConcluded,
  markStarted,
  markStopped,
  minimumAgeDays,
  missingForStart,
  recordedVerdict,
  runningExperiments,
  startFingerprint,
  targetPerArm,
} from "./store.ts";
export type { ExperimentInput, ExperimentRecord, ExperimentStatus } from "./store.ts";
export { DISCARD_AT, KEEP_AT, MIN_PER_ARM, evaluateExperiment, evaluationSeed } from "./evaluate.ts";
export type { Evaluation, EvaluationInput, Verdict } from "./evaluate.ts";
export { GATE_MIN_PER_ARM, GATE_MIN_PROBABILITY, bestAndRunnerUp, copyChangeGate } from "./gate.ts";
export type { GateArm, GateResult } from "./gate.ts";
export {
  LOSER_WEIGHT_FLOOR,
  PROPOSAL_DEDUPE_DAYS,
  PROPOSAL_KINDS,
  PROPOSAL_TTL_DAYS,
  approveProposal,
  createProposal,
  expireProposals,
  loadProposal,
  pendingProposals,
  promotedWeights,
  proposalText,
  proposalsSince,
  recordOutcome,
  rejectProposal,
  trackRecord,
  trackRecordLine,
  validFlagChange,
} from "./proposals.ts";
export type { ApplyDeps, ApplyResult, CopyChangeSnapshot, ExperimentProposal, ProposalInput, ProposalKind, ProposalStatus, TrackRecord } from "./proposals.ts";
export { MAX_VARIANTS, SUBJECT_EVEN_SPLIT_SENDS, ZERO_REPLY_TRIPWIRE_SENDS, activeSubjectTests, createSubjectTest, dealVariants, stopSubjectTest, subjectTestInputSchema, variantProblem, variantShares } from "./subject.ts";
export type { SubjectTest, SubjectTestInput, SubjectVariant } from "./subject.ts";
export { SEND_SLOTS, SEND_TIME_TEST_ID, SLOT_HOURS, isSendSlot, planSlots, slotWindow, slotsFitWindow } from "./send-time.ts";
export type { SendSlot, SlotUnit } from "./send-time.ts";
export { runExperimentCycle } from "./cycle.ts";
export type { CycleDeps, CycleResult } from "./cycle.ts";
export { JUDGE_AFTER_DAYS, RUNWAY_DAYS, SELF_REVIEW_KINDS, SELF_REVIEW_WEEKLY_MAX, SEND_TIME_MIN_VOLUME, WEIGHT_MIN_SENDS, WEIGHT_STEP, runSelfReview } from "./self-review.ts";
export type { SelfReviewDeps, SelfReviewResult } from "./self-review.ts";
export { EXPERIMENT_HELP_LINES, parseExperimentCommand, parseFields, runExperimentCommand } from "./commands.ts";
export type { ExperimentCommand, ExperimentCommandDeps } from "./commands.ts";
export { AB_RECENT_DAYS, liftOverSecondBest, loadAbDashboard, renderAbDashboard } from "../reports/ab.ts";
export type { AbArm, AbDashboardData, AbTest } from "../reports/ab.ts";
