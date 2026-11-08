// GTM-agents: the public surface of sequences: the sequence state writes, the follow-up sweep, the
// send function for steps, threading, the release and resume commands, the manual channel step, the
// stale check and the jobs. docs/SEQUENCES.md is the deployer's guide.
export {
  advanceSequenceStatement,
  endSequenceStatement,
  EXHAUSTED_REASON,
  holdSequences,
  pauseSequenceStatement,
  rescheduleSequenceStatement,
  resumeSequences,
  SEQUENCE_STOPPING_CLASSIFICATIONS,
  stopSequences,
  type SequenceRowKey,
  type SequenceScope,
  type SequenceStopStatus,
} from "./state.ts";
export { SEQUENCE_FLAGS, SEQUENCE_LIMITS } from "./flags.ts";
export { createSequenceSender } from "./sender.ts";
export { checkRows, contactRule, contactsWithReplies, type ChecksResult, type RowVerdict } from "./checks.ts";
export { followUpSubject, resolveMessageIds, stripReplyPrefix, threadFor, type LookupBudget, type LookupMiss, type Thread } from "./threading.ts";
export { composeStep, FIXTURE_CONTACT, fixtureProblem, planSteps, stepCandidates, type SequenceStepConfig, type StepOutcome, type StepPlan } from "./compose.ts";
export { loadStepDrafts, parseStepKey, sequenceManifestId, stepKey, STEP_KEY_PREFIX, type StepDraft } from "./drafts.ts";
export { loadDueRows, loadPriorSends, loadRows, type DueRow, type PriorSend } from "./rows.ts";
export { sendLine, sendSteps, toItem, type ReadyStep, type SendReport, type StepChange } from "./send.ts";
export { composeManualNote, manualGates, manualTouchText, recordManualTouch, type ManualChannel, type ManualGate, type ManualTouch } from "./manual.ts";
export { DEFAULT_SWEEP_MAX_ROWS, runFollowUpSweep, SWEEP_NOTICE_EFFECT, type SweepCounts, type SweepDeps, type SweepResult } from "./sweep.ts";
export { parseSequenceReleaseCommand, releaseSequenceManifest, type SequenceReleaseDeps, type SequenceReleaseResult } from "./release.ts";
export { parseSequenceCommand, runSequenceCommand, type SequenceCommand, type SequenceCommandDeps } from "./commands.ts";
export { runStaleCheck, STALE_EFFECT, type StaleDeps, type StaleResult } from "./stale.ts";
export { createSequenceJobs, DEFAULT_SEQUENCE_JOB_OPTIONS, SEQUENCE_STALE_JOB, SEQUENCE_SWEEP_JOB, type SequenceDeps, type SequenceEnv, type SequenceJobOptions } from "./jobs.ts";
