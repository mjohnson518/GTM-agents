// GTM-agents: the operator module's public surface: the operator webhook, the chat queue consumer,
// commands, draft approvals and the allowlist. createWorker wires these up; docs/OPERATOR.md is the
// deployer's guide.
export { AGENT_DISABLED_TEXT, AGENT_FLAG, isAgentEnabled, isAllowedOperator } from "./access.ts";
export { APPROVAL_DIGEST_CHARS, approvalPayload, parseApprovalPayload, payloadMatchesDigest } from "./approval-payload.ts";
export { APPROVAL_SUMMARY, approveShownDraft, draftPreview, handleApprovalCallback, rejectDraftById, requestDraftApproval } from "./approvals.ts";
export type { ApprovalDeps, ApprovalOutcome, ApprovalRequestResult, DraftDecision } from "./approvals.ts";
export { RELEASE_EFFECT, createChatConsumer, flagsFromKv, isChatMessage, processChatMessage, resolveChannel } from "./chat.ts";
export type { OperatorAgentOptions } from "./chat.ts";
export { helpText, parseCommand, parseReleaseCommand, runCommand, runReleaseCommand } from "./commands.ts";
export type { CommandDeps, ParsedCommand, ReleaseCommandDeps } from "./commands.ts";
export { OPERATOR_UPDATE_EFFECT, OPERATOR_WEBHOOK_PATH, createOperatorWebhook, updateKey } from "./webhook.ts";
