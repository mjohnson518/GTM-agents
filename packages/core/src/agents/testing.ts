// GTM-agents: test doubles for agent tests: a scripted model gateway and a recording operator channel.
//
// Import them from "@gtm-agents/core/agents/testing" in tests only. The scripted model answers each
// call with the next step of a script and keeps every request, so a test can assert what the model
// was shown (for example, that a page it fetched arrived fenced in the user turn and never in the
// system prompt). The recording operator keeps every message, approval request, edit and callback
// acknowledgement, and parses updates with a function the test supplies.
import type { CompletionRequest, CompletionResult, ModelGateway } from "../ports/model.ts";
import type { ApprovalRequest, OperatorChannel, OperatorMessage, OperatorUpdate } from "../ports/operator.ts";
import { AdapterError } from "../ports/types.ts";
import { constantTimeEqual } from "../http/auth.ts";

export type ScriptStep = Partial<CompletionResult> | ((request: CompletionRequest) => Partial<CompletionResult> | Promise<Partial<CompletionResult>>);

export interface ScriptedModel extends ModelGateway {
  requests: CompletionRequest[];
  /** How each call was made, in order: "complete", or "stream" for a gateway built with `stream`. */
  modes: Array<"complete" | "stream">;
  /** Steps not yet used. */
  remaining(): number;
}

export interface ScriptedStreamOptions {
  /** Characters per streamed piece (default 4). */
  chunkChars?: number;
  /** Awaited before each piece after the first, with its index, so a test can act mid-answer. */
  between?: (index: number) => void | Promise<void>;
}

/**
 * A gateway that answers from a script. A call past the end of the script throws. With `stream`, it
 * also streams: each step's text is handed to onText in pieces before the result is returned, and an
 * aborted request signal stops it between pieces with the error a real gateway gives.
 */
export function scriptedModel(steps: ScriptStep[], options: { name?: string; model?: string; stream?: boolean | ScriptedStreamOptions } = {}): ScriptedModel {
  const queue = [...steps];
  const requests: CompletionRequest[] = [];
  const modes: ScriptedModel["modes"] = [];
  const answer = async (request: CompletionRequest, mode: "complete" | "stream"): Promise<CompletionResult> => {
    // Keep a deep copy: the loop appends to the same messages array after the call.
    requests.push({ ...request, messages: JSON.parse(JSON.stringify(request.messages)) as CompletionRequest["messages"] });
    modes.push(mode);
    const step = queue.shift();
    if (!step) throw new Error("the scripted model has no more steps");
    const partial = typeof step === "function" ? await step(request) : step;
    const toolCalls = partial.toolCalls ?? [];
    return {
      text: partial.text ?? "",
      toolCalls,
      stopReason: partial.stopReason ?? (toolCalls.length ? "tool_use" : "end"),
      usage: partial.usage ?? { inputTokens: 1000, outputTokens: 200 },
      model: partial.model ?? options.model ?? request.model ?? "scripted-model",
      ...(partial.content ? { content: partial.content } : {}),
    };
  };
  const gateway: ScriptedModel = {
    name: options.name ?? "scripted",
    requests,
    modes,
    remaining: () => queue.length,
    complete: (request) => answer(request, "complete"),
    embed() {
      return Promise.reject(new Error("the scripted model does not embed"));
    },
  };
  if (options.stream) {
    const streaming: ScriptedStreamOptions = options.stream === true ? {} : options.stream;
    const size = Math.max(1, streaming.chunkChars ?? 4);
    gateway.stream = async (request, handlers) => {
      const result = await answer(request, "stream");
      for (let at = 0, index = 0; at < result.text.length; at += size, index += 1) {
        if (index > 0) await streaming.between?.(index);
        if (request.signal?.aborted) throw new AdapterError("the model call was cancelled", "timeout", false);
        try {
          handlers.onText(result.text.slice(at, at + size));
        } catch {
          // As the port requires: a failing viewer never fails the call.
        }
      }
      return result;
    };
  }
  return gateway;
}

/** A tool call step: the model asks for one or more tools. */
export function toolStep(...calls: Array<{ name: string; input: Record<string, unknown>; id?: string }>): Partial<CompletionResult> {
  return { toolCalls: calls.map((c, i) => ({ id: c.id ?? `call_${c.name}_${i}`, name: c.name, input: c.input })), stopReason: "tool_use" };
}

export interface RecordingOperator {
  channel: OperatorChannel;
  messages: OperatorMessage[];
  approvals: ApprovalRequest[];
  edits: Array<{ messageId: string; message: OperatorMessage }>;
  acks: Array<{ callbackId: string; text?: string }>;
  /** Every text the operator was sent: messages, approval summaries and previews. */
  texts(): string[];
}

/** An operator channel that records everything. `parse` decides what parseUpdate returns. */
export function recordingOperator(parse: (request: Request) => Promise<OperatorUpdate> = () => Promise.resolve({ type: "ignored", reason: "test" })): RecordingOperator {
  const state: RecordingOperator = {
    messages: [],
    approvals: [],
    edits: [],
    acks: [],
    texts: () => [...state.messages.map((m) => m.text), ...state.approvals.map((a) => `${a.summary}\n${a.preview}`)],
    channel: undefined as unknown as OperatorChannel,
  };
  let next = 0;
  state.channel = {
    name: "recording",
    notify(message) {
      state.messages.push(message);
      next += 1;
      return Promise.resolve({ messageId: `m${next}` });
    },
    requestApproval(req) {
      state.approvals.push(req);
      next += 1;
      return Promise.resolve({ messageId: `m${next}` });
    },
    editMessage(messageId, message) {
      state.edits.push({ messageId, message });
      return Promise.resolve();
    },
    acknowledgeCallback(callbackId, text) {
      state.acks.push({ callbackId, ...(text !== undefined ? { text } : {}) });
      return Promise.resolve();
    },
    parseUpdate: (request) => parse(request),
    registerWebhook: () => Promise.resolve(),
  };
  return state;
}

/** The header the test channel reads its secret from. */
export const TEST_SECRET_HEADER = "x-test-channel-secret";

/**
 * A parseUpdate for tests that behaves like a real channel: it compares a secret header in constant
 * time before reading the body (a mismatch throws an auth AdapterError), then reads the body as an
 * OperatorUpdate written by the test. `seen` counts bodies read, so a test can prove a rejected
 * update was never parsed.
 */
export function signedUpdateParser(secret: string): { parse: (request: Request) => Promise<OperatorUpdate>; seen: { bodies: number } } {
  const seen = { bodies: 0 };
  const parse = async (request: Request): Promise<OperatorUpdate> => {
    if (!(await constantTimeEqual(request.headers.get(TEST_SECRET_HEADER) ?? "", secret))) {
      throw new AdapterError("the test channel secret does not match", "auth", false);
    }
    seen.bodies += 1;
    return await request.json<OperatorUpdate>();
  };
  return { parse, seen };
}

/** A webhook request carrying `update`, signed for signedUpdateParser when `secret` is given. */
export function updateRequest(update: OperatorUpdate, secret?: string, url = "https://agent.acme.example/api/webhooks/operator"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret !== undefined ? { [TEST_SECRET_HEADER]: secret } : {}) },
    body: JSON.stringify(update),
  });
}

/** An in-memory KV namespace with the methods core uses. Set `failing` to make every call throw. */
export interface MemoryKvNamespace {
  map: Map<string, string>;
  failing: boolean;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKv(initial: Record<string, string> = {}): MemoryKvNamespace {
  const kv: MemoryKvNamespace = {
    map: new Map(Object.entries(initial)),
    failing: false,
    get: (key) => (kv.failing ? Promise.reject(new Error("kv unavailable")) : Promise.resolve(kv.map.get(key) ?? null)),
    put: (key, value) => {
      if (kv.failing) return Promise.reject(new Error("kv unavailable"));
      kv.map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      if (kv.failing) return Promise.reject(new Error("kv unavailable"));
      kv.map.delete(key);
      return Promise.resolve();
    },
  };
  return kv;
}

/** A queue producer that records what was sent. Set `failing` to make send throw. */
export interface RecordingQueue<T> {
  sent: T[];
  failing: boolean;
  send(body: T): Promise<void>;
  sendBatch(messages: Iterable<{ body: T }>): Promise<void>;
}

export function recordingQueue<T>(): RecordingQueue<T> {
  const q: RecordingQueue<T> = {
    sent: [],
    failing: false,
    send: (body) => {
      if (q.failing) return Promise.reject(new Error("queue unavailable"));
      q.sent.push(body);
      return Promise.resolve();
    },
    sendBatch: async (messages) => {
      for (const m of messages) await q.send(m.body);
    },
  };
  return q;
}
