// GTM-agents: the security module's public surface. docs/SECURITY-MODEL.md explains how the parts
// fit together.
export { ALLOWED, blocked, checkActionGate, checkHumanApproval } from "./action-gate.ts";
export type { BlockCode, GateResult, HumanApproval, Refusal } from "./action-gate.ts";
export {
  DIGEST_VERSION,
  DRAFT_STATUSES,
  SHOWN_TTL_SECONDS,
  applyEdit,
  approveDraft,
  canonicalJson,
  draftDigest,
  manifestCode,
  markShown,
  toolInputDigest,
  verifyApproval,
  wasShown,
} from "./approval-digest.ts";
export type { ApprovalResult, DraftContent, DraftStatus, EditResult, ReviewableDraft, ShownStore } from "./approval-digest.ts";
export { childStartTaint, formatTaintMarker, preserveTaintMarker, readTaintMarker, returnTaint } from "./delegation-taint.ts";
export { FENCE_TAG, fenceUntrusted, neutralizeTags, newFence, safeToolName, wrapTrusted } from "./fence.ts";
export type { FenceOptions } from "./fence.ts";
export { REDACTED, detectInjection, normalizeForDetection, redactInjection, replaceNormalized } from "./redact.ts";
export { ToolRegistryError, createToolRegistry } from "./registry.ts";
export type { ManifestTools, ToolRegistry, ToolRegistryOptions } from "./registry.ts";
export {
  ERROR_MESSAGE_MAX_CHARS,
  MEMORY_TEXT_MAX_CHARS,
  TOOL_OUTPUT_MAX_CHARS,
  sanitizeErrorMessage,
  sanitizeMemoryText,
  sanitizeToolOutput,
} from "./sanitize.ts";
export type { SanitizeOptions, SanitizedOutput } from "./sanitize.ts";
export { GATE_LEVELS, TAINT_LEVELS, isRefusedAt, isTaintLevel, maxTaintLevel, raiseTaint, toTaintLevel } from "./taint.ts";
export type { GateLevel, TaintLevel, TaintedSession } from "./taint.ts";
export { CORE_TOOL_CLASSES, PERMANENT_HUMAN_TOOLS, UNKNOWN_TOOL_CLASS } from "./tool-classes.ts";
export type { ToolClass } from "./tool-classes.ts";
export { capText, headSlice, tailSlice } from "./truncate.ts";
export type { CapResult } from "./truncate.ts";
export {
  HOST_LABELS_MAX,
  HOST_LABEL_MAX_LENGTH,
  QUERY_MAX_LENGTH,
  URL_MAX_LENGTH,
  carriedDataReason,
  checkEgress,
  collectStrings,
  findUrls,
  urlExfiltrationReason,
  validateUrl,
} from "./url-validator.ts";
export type { EgressCheck, UrlCheck } from "./url-validator.ts";
