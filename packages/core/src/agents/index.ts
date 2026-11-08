// GTM-agents: the agents module's public surface: the hub agent's chat turn, its system prompt and
// the chat sessions that carry taint and history across turns. Test doubles live in
// "@gtm-agents/core/agents/testing".
export { CHAT_JOB, DEFAULT_MAX_ROUNDS, DEFAULT_MAX_TOKENS, runHubTurn } from "./hub.ts";
export type { AgentLogger, HubAgentDeps, TurnInput, TurnResult, TurnStop } from "./hub.ts";
export { buildSystemPrompt } from "./prompt.ts";
export type { SystemPromptInput } from "./prompt.ts";
export {
  HISTORY_LIMIT,
  STORED_MESSAGE_MAX_CHARS,
  appendTurn,
  clearSession,
  ensureSession,
  loadSession,
  raiseSessionTaint,
  sessionKeyFor,
  shapeHistory,
} from "./sessions.ts";
export type { HistoryMessage, SessionState } from "./sessions.ts";
