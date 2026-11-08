// GTM-agents: the replies module's public surface: triage, routing, the meeting qualifier,
// drafting, approval and sending from the warm mailbox, the reply-owed clock, mailbox draft
// mirroring, the operator commands and the jobs. docs/REPLIES.md is the deployer's guide.
export { REPLY_FLAGS, REPLY_THRESHOLDS, replyFlagOn } from "./flags.ts";
export { TRIAGE_OUTPUT_SCHEMA, INTENT_DEFINITIONS, buildTriageSystem, buildTriageUserTurn, parseTriageOutput, triageText } from "./triage.ts";
export type { TriageOutcome, TriageResult } from "./triage.ts";
export { MAX_REFERRALS, SHORT_DECLINE_WORDS, isOwnAddress, nextDealStage, noDraftReason, routeReply, warmthFor } from "./route.ts";
export type { RouteDeps, RouteResult } from "./route.ts";
export { ATTRIBUTION_WINDOW_DAYS, creditReply } from "./ledger.ts";
export type { LedgerCredit } from "./ledger.ts";
export { decideQualification, qualifierRule, qualifyReply, saveQualification } from "./qualify.ts";
export type { Qualification, QualifierGap, QualifierStatus } from "./qualify.ts";
export { brainObjections, fileObjection, matchBrainObjections, matchStoredAnswers, objectionAnswerDigest } from "./objections.ts";
export type { ApprovedAnswer, BrainObjection } from "./objections.ts";
export { DRAFT_OUTPUT_SCHEMA, buildWriterSystem, buildWriterUserTurn, draftReply, loadReplyAssets, parseDraftOutput, planDraft, replyClassFor } from "./draft.ts";
export type { DraftContext, DraftDeps, DraftOutcome, DraftPlan, ReplyAsset } from "./draft.ts";
export { REPLY_ACTION_CLASSES, recordReplyEvidence, replyActionClass } from "./evidence.ts";
export type { ReplyActionClass, ReplyEvidence } from "./evidence.ts";
export { checkFreshness, isAutomatic } from "./freshness.ts";
export type { Freshness, FreshnessRefusal } from "./freshness.ts";
export { generatedDigest, sendApprovedReply } from "./send.ts";
export type { ReplySendResult, ReplySenderDeps } from "./send.ts";
export { describeSend, runOutbox } from "./outbox.ts";
export type { OutboxDeps, OutboxResult } from "./outbox.ts";
export { MORNING_MIN_AGE_HOURS, OWED_INTENTS, QUIET_THREAD_DAYS, REMINDER_TIERS, dueReminder, runReplyClock, waitedFor } from "./owed.ts";
export type { OwedDeps, OwedResult } from "./owed.ts";
export { MIRROR_GONE_WAIT_DAYS, MIRROR_MAX_AGE_DAYS, runMirror } from "./mirror.ts";
export type { MirrorDeps, MirrorResult } from "./mirror.ts";
export { mailboxCan, mailboxDraftExists } from "./mailbox.ts";
export type { MailboxCapability } from "./mailbox.ts";
export { runReplyPipeline } from "./pipeline.ts";
export type { PipelineDeps, PipelineResult } from "./pipeline.ts";
export { REPLY_COMMAND_NAMES, REPLY_HELP_LINES, isReplyCommand, runReplyCommand } from "./commands.ts";
export type { ReplyCommandDeps } from "./commands.ts";
export { DEFAULT_REPLY_JOB_OPTIONS, REPLY_MIRROR_JOB, REPLY_REMINDERS_JOB, REPLY_SEND_JOB, REPLY_TRIAGE_JOB, assertModelSchedule, createReplyJobs } from "./jobs.ts";
export type { ReplyDeps, ReplyEnv, ReplyJobOptions } from "./jobs.ts";
export { isVerbatim, operatorPreview, replySubject, senderLabel, senderText, sentMatchesDraft, stripQuotedReply, stripSignature } from "./text.ts";
export { parseStoredTriage } from "./rows.ts";
export type { InboundRow, StoredTriage } from "./rows.ts";
