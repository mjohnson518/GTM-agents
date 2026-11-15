// GTM-agents: the operator module's public surface: the operator webhook, the chat queue consumer,
// commands, draft approvals, the allowlist and the outbox that paces notices. createWorker wires these up; docs/OPERATOR.md is the
// deployer's guide.
export { AGENT_DISABLED_TEXT, AGENT_FLAG, CHAT_BATCHING_FLAG, NOTES_FLAG, OUTBOX_FLAG, TIMERS_FLAG, isAgentEnabled, isAllowedOperator, isChatBatchingEnabled, isNotesEnabled, isOutboxEnabled, isTimersEnabled } from "./access.ts";
export { APPROVAL_DIGEST_CHARS, approvalPayload, parseApprovalPayload, payloadMatchesDigest } from "./approval-payload.ts";
export { APPROVAL_SUMMARY, approveShownDraft, draftPreview, handleApprovalCallback, rejectDraftById, requestDraftApproval } from "./approvals.ts";
export type { ApprovalDeps, ApprovalOutcome, ApprovalRequestResult, DraftDecision } from "./approvals.ts";
export { CHAT_RUN_MAX_CHARS, CHAT_RUN_SEPARATOR, MODULE_COMMAND_EFFECT, MODULE_COMMAND_FAILED_TEXT, RELEASE_EFFECT, TIMER_TURN_EFFECT, createChatConsumer, flagsFromKv, isChatMessage, planChatRuns, processChatMessage, processChatRun, resolveChannel, routeChatText } from "./chat.ts";
export type { ChatRoute, OperatorAgentOptions } from "./chat.ts";
export { helpText, parseCommand, parseReleaseCommand, runCommand, runReleaseCommand } from "./commands.ts";
export type { CommandDeps, ParsedCommand, ReleaseCommandDeps } from "./commands.ts";
export { BUILT_IN_COMMAND_NAMES, matchModuleCommand, moduleHelpLines } from "./module-commands.ts";
export type { MatchedModuleCommand, ModuleCommand, ModuleCommandContext, ModuleCommandHandler } from "./module-commands.ts";
export {
  TIMERS_DAILY_MAX,
  TIMERS_DAILY_MAX_FLAG,
  TIMERS_HELP_LINE,
  TIMERS_JOB,
  TIMERS_PER_RUN,
  TIMERS_SCHEDULE,
  createOperatorTimerJobs,
  queueDueTimers,
  runTimersCommand,
  timerQueueMessage,
} from "./timers.ts";
export type { OperatorTimerJobOptions } from "./timers.ts";
export { NOTES_HELP_LINE, runNotesCommand } from "./notes.ts";
export {
  OUTBOX_FOLD_MAX_CHARS,
  OUTBOX_GIVE_UP_MS,
  OUTBOX_PAGE_GIVE_UP_MS,
  OUTBOX_HELP_LINE,
  OUTBOX_HOURLY_MAX,
  OUTBOX_HOURLY_MAX_FLAG,
  OUTBOX_JOB,
  OUTBOX_PER_RUN,
  OUTBOX_SCHEDULE,
  createOperatorOutboxJobs,
  deliverHeldNotices,
  foldNotices,
  isHeldMessageId,
  quietHoursEnd,
  runOutboxCommand,
  unwrapOutbox,
  withOperatorOutbox,
} from "./outbox.ts";
export type { OperatorOutboxJobOptions, OutboxDeps, QuietHours } from "./outbox.ts";
export { OPERATOR_UPDATE_EFFECT, OPERATOR_WEBHOOK_PATH, createOperatorWebhook, updateKey } from "./webhook.ts";
