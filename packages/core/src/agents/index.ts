// GTM-agents: the agents module's public surface: the hub agent's chat turn, its system prompt, the
// chat sessions that carry taint and history across turns, and the timers a turn can set. Test doubles live in
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
export {
  OPEN_TIMER_STATUSES,
  TIMER_LATE_MS,
  TIMER_MAX_DELAY_DAYS,
  TIMER_MIN_DELAY_MINUTES,
  TIMER_NOTE_MAX_CHARS,
  TIMER_PENDING_MAX,
  TIMER_STATUSES,
  cancelSessionTimers,
  cancelTimer,
  dueTimers,
  expireLateTimers,
  insertTimer,
  listOpenTimers,
  loadTimer,
  minuteUtc,
  newTimerId,
  timerEffectKey,
  timerTurnText,
  timersQueuedOn,
  transitionTimer,
} from "./timers.ts";
export type { NewTimer, Timer, TimerChange, TimerStatus } from "./timers.ts";
