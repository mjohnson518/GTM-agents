// GTM-agents: the operator module's public surface: the operator webhook, the chat queue consumer,
// commands, draft approvals and the allowlist. createWorker wires these up; docs/OPERATOR.md is the
// deployer's guide.
export { AGENT_DISABLED_TEXT, AGENT_FLAG, CHAT_BATCHING_FLAG, TIMERS_FLAG, isAgentEnabled, isAllowedOperator, isChatBatchingEnabled, isTimersEnabled } from "./access.ts";
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
export { OPERATOR_UPDATE_EFFECT, OPERATOR_WEBHOOK_PATH, createOperatorWebhook, updateKey } from "./webhook.ts";
