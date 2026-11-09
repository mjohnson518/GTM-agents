// GTM-agents: the dashboard's pure state logic: reconnect backoff, connection outcomes, the live
// activity feed, streaming chat turns, the pipeline kanban grouping and flag editing rules. Nothing
// here touches the DOM, so all of it is unit tested.
import type { ActivityItem } from "@gtm-agents/core/gateway/protocol";

// Connection

/** Exponential backoff with equal jitter: half the window fixed, half random. */
export function backoffDelay(attempt: number, random: () => number, baseMs = 500, maxMs = 30_000): number {
  const window = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(window / 2 + random() * (window / 2));
}

export type Outcome = "not_configured" | "not_allowed" | "retry";

/** What a plain GET to the socket path says about a failed upgrade. */
export function classifyProbeStatus(status: number | null): Outcome {
  if (status === 503) return "not_configured";
  if (status === 401 || status === 403) return "not_allowed";
  return "retry";
}

/** Application close codes a server may send: 4401 and 4403 refuse the operator, 4503 means unconfigured. */
export function classifyCloseCode(code: number): Outcome {
  if (code === 4401 || code === 4403 || code === 1008) return "not_allowed";
  if (code === 4503) return "not_configured";
  return "retry";
}

// Activity

/** Adds a live item to the front of the feed, once, keeping at most `cap` items. */
export function addActivity(items: readonly ActivityItem[], item: ActivityItem, cap = 500): ActivityItem[] {
  if (items.some((existing) => existing.id === item.id)) return [...items];
  return [item, ...items].slice(0, cap);
}

/** Appends a further page, skipping items already shown. */
export function appendActivity(items: readonly ActivityItem[], page: readonly ActivityItem[]): ActivityItem[] {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.filter((item) => !seen.has(item.id))];
}

// Chat

export type TurnStatus = "streaming" | "completed" | "aborted" | "failed";

export interface ChatMessage {
  role: "operator" | "agent";
  text: string;
  at: string;
  turnId?: string;
  status?: TurnStatus;
  note?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  /** Tokens or a finish that arrived before the turn id came back from chat.send. */
  early: Record<string, { text: string; status?: Exclude<TurnStatus, "streaming">; note?: string }>;
}

export const emptyChat: ChatState = { messages: [], early: {} };

export function chatFromHistory(history: ReadonlyArray<{ role: "operator" | "agent"; text: string; at: string }>): ChatState {
  return { messages: history.map((entry) => ({ role: entry.role, text: entry.text, at: entry.at })), early: {} };
}

export function chatOperatorSaid(state: ChatState, text: string, at: string): ChatState {
  return { ...state, messages: [...state.messages, { role: "operator", text, at }] };
}

/** The turn id came back: open the agent message, folding in anything that arrived early. */
export function chatTurnStarted(state: ChatState, turnId: string, at: string): ChatState {
  const early = state.early[turnId];
  const rest = { ...state.early };
  delete rest[turnId];
  const message: ChatMessage = { role: "agent", text: early?.text ?? "", at, turnId, status: early?.status ?? "streaming" };
  if (early?.note) message.note = early.note;
  return { messages: [...state.messages, message], early: rest };
}

export function chatDelta(state: ChatState, turnId: string, text: string): ChatState {
  const index = state.messages.findIndex((message) => message.turnId === turnId);
  if (index === -1) {
    const early = state.early[turnId] ?? { text: "" };
    return { ...state, early: { ...state.early, [turnId]: { ...early, text: early.text + text } } };
  }
  const current = state.messages[index]!;
  if (current.status !== "streaming") return state;
  const messages = [...state.messages];
  messages[index] = { ...current, text: current.text + text };
  return { ...state, messages };
}

export function chatDone(state: ChatState, turnId: string, status: Exclude<TurnStatus, "streaming">, note?: string): ChatState {
  const index = state.messages.findIndex((message) => message.turnId === turnId);
  if (index === -1) {
    const early = state.early[turnId] ?? { text: "" };
    const entry: ChatState["early"][string] = { ...early, status };
    if (note) entry.note = note;
    return { ...state, early: { ...state.early, [turnId]: entry } };
  }
  const messages = [...state.messages];
  const updated: ChatMessage = { ...messages[index]!, status };
  if (note) updated.note = note;
  messages[index] = updated;
  return { ...state, messages };
}

export function chatStreamingTurn(state: ChatState): string | null {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]!;
    if (message.status === "streaming" && message.turnId) return message.turnId;
  }
  return null;
}

// Pipeline

/** The deal stages in order; a stage the server reports that is not listed here goes after them. */
export const DEAL_STAGES = ["prospecting", "contacted", "engaged", "demo_scheduled", "trial", "proposal", "negotiation", "closed_won", "closed_lost"] as const;

export function stageOrder(extra: Iterable<string>): string[] {
  const order: string[] = [...DEAL_STAGES];
  for (const stage of extra) if (!order.includes(stage)) order.push(stage);
  return order;
}

export function groupByStage<T extends { stage: string }>(deals: readonly T[], stages: readonly string[]): Array<{ stage: string; deals: T[] }> {
  const order = stageOrder([...stages, ...deals.map((deal) => deal.stage)]);
  return order.map((stage) => ({ stage, deals: deals.filter((deal) => deal.stage === stage) }));
}

// Flags

/**
 * Flags earned autonomy reads that are not named autonomy:<class>. Kept in step with core's
 * AUTONOMY_FLAGS (packages/core/src/autonomy/flags.ts); the server enforces the same rule.
 */
export const AUTONOMY_FLAG_KEYS: readonly string[] = Object.freeze(["autonomy_review:enabled", "inbound:auto_send_tier"]);

/** Autonomy keys change only through the two-step operator command, never from the flags list. */
export function isFlagEditable(key: string): boolean {
  return !key.startsWith("autonomy") && !AUTONOMY_FLAG_KEYS.includes(key);
}

export type FlagInput = { ok: true; value: string } | { ok: false; message: string };

/** Checks a value typed for a flag against its kind before it is sent. */
export function parseFlagInput(kind: string, raw: string): FlagInput {
  const value = raw.trim();
  if (value === "") return { ok: false, message: "Enter a value, or use Unset to return to the default." };
  if (kind === "boolean" && value !== "true" && value !== "false") return { ok: false, message: "A boolean flag takes true or false." };
  if (kind === "number" && !Number.isFinite(Number(value))) return { ok: false, message: "A number flag takes a number." };
  return { ok: true, value };
}
