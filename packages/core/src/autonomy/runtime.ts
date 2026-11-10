// GTM-agents: the runtime surface of earned autonomy (@gtm-agents/core/autonomy/runtime): the level
// reader, evidence, incidents and demotion, promotion proposals, the operator commands, automatic
// replies and the jobs, plus everything @gtm-agents/core/autonomy exports. These modules use the
// Worker's bindings (D1, KV); docs/AUTONOMY.md describes how they fit together.
export {
  ACTION_CLASSES,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_LEVEL,
  EARNABLE_ACTION_CLASSES,
  PERMANENT_HUMAN,
  effectiveLevel,
  isPermanentHuman,
} from "./levels.ts";
export type { ActionClass, AutonomyLevel, PermanentHumanClass } from "./levels.ts";
// The one level reader.
export { latestLevelChange, latestLevelChanges, levelFlagKey, parseLevelFlag, readAutonomyLevel } from "./store.ts";
export type { LevelChange, LevelChangeSource, LevelReadDeps, LevelReading } from "./store.ts";
// Evidence.
export {
  AUTONOMY_OUTCOMES,
  EVIDENCE_WINDOW_DAYS,
  RECENT_INCIDENT_DAYS,
  decisionsOf,
  emptyEvidence,
  evidenceLine,
  evidenceStatement,
  loadEvidence,
  recordAutonomyEvidence,
  recordAutonomyEvidenceOnce,
  recordDraftDecision,
} from "./evidence.ts";
export type { AutonomyOutcome, ClassEvidence, EvidenceInput } from "./evidence.ts";
// Incidents and demotion.
export {
  INCIDENT_WINDOW_DAYS,
  RATE_CHECK,
  VOLUME_CLASSES,
  autoSentClasses,
  checkColdBatchRates,
  classOfSend,
  coldBatchRateBreach,
  incidentCountsFor,
  incidentKindFor,
  reconcileIncidents,
  recordContactIncident,
  returnAutomaticApprovals,
  writeIncident,
} from "./incidents.ts";
export type { ColdBatchRates, ContactIncident, IncidentKind, IncidentResult, RateCheckResult, RetryOptions } from "./incidents.ts";
// Promotion and proposals.
export {
  AUTOMATIC_PATHS,
  OPERATOR_RAISED_PATHS,
  levelPath,
  MAX_REJECTED_SHARE,
  MIN_AUTO_SENDS,
  MIN_CLEAN_SHARE,
  MIN_DECISIONS,
  MIN_DECISIONS_BY_CLASS,
  OUTCOME_GATE,
  PROPOSAL_REPEAT_DAYS,
  decidePromotion,
  loadColdBatchOutcome,
  minDecisionsFor,
  outcomeBlock,
  runAutonomyReview,
} from "./promotion.ts";
export type { OutcomeEvidence, PromotionDecision, PromotionInput, ReviewDeps, ReviewResult } from "./promotion.ts";
export {
  DISMISS_REASON_MAX,
  OPERATOR_PROPOSAL_TTL_MS,
  REVIEW_PROPOSAL_TTL_MS,
  confirmCommand,
  confirmProposal,
  createProposal,
  dismissCommand,
  dismissProposal,
  expireProposals,
  loadProposal,
  openProposals,
} from "./proposals.ts";
export type { ConfirmDeps, ConfirmResult, DismissDeps, DismissResult, NewProposal, Proposal, ProposalOrigin, ProposalStatus } from "./proposals.ts";
// Operator commands.
export { AUTONOMY_HELP_LINES, parseAutonomyCommand, runAutonomyCommand } from "./commands.ts";
export type { AutonomyCommand, AutonomyCommandDeps } from "./commands.ts";
// The outbound writer registry and its scorers.
export { OUTBOUND_WRITERS, WRITER_EVAL_FILE, evalGap, writersFor } from "./writers.ts";
export type { OutboundWriter } from "./writers.ts";
export { figuresIn, scoreOutboundText } from "./scorers.ts";
export type { ScoreInput, ScoreResult } from "./scorers.ts";
// Automatic replies: the rules, and sending a reply that passes them.
export {
  AUTO_SEND_CLASSES,
  AUTO_SEND_MIN_CONFIDENCE,
  autoSendPrecheck,
  competitorNames,
  decideReplyAutoSend,
  groundingProblem,
  linksIn,
  mentionsTime,
  plainAddress,
  riskIn,
} from "./auto-send-rules.ts";
export type { AutoSendCheck, AutoSendFailure, AutoSendQuality, ReplyAutoSendInput } from "./auto-send-rules.ts";
export { autoSendReply } from "./reply-auto-send.ts";
export { TRUSTED_AUTHSERV_IDS, parseAuthenticationResults, senderAuthentication } from "./sender-auth.ts";
export type { AuthResult, ParsedAuthenticationResults, SenderAuthentication } from "./sender-auth.ts";
export type { AutoSendOutcome, AutoSendResult, ReplyAutoSendCandidate, ReplyAutoSendDeps } from "./reply-auto-send.ts";
// Flags and jobs.
export { AUTONOMY_FLAGS, readFlagState } from "./flags.ts";
export { AUTONOMY_REVIEW_JOB, AUTONOMY_WATCH_JOB, DEFAULT_AUTONOMY_JOB_OPTIONS, createAutonomyJobs, runAutonomyWatch } from "./jobs.ts";
export type { AutonomyDeps, AutonomyEnv, AutonomyJobOptions, WatchDeps, WatchResult } from "./jobs.ts";
