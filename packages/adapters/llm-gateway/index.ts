// GTM-agents: the llm-gateway adapter: the ModelGateway port over the Anthropic Messages API.
//
// It translates and decides nothing. Core picks the role and the model id (from gtm.config.ts),
// checks the budget before the call and prices the usage after it; this adapter builds the vendor
// request, sends it through ctx.fetch and maps the answer back:
//   - core's neutral content blocks become Messages API blocks (a tool result's toolCallId becomes
//     tool_use_id); blocks the vendor returned earlier in the loop (reasoning blocks included) are
//     passed back unchanged, as the API requires within a tool loop;
//   - stop_reason maps to end, tool_use, max_tokens or other, and usage keeps cache write and read
//     tokens apart so core can price them at their own multipliers;
//   - HTTP failures become AdapterError with a code and a retryable flag.
//
// stream() sends the same request with `stream: true` and reads the server-sent events: text deltas
// go to onText as they arrive, tool inputs, reasoning blocks and signatures are assembled, and the
// finished message goes through the same mapping as complete(), so core gets the same result and
// prices the same usage (message_delta's counts are cumulative and override message_start's). An
// error event mid-stream, a stream that ends before message_stop, or a cut connection becomes an
// AdapterError; aborting the request's signal stops the read. After a server-side fallback inside a
// stream, the blocks before the last fallback boundary that the API does not accept back (reasoning,
// tool calls, unpaired server tool calls) are left out of the returned content, as the API requires.
//
// Options (adapters.llm-gateway.options in gtm.config.ts, none of them secret):
//   aiGatewayBaseUrl  route through Cloudflare AI Gateway: the gateway's provider URL ending in
//                     /anthropic. AI_GATEWAY_TOKEN, when set, authenticates to the gateway, and the
//                     request metadata (run, turn and job ids) is sent as gateway metadata
//   byok              with an authenticated gateway, leave the provider key out and let the gateway
//                     supply the key it stores
//   anthropicVersion  the anthropic-version header; defaults to 2026-10-21
//   roles             role to model id, used only when core sends no model id
//   promptCache       mark the system prompt for prompt caching (default true)
//   fallbacks         "default" turns on the vendor's server-side fallback for refused requests
// Secrets: ANTHROPIC_API_KEY (required), AI_GATEWAY_TOKEN (optional).
import { AdapterError, type AdapterContext, type AdapterErrorCode, type BilledUsage, type CompletionRequest, type CompletionResult, type ModelGateway, type ModelStreamHandlers } from "@gtm-agents/core/ports";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const GATEWAY_METADATA_MAX = 5;

interface GatewayOptions {
  baseUrl: string;
  viaGateway: boolean;
  byok: boolean;
  version: string;
  roles: Record<string, string>;
  promptCache: boolean;
  fallbacks: boolean;
}

function readOptions(options: Record<string, unknown>): GatewayOptions {
  const raw = options.aiGatewayBaseUrl;
  let baseUrl = ANTHROPIC_BASE_URL;
  if (raw !== undefined) {
    if (typeof raw !== "string" || !URL.canParse(raw) || new URL(raw).protocol !== "https:") {
      throw new AdapterError("llm-gateway: aiGatewayBaseUrl must be an https URL", "invalid", false);
    }
    baseUrl = raw.replace(/\/+$/, "");
  }
  const roles: Record<string, string> = {};
  if (options.roles && typeof options.roles === "object") {
    for (const [role, model] of Object.entries(options.roles as Record<string, unknown>)) if (typeof model === "string" && model) roles[role] = model;
  }
  return {
    baseUrl,
    viaGateway: raw !== undefined,
    byok: options.byok === true,
    version: typeof options.anthropicVersion === "string" && options.anthropicVersion ? options.anthropicVersion : DEFAULT_ANTHROPIC_VERSION,
    roles,
    promptCache: options.promptCache !== false,
    fallbacks: options.fallbacks === "default",
  };
}

type Block = Record<string, unknown>;

/** Core's neutral blocks to Messages API blocks. Anything else came from this vendor and goes back unchanged. */
function toVendorBlock(block: Block): Block {
  switch (block.type) {
    case "tool_result": {
      if (typeof block.tool_use_id === "string") return block;
      if (typeof block.toolCallId !== "string" || block.toolCallId === "") throw new AdapterError("llm-gateway: a tool result needs a toolCallId", "invalid", false);
      return { type: "tool_result", tool_use_id: block.toolCallId, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""), ...(block.isError === true ? { is_error: true } : {}) };
    }
    case "text":
      if (typeof block.text !== "string") throw new AdapterError("llm-gateway: a text block needs text", "invalid", false);
      return block;
    case "tool_use":
      if (typeof block.id !== "string" || typeof block.name !== "string") throw new AdapterError("llm-gateway: a tool_use block needs an id and a name", "invalid", false);
      return block;
    default:
      if (typeof block.type !== "string") throw new AdapterError("llm-gateway: a content block needs a type", "invalid", false);
      return block;
  }
}

export function buildRequestBody(req: CompletionRequest, model: string, options: Pick<GatewayOptions, "version" | "promptCache" | "fallbacks">): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxTokens,
    ...(req.system ? { system: [{ type: "text", text: req.system, ...(options.promptCache ? { cache_control: { type: "ephemeral" } } : {}) }] } : {}),
    messages: req.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(toVendorBlock) })),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    ...(req.jsonSchema ? { output_config: { format: { type: "json_schema", schema: req.jsonSchema } } } : {}),
    // API version 2026-10-21 refuses sampling parameters; they are sent only on the older version.
    ...(req.temperature !== undefined && options.version === "2023-06-01" ? { temperature: req.temperature } : {}),
    ...(options.fallbacks ? { fallbacks: "default" } : {}),
  };
}

function mapStopReason(reason: unknown): CompletionResult["stopReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    default:
      return "other";
  }
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseResponse(data: unknown, requestedModel: string): CompletionResult {
  if (!isObject(data) || !Array.isArray(data.content)) throw new AdapterError("llm-gateway: the response is not a Messages API response", "unknown", false);
  const content = data.content.filter(isObject);
  const text = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  const toolCalls = content
    .filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
    .map((b) => ({ id: b.id as string, name: b.name as string, input: isObject(b.input) ? b.input : {} }));
  const usage = isObject(data.usage) ? data.usage : {};
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  return {
    text,
    toolCalls,
    stopReason: mapStopReason(data.stop_reason),
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    model: typeof data.model === "string" && data.model ? data.model : requestedModel,
    cost: { provider: "anthropic", capability: "messages", units: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens },
    content,
  };
}

function classify(status: number): { code: AdapterErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth", retryable: false };
  if (status === 402) return { code: "quota", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 408) return { code: "timeout", retryable: true };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 400 || status === 413 || status === 422) return { code: "invalid", retryable: false };
  if (status >= 500) return { code: "unavailable", retryable: true };
  return { code: "unknown", retryable: false };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

async function errorFrom(response: Response): Promise<AdapterError> {
  let detail = "";
  try {
    const body = await response.json<unknown>();
    const err = isObject(body) && isObject(body.error) ? body.error : {};
    const type = typeof err.type === "string" ? err.type : "";
    const message = typeof err.message === "string" ? err.message.slice(0, 200) : "";
    detail = [type, message].filter(Boolean).join(": ");
  } catch {
    // The body is not JSON; the status says enough.
  }
  const { code, retryable } = classify(response.status);
  const after = retryAfterMs(response);
  return new AdapterError(`anthropic answered HTTP ${response.status}${detail ? ` (${detail})` : ""}`, code, retryable, after !== undefined ? { retryAfterMs: after } : {});
}

function gatewayMetadata(metadata: Record<string, string> | undefined): string | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata)
    .filter(([k, v]) => typeof v === "string" && /^[a-z0-9_]{1,40}$/i.test(k))
    .slice(0, GATEWAY_METADATA_MAX)
    .map(([k, v]) => [k, v.slice(0, 120)]);
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : undefined;
}

/** A failure while a request is in flight or its body is read: a time-out, a cancel, or a lost connection. */
function transportError(error: unknown, lost: string): AdapterError {
  if (error instanceof AdapterError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return new AdapterError("anthropic did not answer in time", "timeout", true, { cause: error });
  if (name === "AbortError") return new AdapterError("the model call was cancelled", "timeout", false, { cause: error });
  return new AdapterError(lost, "unavailable", true, { cause: error });
}

/** One server-sent event: its name and its data lines joined. */
export interface SseEvent {
  event: string;
  data: string;
}

const cancelled = () => new AdapterError("the model call was cancelled", "timeout", false);

/**
 * Server-sent events from a response body, decoded as UTF-8 across chunk boundaries. Lines end with
 * CRLF, LF or CR; a line starting with ":" is a comment; an event without data is skipped, and so is
 * an event the body ends in the middle of. Aborting `signal` stops the read at once.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let finished = false;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!finished) {
      if (signal?.aborted) throw cancelled();
      const read = await reader.read();
      if (signal?.aborted) throw cancelled();
      finished = read.done;
      buffer += finished ? decoder.decode() : decoder.decode(read.value, { stream: true });
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const c = buffer[i];
        if (c !== "\n" && c !== "\r") continue;
        // A CR at the end of what has arrived may be the first half of a CRLF: wait for the next chunk.
        if (c === "\r" && i + 1 === buffer.length && !finished) break;
        const line = buffer.slice(start, i);
        if (c === "\r" && buffer[i + 1] === "\n") i += 1;
        start = i + 1;
        if (line === "") {
          if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      buffer = buffer.slice(start);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Stop reading a body that is abandoned part way (an error event, a cancel).
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function streamErrorFrom(error: unknown): AdapterError {
  const err = isObject(error) ? error : {};
  const type = typeof err.type === "string" ? err.type : "error";
  const message = typeof err.message === "string" ? err.message.slice(0, 200) : "";
  const detail = `anthropic reported ${type} during the stream${message ? ` (${message})` : ""}`;
  switch (type) {
    case "overloaded_error":
    case "api_error":
      return new AdapterError(detail, "unavailable", true);
    case "rate_limit_error":
      return new AdapterError(detail, "rate_limited", true);
    case "timeout_error":
      return new AdapterError(detail, "timeout", true);
    case "authentication_error":
    case "permission_error":
      return new AdapterError(detail, "auth", false);
    case "not_found_error":
      return new AdapterError(detail, "not_found", false);
    case "invalid_request_error":
    case "request_too_large":
      return new AdapterError(detail, "invalid", false);
    default:
      return new AdapterError(detail, "unknown", false);
  }
}

const isServerToolResult = (block: Block): boolean => typeof block.type === "string" && block.type.endsWith("_tool_result") && typeof block.tool_use_id === "string";

/**
 * The content to send back after a server-side fallback inside a stream: before the last fallback
 * block, only text, the fallback markers and server tool calls with their results are kept.
 */
export function echoableContent(content: Block[]): Block[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary <= 0) return content;
  const before = content.slice(0, boundary);
  const paired = new Set(before.filter(isServerToolResult).map((b) => b.tool_use_id as string));
  const kept = before.filter((b) => {
    if (b.type === "text" || b.type === "fallback") return true;
    if (b.type === "server_tool_use") return typeof b.id === "string" && paired.has(b.id);
    return isServerToolResult(b) && before.some((u) => u.type === "server_tool_use" && u.id === b.tool_use_id);
  });
  return [...kept, ...content.slice(boundary)];
}

/**
 * What a stream that stopped early was billed: the input the vendor reported at message_start, and
 * the output it reported or, when the stream ended before that, an estimate from what arrived (a
 * token is rarely under three characters, so it errs high). Undefined before message_start, when
 * nothing was billed. Pure.
 */
export function billedSoFar(usage: Record<string, unknown>, streamedChars: number, started: boolean): BilledUsage | undefined {
  if (!started) return undefined;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: Math.max(count(usage.output_tokens), Math.ceil(streamedChars / 3)),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
}

/**
 * Read a streamed Messages API response into the message it describes, handing text to `onText` as
 * it arrives. A stream that stops after it started (cancelled, cut off, or ended by an error event)
 * throws an AdapterError carrying what was billed so far, so the caller still records its cost.
 */
export async function readStreamedMessage(body: ReadableStream<Uint8Array>, onText: (text: string) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const usage: Record<string, unknown> = {};
  const seen = { chars: 0, started: false };
  try {
    return await readStream(body, onText, usage, seen, signal);
  } catch (error) {
    const billed = billedSoFar(usage, seen.chars, seen.started);
    const base = transportError(error, "the stream from anthropic was cut off");
    if (!billed) throw base;
    throw new AdapterError(base.message, base.code, base.retryable, { cause: base.cause ?? error, usage: billed, ...(base.retryAfterMs !== undefined ? { retryAfterMs: base.retryAfterMs } : {}) });
  }
}

async function readStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void, usage: Record<string, unknown>, seen: { chars: number; started: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let message: Record<string, unknown> | null = null;
  const blocks: Array<Block | undefined> = [];
  const json = new Map<number, string>();
  const invalid = new Set<number>();
  let stopReason: unknown = null;
  let stopped = false;
  const emit = (text: string) => {
    try {
      onText(text);
    } catch {
      // Display only: a failing viewer never fails the call.
    }
  };
  for await (const sse of readSse(body, signal)) {
    let payload: unknown;
    try {
      payload = JSON.parse(sse.data);
    } catch (error) {
      throw new AdapterError("anthropic streamed an event that is not JSON", "unknown", false, { cause: error });
    }
    if (!isObject(payload)) continue;
    const index = typeof payload.index === "number" && Number.isInteger(payload.index) && payload.index >= 0 ? payload.index : -1;
    switch (payload.type) {
      case "message_start":
        if (!isObject(payload.message)) throw new AdapterError("anthropic started a stream without a message", "unknown", false);
        message = payload.message;
        seen.started = true;
        if (isObject(message.usage)) Object.assign(usage, message.usage);
        break;
      case "content_block_start":
        if (index < 0 || !isObject(payload.content_block)) break;
        blocks[index] = { ...payload.content_block };
        if (payload.content_block.type === "tool_use" || payload.content_block.type === "server_tool_use") json.set(index, "");
        break;
      case "content_block_delta": {
        const block = index >= 0 ? blocks[index] : undefined;
        const delta = isObject(payload.delta) ? payload.delta : {};
        for (const piece of [delta.text, delta.partial_json, delta.thinking]) if (typeof piece === "string") seen.chars += piece.length;
        if (!block) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
          if (block.type === "text" && delta.text) emit(delta.text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          json.set(index, `${json.get(index) ?? ""}${delta.partial_json}`);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = `${typeof block.signature === "string" ? block.signature : ""}${delta.signature}`;
        } else if (delta.type === "citations_delta" && isObject(delta.citation)) {
          const citations: unknown[] = Array.isArray(block.citations) ? (block.citations as unknown[]) : [];
          block.citations = [...citations, delta.citation];
        }
        break;
      }
      case "content_block_stop": {
        const block = index >= 0 ? blocks[index] : undefined;
        const raw = json.get(index);
        if (!block || raw === undefined) break;
        json.delete(index);
        if (raw.trim() === "") break;
        try {
          const input: unknown = JSON.parse(raw);
          if (isObject(input)) block.input = input;
          else invalid.add(index);
        } catch {
          invalid.add(index);
        }
        break;
      }
      case "message_delta":
        if (isObject(payload.delta) && "stop_reason" in payload.delta) stopReason = payload.delta.stop_reason;
        if (isObject(payload.usage)) for (const [k, v] of Object.entries(payload.usage)) if (typeof v === "number") usage[k] = v;
        break;
      case "message_stop":
        stopped = true;
        break;
      case "error":
        throw streamErrorFrom(payload.error);
      default:
        // ping, and event types added later.
        break;
    }
  }
  if (!message || !stopped) throw new AdapterError("anthropic's stream ended before the message was complete", "unavailable", true);
  // A tool call whose input never arrived whole cannot be run or sent back.
  if (invalid.size > 0 && stopReason === "tool_use") throw new AdapterError("anthropic streamed a tool call whose input is not a JSON object", "unknown", false);
  const content = blocks.filter((b, i): b is Block => b !== undefined && !invalid.has(i));
  return { ...message, content: echoableContent(content), stop_reason: stopReason, usage };
}

export function createAdapter(ctx: AdapterContext): ModelGateway {
  const options = readOptions(ctx.options);

  /** Send one Messages API request; the response is ok, or the call throws an AdapterError. */
  async function send(req: CompletionRequest, streamed: boolean): Promise<{ response: Response; model: string }> {
    const model = req.model ?? options.roles[req.role];
    if (!model) throw new AdapterError(`llm-gateway: no model is configured for the ${req.role} role`, "invalid", false);
    const gatewayToken = options.viaGateway ? ctx.optionalSecret("AI_GATEWAY_TOKEN") : undefined;
    const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": options.version };
    if (!(options.byok && gatewayToken)) {
      const key = ctx.optionalSecret("ANTHROPIC_API_KEY");
      if (!key) throw new AdapterError("llm-gateway: ANTHROPIC_API_KEY is not set; set it with wrangler secret put", "auth", false);
      headers["x-api-key"] = key;
    }
    if (gatewayToken) headers["cf-aig-authorization"] = `Bearer ${gatewayToken}`;
    const metadata = options.viaGateway ? gatewayMetadata(req.metadata) : undefined;
    if (metadata) headers["cf-aig-metadata"] = metadata;
    if (options.fallbacks) headers["anthropic-beta"] = FALLBACK_BETA;
    if (streamed) headers.accept = "text/event-stream";
    const body = JSON.stringify({ ...buildRequestBody(req, model, options), ...(streamed ? { stream: true } : {}) });

    let response: Response;
    try {
      response = await ctx.fetch(`${options.baseUrl}/v1/messages`, { method: "POST", headers, body, ...(req.signal ? { signal: req.signal } : {}) });
    } catch (error) {
      throw transportError(error, "anthropic could not be reached");
    }
    if (!response.ok) throw await errorFrom(response);
    return { response, model };
  }

  return {
    name: "anthropic",
    async complete(req) {
      const { response, model } = await send(req, false);
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        throw new AdapterError("anthropic answered with a body that is not JSON", "unknown", false, { cause: error });
      }
      return parseResponse(data, model);
    },
    async stream(req: CompletionRequest, handlers: ModelStreamHandlers) {
      const { response, model } = await send(req, true);
      if (!response.body) throw new AdapterError("anthropic answered a streamed request with no body", "unknown", false);
      let message: Record<string, unknown>;
      try {
        message = await readStreamedMessage(response.body as ReadableStream<Uint8Array>, (text) => handlers.onText(text), req.signal);
      } catch (error) {
        throw transportError(error, "the stream from anthropic was cut off");
      }
      return parseResponse(message, model);
    },
    embed() {
      return Promise.reject(new AdapterError("the Anthropic Messages API has no embeddings endpoint; configure an embedding provider for the embedding role", "invalid", false));
    },
  };
}
