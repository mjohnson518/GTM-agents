// GTM-agents: the hub agent: one operator chat turn as a bounded tool loop.
//
// A turn is one run row (trigger "chat") and one turn id, and every cost row it writes carries both.
// In order:
//   1. load the session. Its taint is a gate input: if it cannot be read, the turn does not run;
//   2. resolve the strategist model from gtm.config.ts and its price. A model with no valid price
//      is refused before any call, because its cost could not be recorded;
//   3. build the system prompt from config and the operator-approved brain slice only;
//   4. loop, at most maxRounds times: check the turn ceiling, the run ceiling and the budget before
//      every model call (each fails closed), call the model gateway with role "strategist", record
//      the cost, and run every tool call it asked for, one at a time, through executeToolCall with
//      the rate-limit and budget checks. Tool results go back in the user turn exactly as the
//      dispatcher returned them: sanitized and, when untrusted, fenced. When the caller shows the
//      answer live (input.onText) and the gateway streams, the call is ModelGateway.stream: the same
//      request, the same gates before it and the same cost record after it; only the text arrives
//      early. The reply is decided from the finished results either way;
//   5. record the session's taint, which only rises, and only then append the operator's message
//      and the reply to the history;
//   6. finish the run row. Run rows and cost rows are bookkeeping: if they cannot be written, the
//      turn goes on.
// Tool calls run sequentially, so a write that follows a page read in the same model response is
// checked against the taint the read just raised.
import { loadBrain } from "../brain/load.ts";
import type { BrainSlice } from "../brain/assemble.ts";
import { checkBudget, checkRunCeiling, checkTurnCeiling, readBudgetSettings } from "../budget/gate.ts";
import { microCentsToCents, recordCost, tokenCostMicroCents, type ModelPrice } from "../budget/cost-ledger.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { CompletionRequest, CompletionResult, ModelContentBlock, ModelGateway } from "../ports/model.ts";
import { AdapterError } from "../ports/types.ts";
import { budgetCheck, rateLimitCheck } from "../runtime/checks.ts";
import { executeToolCall, type ToolHandler, type ToolSession } from "../runtime/dispatcher.ts";
import { createToolRegistry, type ToolRegistry } from "../security/registry.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { isRefusedAt, type TaintLevel } from "../security/taint.ts";
import type { KvStore } from "../shared/kv.ts";
import { HUB_TOOL_DEFINITIONS, createHubToolHandlers, type ToolDefinition } from "../tools/index.ts";
import type { CreatedDraft } from "../tools/drafts-create.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { appendTurn, loadSession, raiseSessionTaint, type SessionState } from "./sessions.ts";

/** The job name chat turns record their runs and costs under, so `budget:job:operator_chat:daily_cents` caps them. */
export const CHAT_JOB = "operator_chat";
export const DEFAULT_MAX_ROUNDS = 8;
export const DEFAULT_MAX_TOKENS = 8192;

export interface AgentLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface HubAgentDeps {
  db: D1Database;
  /** Flags, rate-limit counters and the approved brain. */
  kv: KvStore;
  flags: FlagReader;
  config: GtmConfig;
  model: ModelGateway;
  /** Defaults to core's registry (CORE_TOOL_CLASSES). */
  registry?: ToolRegistry;
  /** The tools offered to the model. Defaults to web_fetch, contacts_search and drafts_create. */
  tools?: readonly ToolDefinition[];
  /** Builds the handlers for one turn. Defaults to the three hub tools. */
  handlers?: (turn: { onDraftCreated: (draft: CreatedDraft) => void }) => Record<string, ToolHandler>;
  /** The fetch web_fetch uses with the default handlers. */
  fetch?: typeof fetch;
  /** Loads the brain slice. Defaults to loadBrain(KV, "strategist"). */
  brain?: () => Promise<BrainSlice | null>;
  maxRounds?: number;
  maxTokens?: number;
  now?: () => Date;
  logger?: AgentLogger;
}

export interface TurnInput {
  sessionKey: string;
  chatId: string;
  /** The operator's message. Trusted: it comes from an allowlisted operator. */
  text: string;
  signal?: AbortSignal;
  /**
   * Receives the answer's text while the model produces it, when the gateway streams
   * (ModelGateway.stream); a gateway that does not is called as before and this is never called.
   * `round` counts this turn's model calls from 1, so a caller can tell a later answer from an
   * earlier one. It is for display only: the reply and the history are decided exactly as without
   * it, and an exception it throws is ignored.
   */
  onText?: (text: string, round: number) => void;
}

export type TurnStop = "end" | "max_tokens" | "round_limit" | "turn_ceiling" | "budget" | "unpriced" | "no_model" | "model_error" | "session_unreadable";

export interface TurnResult {
  turnId: string;
  runId: string;
  /** The text to send the operator: the model's answer plus any notice core adds. */
  reply: string;
  stop: TurnStop;
  rounds: number;
  /** The session's taint when the turn started and when it ended. */
  startTaint: TaintLevel;
  taint: TaintLevel;
  /** True when a tool was refused because of the session's taint. */
  refusedForTaint: boolean;
  /** Drafts this turn created, in order. */
  drafts: CreatedDraft[];
  /** False when the turn's messages were not added to the history (the session was cleared, or the taint could not be recorded). */
  historySaved: boolean;
}

const silent: AgentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

const READ_DESCRIPTION: Record<Exclude<TaintLevel, "none">, string> = {
  metadata: "short third-party text (contact records, snippets)",
  structured: "values extracted from untrusted text",
  full: "raw untrusted text (a web page)",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function startRun(db: D1Database, runId: string, turnId: string, at: Date, log: AgentLogger): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO execution_runs (id, task_name, trigger, status, turn_id, started_at, created_at) VALUES (?1, ?2, 'chat', 'running', ?3, ?4, ?4)`)
      .bind(runId, CHAT_JOB, turnId, at.toISOString())
      .run();
  } catch (error) {
    log.warn("chat run row could not be written", { runId, error: sanitizeErrorMessage(error) });
  }
}

async function finishRun(
  db: D1Database,
  row: { runId: string; turnId: string; started: Date; finished: Date; status: "completed" | "failed"; summary: string; error?: string },
  log: AgentLogger,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO execution_runs (id, task_name, trigger, status, turn_id, started_at, finished_at, duration_ms, summary, error, created_at)
         VALUES (?1, ?2, 'chat', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?5)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, duration_ms = excluded.duration_ms,
           summary = excluded.summary, error = excluded.error`,
      )
      .bind(
        row.runId,
        CHAT_JOB,
        row.status,
        row.turnId,
        row.started.toISOString(),
        row.finished.toISOString(),
        Math.max(0, row.finished.getTime() - row.started.getTime()),
        row.summary,
        row.error ?? null,
      )
      .run();
  } catch (error) {
    log.warn("chat run row could not be finished", { runId: row.runId, error: sanitizeErrorMessage(error) });
  }
}

/** The assistant turn in core's neutral blocks, for gateways that do not return their own content. */
function neutralAssistant(result: CompletionResult): ModelContentBlock[] {
  return [
    ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
    ...result.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
  ];
}

/** Tools offered this turn that the session refuses now but did not refuse when the turn started. */
function newlyRefused(registry: ToolRegistry, tools: readonly ToolDefinition[], from: TaintLevel, to: TaintLevel): string[] {
  return tools.map((t) => t.name).filter((name) => {
    const gate = registry.classify(name).gate;
    return isRefusedAt(gate, to) && !isRefusedAt(gate, from);
  });
}

function refusedNow(registry: ToolRegistry, tools: readonly ToolDefinition[], taint: TaintLevel): string[] {
  if (taint === "none") return [];
  return tools.map((t) => t.name).filter((name) => isRefusedAt(registry.classify(name).gate, taint));
}

/** A trusted note core adds to the operator's message, so the model knows what this session refuses. */
function sessionNote(registry: ToolRegistry, tools: readonly ToolDefinition[], taint: TaintLevel): string | null {
  if (taint === "none") return null;
  const refused = refusedNow(registry, tools, taint);
  const what = READ_DESCRIPTION[taint];
  return refused.length
    ? `[Session note from the system: this session has read ${what}, so ${refused.join(", ")} will be refused until the operator sends /clean.]`
    : `[Session note from the system: this session has read ${what}.]`;
}

export async function runHubTurn(deps: HubAgentDeps, input: TurnInput): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? silent;
  const registry = deps.registry ?? createToolRegistry();
  const tools = deps.tools ?? HUB_TOOL_DEFINITIONS;
  const maxRounds = Math.max(1, deps.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const turnId = shortId("turn");
  const runId = shortId("run");
  const started = now();
  const drafts: CreatedDraft[] = [];

  const result = (partial: Pick<TurnResult, "reply" | "stop"> & Partial<TurnResult>): TurnResult => ({
    turnId,
    runId,
    rounds: 0,
    startTaint: "full",
    taint: "full",
    refusedForTaint: false,
    drafts,
    historySaved: false,
    ...partial,
  });

  await startRun(deps.db, runId, turnId, started, log);
  const finish = async (r: TurnResult, error?: string): Promise<TurnResult> => {
    await finishRun(
      deps.db,
      {
        runId,
        turnId,
        started,
        finished: now(),
        status: error ? "failed" : "completed",
        summary: `stop=${r.stop} rounds=${r.rounds} taint=${r.taint} drafts=${r.drafts.length}`,
        ...(error ? { error } : {}),
      },
      log,
    );
    return r;
  };

  // 1. The session. Without its taint the turn cannot be gated, so it does not run.
  let state: SessionState;
  try {
    state = await loadSession(deps.db, input.sessionKey, input.chatId, now());
  } catch (error) {
    const detail = sanitizeErrorMessage(error);
    log.error("chat session could not be read", { sessionKey: input.sessionKey, error: detail });
    return finish(result({ reply: "I could not read this chat's session, so I did not run. Please try again shortly.", stop: "session_unreadable" }), detail);
  }
  const session: ToolSession = { id: input.sessionKey, taint: state.taint };
  const startTaint = state.taint;

  // 2. The model and its price.
  const modelId = deps.config.models.roles.strategist;
  if (!modelId) {
    return finish(result({ reply: "No model is configured for the strategist role. Set models.roles.strategist in gtm.config.ts.", stop: "no_model", startTaint, taint: startTaint }), "no strategist model");
  }
  const price: ModelPrice | undefined = deps.config.models.pricing[modelId];
  try {
    tokenCostMicroCents({ inputTokens: 0, outputTokens: 0 }, price);
  } catch {
    return finish(
      result({
        reply: `The strategist model (${modelId}) has no valid price in models.pricing, so its cost could not be recorded and it was not called. Add its price to gtm.config.ts.`,
        stop: "unpriced",
        startTaint,
        taint: startTaint,
      }),
      "unpriced model",
    );
  }

  // 3. The system prompt: config and the approved brain, nothing else.
  let brain: BrainSlice | null;
  try {
    brain = deps.brain ? await deps.brain() : await loadBrain({ KV: deps.kv }, "strategist");
  } catch {
    brain = null;
  }
  const system = buildSystemPrompt({ config: deps.config, brain, tools: tools.map((t) => t.name) });

  const handlers = deps.handlers
    ? deps.handlers({ onDraftCreated: (d) => drafts.push(d) })
    : createHubToolHandlers({ db: deps.db, ...(deps.fetch ? { fetch: deps.fetch } : {}), onDraftCreated: (d) => drafts.push(d), now });
  const dispatcher = {
    registry,
    handlers,
    checks: [rateLimitCheck({ kv: deps.kv }), budgetCheck({ db: deps.db, flags: deps.flags, turnId, runId, job: CHAT_JOB, now })],
    logger: { warn: (msg: string, data?: Record<string, unknown>) => log.warn(msg, data) },
  };

  const note = sessionNote(registry, tools, startTaint);
  const messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = [
    ...state.history.map((m) => ({ role: m.role, content: m.text })),
    { role: "user", content: note ? `${note}\n\n${input.text}` : input.text },
  ];

  // The turn ceiling is also enforced from an in-memory total, so a cost row that could not be
  // written (bookkeeping fails open) never lets the loop spend past the ceiling.
  let ceilingCents: number;
  try {
    ceilingCents = (await readBudgetSettings(deps.flags)).turnCeilingCents;
  } catch {
    ceilingCents = 0;
  }
  let spentMicroCents = 0;

  // 4. The loop.
  let reply = "";
  let stop: TurnStop = "end";
  let rounds = 0;
  let refusedForTaint = false;
  let notice = "";
  let failure: string | undefined;
  for (;;) {
    if (rounds >= maxRounds) {
      stop = "round_limit";
      notice = `I stopped after ${maxRounds} model rounds, the limit for one turn.`;
      break;
    }
    const turnGate = await checkTurnCeiling({ db: deps.db, flags: deps.flags, turnId });
    if (turnGate.allowed && microCentsToCents(spentMicroCents) >= ceilingCents) {
      stop = "turn_ceiling";
      notice = `I stopped because this turn reached its spend ceiling ($${(ceilingCents / 100).toFixed(2)}).`;
      break;
    }
    if (!turnGate.allowed) {
      stop = "turn_ceiling";
      notice = `I stopped because this turn reached its spend ceiling. ${turnGate.message}`;
      break;
    }
    const runGate = await checkRunCeiling({ db: deps.db, flags: deps.flags, runId });
    if (runGate.state !== "ok") {
      stop = "budget";
      notice = `I stopped because this run reached its spend ceiling (${dollars(runGate.spentCents)} of ${dollars(runGate.ceilingCents)}).`;
      break;
    }
    const budget = await checkBudget({ db: deps.db, flags: deps.flags, job: CHAT_JOB, now: now() });
    if (!budget.allowed) {
      stop = "budget";
      notice = `I stopped because spending is blocked. ${budget.message}`;
      break;
    }

    const request: CompletionRequest = {
      role: "strategist",
      model: modelId,
      system,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      maxTokens,
      metadata: { run_id: runId, turn_id: turnId, job: CHAT_JOB },
      ...(input.signal ? { signal: input.signal } : {}),
    };
    let completion: CompletionResult;
    try {
      const onText = input.onText;
      const round = rounds + 1;
      completion =
        onText && deps.model.stream
          ? await deps.model.stream(request, {
              onText: (text) => {
                try {
                  onText(text, round);
                } catch {
                  // Display only: a failing viewer never fails the turn.
                }
              },
            })
          : await deps.model.complete(request);
    } catch (error) {
      failure = sanitizeErrorMessage(error);
      stop = "model_error";
      notice = `The model call failed: ${failure}`;
      log.warn("strategist model call failed", { turnId, error: failure });
      // A call that failed after the vendor started billing it (an aborted or cut-off stream) is
      // still spend: record what the adapter says was billed, so the budget and ceilings see it.
      const billed = error instanceof AdapterError ? error.usage : undefined;
      if (billed) {
        let lost: number;
        try {
          lost = tokenCostMicroCents(billed, price);
        } catch {
          lost = 0;
        }
        const kept = await recordCost(deps.db, { provider: deps.model.name, capability: "model", model: modelId, usage: billed, costMicroCents: lost, job: CHAT_JOB, runId, turnId }, now());
        if (!kept) log.warn("chat model cost could not be recorded", { turnId, runId });
      }
      break;
    }
    rounds += 1;

    // Bookkeeping: priced by the model that served the call when it has a price (a vendor fallback
    // can serve a different model), else by the configured one; recorded with the job, run and turn.
    const servedBy: string = completion.model && Object.hasOwn(deps.config.models.pricing, completion.model) ? completion.model : modelId;
    if (servedBy !== completion.model && completion.model && completion.model !== modelId) log.warn("model served by an unpriced model; priced as the configured one", { served: completion.model, configured: modelId });
    let cost: number;
    try {
      cost = tokenCostMicroCents(completion.usage, deps.config.models.pricing[servedBy] ?? price);
    } catch {
      cost = 0;
    }
    spentMicroCents += cost;
    const recorded = await recordCost(
      deps.db,
      { provider: deps.model.name, capability: "model", model: servedBy, usage: completion.usage, costMicroCents: cost, job: CHAT_JOB, runId, turnId },
      now(),
    );
    if (!recorded) log.warn("chat model cost could not be recorded", { turnId, runId });

    if (completion.text.trim()) reply = completion.text;
    if (completion.stopReason !== "tool_use" || completion.toolCalls.length === 0) {
      if (completion.stopReason === "max_tokens") {
        stop = "max_tokens";
        notice = "My reply was cut off at the length limit.";
      }
      break;
    }

    messages.push({ role: "assistant", content: completion.content ?? neutralAssistant(completion) });
    const toolResults: ModelContentBlock[] = [];
    for (const call of completion.toolCalls) {
      const dispatched = await executeToolCall(dispatcher, session, { name: call.name, input: call.input }, input.signal ? { signal: input.signal } : {});
      if (dispatched.status === "blocked" && dispatched.code === "tainted") refusedForTaint = true;
      toolResults.push({ type: "tool_result", toolCallId: call.id, content: dispatched.content, ...(dispatched.status === "ok" ? {} : { isError: true }) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // The operator always learns, from core and not from the model, what this session now refuses.
  const finalTaint = session.taint;
  const parts = [reply.trim() || "(no reply from the model)"];
  if (notice) parts.push(notice);
  const fresh = newlyRefused(registry, tools, startTaint, finalTaint);
  if (refusedForTaint || fresh.length > 0) {
    const refused = refusedNow(registry, tools, finalTaint);
    const what = finalTaint === "none" ? "untrusted text" : READ_DESCRIPTION[finalTaint];
    parts.push(
      `Note: this session has read ${what}, so ${refused.length ? refused.join(", ") : "some tools"} ${refused.length === 1 ? "is" : "are"} refused here. ` +
        "Send /clean to start a clean session, then give me the facts you want me to use.",
    );
  }
  const finalReply = parts.join("\n\n");

  // 5. Taint first, then history. A reply that cannot be covered by its taint is not stored.
  let historySaved = false;
  let taintRecorded = false;
  try {
    taintRecorded = await raiseSessionTaint(deps.db, input.sessionKey, finalTaint, state.clearedAt, now());
  } catch (error) {
    log.error("chat session taint could not be recorded; the turn is not kept in history", { sessionKey: input.sessionKey, error: sanitizeErrorMessage(error) });
  }
  if (taintRecorded) {
    try {
      historySaved = await appendTurn(deps.db, { sessionKey: input.sessionKey, clearedAt: state.clearedAt, turnId, user: input.text, assistant: finalReply }, now());
    } catch (error) {
      log.warn("chat history could not be written", { sessionKey: input.sessionKey, error: sanitizeErrorMessage(error) });
    }
  }

  return finish(
    result({ reply: finalReply, stop, rounds, startTaint, taint: finalTaint, refusedForTaint, historySaved }),
    stop === "model_error" ? failure : undefined,
  );
}
