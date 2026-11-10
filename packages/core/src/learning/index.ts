// GTM-agents: the self-improvement module's public surface (docs/LEARNING.md): the shared proposal
// record and its approval path, the learnings document, edit mining, the voice profile, objection
// curation, the retrospective, the agent review, fitness, the benchmark, evolution, the operator
// commands and the jobs.
export { LEARNING_FLAGS, learningFlagOn } from "./flags.ts";
export type { LearningFlag } from "./flags.ts";
export {
  PLAYBOOK_FIELDS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  PROPOSAL_TTL_DAYS,
  PROSPECT_FACING_PLAYBOOK_FIELDS,
  createLearningProposal,
  detailDigest,
  detailOf,
  expireLearningProposals,
  listLearningProposals,
  loadLearningProposal,
  proposalProblems,
  proposalTitle,
  renderDetail,
  toProposalView,
} from "./proposals.ts";
export type { AnyPayload, CreateResult, LearningProposal, NewProposal, PlaybookField, ProposalKind, ProposalPayloads, ProposalStatus, ProposalView } from "./proposals.ts";
export { approveLearningProposal, autoApplyLearningProposal, classOf, rejectLearningProposal, selfApplicable } from "./apply.ts";
export type { ApplyDeps, ApproveOutcome, ApproveStatus, AutoApplyDeps } from "./apply.ts";
export { LEARNING_SECTIONS, SECTION_MAX_BYTES, SECTION_MAX_ENTRIES, isLearningSection, learningEntries, learningsText, sectionRoom } from "./learnings.ts";
export type { LearningEntry, LearningSection } from "./learnings.ts";
export { MAX_CHANGED_ITEMS, NEVER_PROPOSED_COMPONENTS, SELF_EDITABLE_COMPONENTS, applyBrainEdit, editProblems, itemsOf, readServedBrain, renderBrainFile } from "./brain-edit.ts";
export type { BrainEditResult, BrainItemInput, BrainKv, ServedBrain } from "./brain-edit.ts";
export { MAX_RULES_PER_WEEK, MIN_DRAFTS, MINING_WINDOW_DAYS, diffEdit, editPatterns, mineDraftEdits, recordDraftEdit } from "./edit-mining.ts";
export type { DraftEditInput, EditDiff, EditPattern, MiningResult } from "./edit-mining.ts";
export { DRIFT_EDIT_RATE, DRIFT_MIN_DECISIONS, buildVoiceProposal, voiceDrift, voiceItems, voiceStats } from "./voice.ts";
export type { DriftReading, VoiceStats } from "./voice.ts";
export { SCORE_WINDOW_DAYS, proposeObjectionAnswer, scoreObjectionAnswers, unansweredObjections } from "./objections.ts";
export type { UnansweredObjection } from "./objections.ts";
export { MEMORY_KINDS, memoryBlock, readMemoryNotes, recentMemories, storeMemory } from "./memory.ts";
export type { MemoryKind, MemoryNote, MemoryReadOptions } from "./memory.ts";
export { MEMORY_NOTICE, WRITER_CONTEXT, writerContext } from "./context.ts";
export type { LearningWriter, WriterContext, WriterContextBudget } from "./context.ts";
export {
  DEFAULT_FITNESS_TARGETS,
  FITNESS_DIMENSIONS,
  FITNESS_WEIGHTS,
  MIN_ACTIVATION_SIGNUPS,
  compositeScore,
  dimensionTrends,
  fitnessTrend,
  regressionSlope,
  runFitness,
  scoreFitness,
} from "./fitness.ts";
export type { DimensionTrend, FitnessDimension, FitnessScores, FitnessTargets, FitnessTrendPoint, TrendDirection } from "./fitness.ts";
export { BENCH_DIMENSIONS, REGRESSION_DROP, generateScenarios, parseJudgeScore, runBenchmark, scoreRouting, sliceText, weeklyRegression } from "./benchmark.ts";
export type { BenchDimension, BenchScenario, BenchmarkRun, ScenarioScore } from "./benchmark.ts";
export { CANDIDATES, COOLDOWN_DAYS, EVOLUTION_TARGETS, MIN_GAIN, parseCandidates, runEvolution } from "./evolution.ts";
export type { EvolutionResult } from "./evolution.ts";
export { RETROSPECTIVE_CHOICES, parseRetrospective, runRetrospective } from "./retrospective.ts";
export type { RetrospectiveAnswer, RetrospectiveResult } from "./retrospective.ts";
export { GRADES, parseReview, runAgentReview } from "./agent-review.ts";
export type { AgentReviewResult, Grade, ReviewAnswer } from "./agent-review.ts";
export { LEARNING_HELP_LINES, approvalCode, parseLearningCommand, runLearningCommand } from "./commands.ts";
export type { LearningCommand, LearningCommandDeps } from "./commands.ts";
export { DEFAULT_LEARNING_JOB_OPTIONS, LEARNING_JOBS, createLearningJobs } from "./jobs.ts";
export type { LearningDeps, LearningEnv, LearningJobOptions } from "./jobs.ts";
export { defang, lineDiff, snippetProblems, splitSentences } from "./text.ts";
export { learningDashboard } from "./dashboard.ts";
