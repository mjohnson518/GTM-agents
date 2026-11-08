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
import { AdapterError, type AdapterContext, type AdapterErrorCode, type CompletionRequest, type CompletionResult, type ModelGateway } from "@gtm-agents/core/ports";

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

export function createAdapter(ctx: AdapterContext): ModelGateway {
  const options = readOptions(ctx.options);
  return {
    name: "anthropic",
    async complete(req) {
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
      const body = JSON.stringify(buildRequestBody(req, model, options));

      let response: Response;
      try {
        response = await ctx.fetch(`${options.baseUrl}/v1/messages`, { method: "POST", headers, body, ...(req.signal ? { signal: req.signal } : {}) });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError") throw new AdapterError("anthropic did not answer in time", "timeout", true, { cause: error });
        if (name === "AbortError") throw new AdapterError("the model call was cancelled", "timeout", false, { cause: error });
        throw new AdapterError("anthropic could not be reached", "unavailable", true, { cause: error });
      }
      if (!response.ok) throw await errorFrom(response);
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        throw new AdapterError("anthropic answered with a body that is not JSON", "unknown", false, { cause: error });
      }
      return parseResponse(data, model);
    },
    embed() {
      return Promise.reject(new AdapterError("the Anthropic Messages API has no embeddings endpoint; configure an embedding provider for the embedding role", "invalid", false));
    },
  };
}
