// GTM-agents: what the ship sandbox may reach. The container starts with internet access off, and
// the Durable Object routes every HTTP and HTTPS request it makes to an egress entrypoint in the
// Worker, with props naming one route. This file decides each request; index.ts wires it to the
// Worker environment.
//
//   git       the git host, for a read-only clone of the task's repository: the smart-HTTP
//             info/refs and git-upload-pack requests for that one repository, with the Worker's
//             token attached. git-receive-pack (push) is refused, and so is every other path. After
//             the clone, this route is replaced by deny.
//   registry  the package registries in options.registryHosts: GET and HEAD of package paths, no
//             query string, no credential.
//   model     the model API of the active profile, and only its completion endpoint. Before a
//             request is forwarded: the ship flags, the halt and the budget gate are checked and a
//             failure refuses (fail closed); the task's turn is counted and the request refused past
//             the limit, and while the task already has its most calls in flight (so calls that
//             read the gate together stay few); the body keeps only an allowlist of fields, with
//             `model` rewritten to the deployment's coder model and output capped; server-side
//             tools are stripped; a request that asks the provider to fetch a URL is refused; the
//             container's headers are dropped for an allowlist; the key is attached. The usage the
//             provider reports is priced and recorded in the cost ledger after the response, fire
//             and forget. A response that ends before its final usage (cut off, unreadable, or from
//             a provider that does not report it) is charged at the worst case the request allowed:
//             the output cap, and the request's size as input when no input count arrived.
//   deny      everything else.
//
// Every route checks the scheme and hostname of the request itself before attaching anything: the
// intercept matches the TLS server name, but the URL comes from the Host header, which code in the
// container controls. Redirects are returned to the container, never followed with a credential.
import type { ModelRoute, SandboxOptions } from "./options.ts";

export type EgressRoute = "git" | "registry" | "model" | "deny";

export interface EgressProps {
  route: EgressRoute;
  taskId: string;
  /** The hostname this intercept was registered for. */
  host: string;
  /** For the git route: the one repository the clone may read, lowercase owner/name. */
  repo?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export type GateDecision = { allowed: true } | { allowed: false; message: string };

export interface EgressContext {
  options: SandboxOptions;
  fetch: typeof fetch;
  secret(name: string): string | undefined;
  /** The deployment's coder model id, or null when none is configured. */
  coderModel: string | null;
  /** True when the coder model has a price, so its cost can be recorded. */
  priced: boolean;
  /** Flags, halt and budget. Must not throw; an error is a refusal. */
  gate(): Promise<GateDecision>;
  /**
   * Counts one model turn for the task and holds one of its in-flight slots. Throws when the
   * counter cannot be read (refused). `busy` means every slot is taken; no turn was used.
   */
  takeTurn(): Promise<{ allowed: boolean; turns: number; busy?: boolean; ticket?: string }>;
  /** Frees the slot a finished call held. Never throws. */
  releaseTurn(ticket: string): Promise<void>;
  /** Records the cost of one call. Bookkeeping: never awaited by the response, never throws. */
  record(usage: TokenUsage, model: string): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
}

export const MAX_MODEL_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_GIT_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_USAGE_SCAN_BYTES = 64 * 1024 * 1024;
const PACKAGE_PATH = /^\/[A-Za-z0-9@%._~!*'()+=-]+(?:\/[A-Za-z0-9@%._~!*'()+=-]+)*\/?$/;
// Beta flags for features that run on the provider's side or change what a call costs.
const SERVER_FEATURE_BETAS = /mcp|code-execution|web-fetch|web-search|files-api|skills|advisor|fallback|fast-mode|computer-use|context-1m/i;
/** The most output one model call may ask for, so one call cannot spend far past the budget gate. */
export const MAX_OUTPUT_TOKENS = 32_000;
// Vendor-defined tools the agent itself executes inside the container: these stay. Every other
// typed tool (web search, web fetch, code execution, tool search, MCP toolsets, the advisor, which
// calls a second model, and anything not known here) runs on the provider's side and is stripped.
const CLIENT_TOOL_TYPE = /^(?:custom|bash_\d{8}|text_editor_\d{8}|memory_\d{8})$/;
const API_VERSION = /^\d{4}-\d{2}-\d{2}$/;
// The request fields forwarded to the provider. Everything else is dropped: remote MCP servers and
// code-execution containers (they run on the provider's side), fallbacks and router fields (they
// would run another model), service tiers, fast mode and a pinned geography (they change the price),
// several completions at once, stored completions and audio.
const ANTHROPIC_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
  "context_management",
  "output_config",
]);
const OPENAI_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "stream",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
]);

const text = (status: number, body: string) => new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function sameHost(url: URL, host: string): boolean {
  return url.protocol === "https:" && url.port === "" && url.hostname.toLowerCase() === host.toLowerCase() && url.username === "" && url.password === "";
}

function copyHeaders(from: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

async function git(request: Request, props: EgressProps, ctx: EgressContext): Promise<Response> {
  const url = new URL(request.url);
  if (!sameHost(url, ctx.options.gitHost) || !props.repo) return text(403, `${url.hostname} is not reachable from the ship sandbox`);
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (path.includes("git-receive-pack") || url.search.includes("git-receive-pack")) return text(403, "push is refused from the ship sandbox");
  const repoPath = `/${props.repo}.git`;
  const fetchesRepo =
    (request.method === "GET" && path === `${repoPath}/info/refs` && url.search === "?service=git-upload-pack") || (request.method === "POST" && path === `${repoPath}/git-upload-pack` && url.search === "");
  if (!fetchesRepo) return text(403, "only a read-only clone of the task's repository is allowed");
  const token = ctx.secret(ctx.options.gitTokenSecret);
  if (!token) return text(503, "the git token is not configured in the Worker");
  const headers = copyHeaders(request.headers, ["accept", "content-type", "content-encoding", "git-protocol", "user-agent"]);
  headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
  // The upstream URL is rebuilt from the props, never taken from the container.
  const target = request.method === "GET" ? `${repoPath}/info/refs?service=git-upload-pack` : `${repoPath}/git-upload-pack`;
  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_GIT_REQUEST_BYTES) return text(413, "the git request is too large");
  }
  return ctx.fetch(`https://${ctx.options.gitHost}${target}`, { method: request.method, headers, redirect: "manual", ...(body ? { body } : {}) });
}

async function registry(request: Request, ctx: EgressContext): Promise<Response> {
  const url = new URL(request.url);
  if (!ctx.options.registryHosts.some((host) => sameHost(url, host))) return text(403, `${url.hostname} is not reachable from the ship sandbox`);
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "the package registry is read-only from the ship sandbox");
  if (url.search !== "" || !PACKAGE_PATH.test(url.pathname) || url.pathname.split("/").some((s) => s === "..")) return text(403, "only package reads are allowed");
  return ctx.fetch(`https://${url.hostname}${url.pathname}`, { method: request.method, headers: copyHeaders(request.headers, ["accept", "accept-encoding", "user-agent"]), redirect: "manual" });
}

/**
 * True when a request asks the provider to fetch a URL for it: an image or document block whose
 * source is a URL, or an image_url that is not inline data. A fetch made by the provider is a way
 * out of the sandbox that no intercept sees, so such a request is not forwarded. Pure.
 */
export function fetchesRemoteContent(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((item) => fetchesRemoteContent(item, depth + 1));
  if (!isRecord(value)) return false;
  if (isRecord(value.source) && value.source.type === "url") return true;
  const image = value.image_url;
  const imageUrl = typeof image === "string" ? image : isRecord(image) ? image.url : undefined;
  if (imageUrl !== undefined && !(typeof imageUrl === "string" && imageUrl.startsWith("data:"))) return true;
  return Object.values(value).some((item) => (typeof item === "object" && item !== null ? fetchesRemoteContent(item, depth + 1) : false));
}

/**
 * Rewrites a model request: the coder model, no server-side tools, and none of the options that
 * would run another model or change the price of the call. Pure; returns null for a body it will
 * not forward.
 */
export function rewriteModelRequest(api: ModelRoute["api"], body: unknown, model: string): Record<string, unknown> | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  if (fetchesRemoteContent(body.messages) || fetchesRemoteContent(body.system)) return null;
  // An allowlist, not a denylist: a field this file does not know (a service tier, a router's
  // fallback models or plugins, a new server-side feature) is dropped rather than forwarded.
  const allowed = api === "anthropic" ? ANTHROPIC_FIELDS : OPENAI_FIELDS;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(body)) if (allowed.has(field)) out[field] = value;
  out.model = model;
  // Every call has an output cap of at most MAX_OUTPUT_TOKENS, whatever the agent asked for: the
  // in-flight limit bounds overspend only as far as each call is bounded.
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    if (!(field in out)) continue;
    const asked = out[field];
    if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1) return null;
    out[field] = Math.min(asked, MAX_OUTPUT_TOKENS);
  }
  if (api === "anthropic" && typeof out.max_tokens !== "number") out.max_tokens = MAX_OUTPUT_TOKENS;
  if (api === "openai" && typeof out.max_tokens !== "number" && typeof out.max_completion_tokens !== "number") out.max_completion_tokens = MAX_OUTPUT_TOKENS;
  if (api === "anthropic") {
    if (Array.isArray(body.tools)) out.tools = body.tools.filter((t) => isRecord(t) && (t.type === undefined || (typeof t.type === "string" && CLIENT_TOOL_TYPE.test(t.type))));
  } else {
    if (Array.isArray(body.tools)) out.tools = body.tools.filter((t) => isRecord(t) && t.type === "function");
    if (body.stream === true) out.stream_options = { include_usage: true };
  }
  const names = Array.isArray(out.tools) ? new Set(out.tools.map((t) => (isRecord(t) ? (isRecord(t.function) ? t.function.name : t.name) : undefined))) : new Set<unknown>();
  if (Array.isArray(out.tools) && out.tools.length === 0) {
    delete out.tools;
    delete out.tool_choice;
  } else if (isRecord(out.tool_choice)) {
    const chosen = isRecord(out.tool_choice.function) ? out.tool_choice.function.name : out.tool_choice.name;
    if (chosen !== undefined && !names.has(chosen)) delete out.tool_choice;
  }
  return out;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Usage from one response object or stream event, merged into `into`. Pure. */
export function mergeUsage(api: ModelRoute["api"], event: unknown, into: TokenUsage): void {
  if (!isRecord(event)) return;
  if (api === "anthropic") {
    const usage = isRecord(event.usage) ? event.usage : isRecord(event.message) && isRecord(event.message.usage) ? event.message.usage : null;
    if (!usage) return;
    into.inputTokens = Math.max(into.inputTokens, count(usage.input_tokens));
    into.outputTokens = Math.max(into.outputTokens, count(usage.output_tokens));
    into.cacheWriteTokens = Math.max(into.cacheWriteTokens ?? 0, count(usage.cache_creation_input_tokens));
    into.cacheReadTokens = Math.max(into.cacheReadTokens ?? 0, count(usage.cache_read_input_tokens));
    return;
  }
  const usage = isRecord(event.usage) ? event.usage : null;
  if (!usage) return;
  const cached = isRecord(usage.prompt_tokens_details) ? count(usage.prompt_tokens_details.cached_tokens) : 0;
  into.inputTokens = Math.max(into.inputTokens, Math.max(0, count(usage.prompt_tokens) - cached));
  into.outputTokens = Math.max(into.outputTokens, count(usage.completion_tokens));
  into.cacheReadTokens = Math.max(into.cacheReadTokens ?? 0, cached);
}

/** True when an event carries a response's final usage, after which nothing more is billed. Pure. */
function isFinalUsage(api: ModelRoute["api"], event: unknown, sse: boolean): boolean {
  if (!isRecord(event) || !isRecord(event.usage)) return false;
  // A streamed Anthropic response reports its input at the start and its output in message_delta.
  return api === "anthropic" && sse ? event.type === "message_delta" : true;
}

/**
 * Reads a response body (JSON or server-sent events) and returns the usage it reports. When the
 * body ends before its final usage and `worstCase` is given, the missing counts are charged at the
 * worst case: the output at worstCase.outputTokens, and the input at worstCase.inputTokens when no
 * input count arrived. Never throws.
 */
export async function usageFromBody(api: ModelRoute["api"], body: ReadableStream<Uint8Array>, contentType: string, worstCase?: TokenUsage): Promise<TokenUsage | null> {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let final = false;
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  let seen = 0;
  const sse = contentType.includes("text/event-stream");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > MAX_USAGE_SCAN_BYTES) break;
      buffered += decoder.decode(value, { stream: true });
      if (!sse) continue;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          continue; // Not JSON: skip it.
        }
        mergeUsage(api, event, usage);
        if (isFinalUsage(api, event, true)) final = true;
      }
    }
    if (!sse) {
      const event: unknown = JSON.parse(buffered + decoder.decode());
      mergeUsage(api, event, usage);
      if (isFinalUsage(api, event, false)) final = true;
    }
  } catch {
    // Unreadable: whatever was seen so far stands, and the rest is charged at the worst case.
  } finally {
    reader.releaseLock();
  }
  if (!final && worstCase) {
    const sawInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0;
    if (!sawInput) usage.inputTokens = worstCase.inputTokens;
    usage.outputTokens = Math.max(usage.outputTokens, worstCase.outputTokens);
  }
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0 ? usage : null;
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  const body = await request.text();
  return new TextEncoder().encode(body).length > max ? null : body;
}

async function model(request: Request, ctx: EgressContext): Promise<Response> {
  const route = ctx.options.model;
  const url = new URL(request.url);
  if (!sameHost(url, route.host)) return text(403, `${url.hostname} is not reachable from the ship sandbox`);
  const completion = route.api === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const counting = url.pathname === completion;
  const tokens = route.api === "anthropic" && url.pathname === "/v1/messages/count_tokens";
  if (request.method !== "POST" || !(counting || tokens) || (url.search !== "" && url.search !== "?beta=true")) return text(403, "only the model's completion endpoint is reachable");
  if (!ctx.coderModel || !ctx.priced) return text(503, "no priced coder model is configured (models.roles.coder and models.pricing in gtm.config.ts)");
  const key = ctx.secret(route.keySecret);
  // The gateway token is for a gateway only: it is never sent to the vendor's own API.
  const gatewayToken = route.viaGateway ? ctx.secret(route.gatewayTokenSecret) : undefined;
  if (!key && !(route.byok && gatewayToken)) return text(503, "the model key is not configured in the Worker");

  const gate = await ctx.gate().catch((): GateDecision => ({ allowed: false, message: "the gate could not be read" }));
  if (!gate.allowed) return text(429, `model calls are refused: ${gate.message}`);
  let ticket: string | undefined;
  if (counting) {
    let turn: Awaited<ReturnType<EgressContext["takeTurn"]>>;
    try {
      turn = await ctx.takeTurn();
    } catch {
      return text(503, "the turn counter could not be read, so the call is refused");
    }
    if (!turn.allowed && turn.busy) return text(429, `this task already has ${ctx.options.concurrentModelCalls} model calls in flight; retry when one finishes`);
    if (!turn.allowed) return text(429, `this task has used its ${ctx.options.limits.maxModelTurns} model turns`);
    ticket = turn.ticket;
  }
  // The in-flight slot is freed when the call is over: at once when nothing is forwarded or the
  // provider answers with an error, otherwise once its usage has been read and recorded.
  const release = (): void => {
    const held = ticket;
    ticket = undefined;
    if (held) ctx.waitUntil(ctx.releaseTurn(held).catch(() => undefined));
  };
  try {
    return await forwardModel(request, ctx, ctx.coderModel, route, url, counting, key, gatewayToken, () => {
      const held = ticket;
      ticket = undefined;
      return held;
    });
  } finally {
    release();
  }
}

async function forwardModel(
  request: Request,
  ctx: EgressContext,
  coderModel: string,
  route: ModelRoute,
  url: URL,
  counting: boolean,
  key: string | undefined,
  gatewayToken: string | undefined,
  /** Hands the call's in-flight ticket to the ledger read, which frees it when it is done. */
  handOff: () => string | undefined,
): Promise<Response> {

  const raw = await readCapped(request, MAX_MODEL_REQUEST_BYTES);
  if (raw === null) return text(413, "the model request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return text(400, "the model request is not JSON");
  }
  const rewritten = rewriteModelRequest(route.api, parsed, coderModel);
  if (!rewritten) return text(400, "the model request has no messages, has an output cap that is not a whole number, or asks the provider to fetch a URL");

  const headers = new Headers({ "content-type": "application/json" });
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  if (route.api === "anthropic") {
    // The agent's CLI shapes its requests for the API version it names, so that version is kept.
    const version = request.headers.get("anthropic-version") ?? "";
    headers.set("anthropic-version", API_VERSION.test(version) ? version : "2023-06-01");
    const betas = (request.headers.get("anthropic-beta") ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter((b) => /^[a-z0-9-]{1,80}$/.test(b) && !SERVER_FEATURE_BETAS.test(b));
    if (betas.length > 0) headers.set("anthropic-beta", betas.join(","));
    if (key && !route.byok) headers.set("x-api-key", key);
  } else if (key && !route.byok) {
    headers.set("authorization", `Bearer ${key}`);
  }
  if (gatewayToken) headers.set("cf-aig-authorization", `Bearer ${gatewayToken}`);

  const sent = new TextEncoder().encode(JSON.stringify(rewritten));
  // The upstream base stands in for the API's /v1 prefix, so a gateway with its own path layout fits.
  const upstream = await ctx.fetch(`${route.upstream}${url.pathname.slice("/v1".length)}${url.search}`, {
    method: "POST",
    headers,
    body: sent,
    redirect: "manual",
  });
  if (!counting || !upstream.ok || !upstream.body) return upstream;
  const [toContainer, toLedger] = (upstream.body as ReadableStream<Uint8Array>).tee();
  const modelId = coderModel;
  const worstCase: TokenUsage = { inputTokens: Math.ceil(sent.byteLength / 3), outputTokens: outputCap(rewritten) };
  const ticket = handOff();
  ctx.waitUntil(
    usageFromBody(route.api, toLedger, upstream.headers.get("content-type") ?? "", worstCase)
      .then((usage) => (usage ? ctx.record(usage, modelId) : undefined))
      .catch(() => undefined)
      .finally(() => (ticket ? ctx.releaseTurn(ticket).catch(() => undefined) : undefined)),
  );
  return new Response(toContainer, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}

/** The most output a rewritten request can produce, for the worst-case charge. Pure. */
function outputCap(rewritten: Record<string, unknown>): number {
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const value = rewritten[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(Math.floor(value), MAX_OUTPUT_TOKENS);
  }
  return MAX_OUTPUT_TOKENS;
}

/** Decides one request from the container. Never throws: anything unexpected is refused. */
export async function handleEgress(request: Request, props: EgressProps, ctx: EgressContext): Promise<Response> {
  try {
    switch (props.route) {
      case "git":
        return await git(request, props, ctx);
      case "registry":
        return await registry(request, ctx);
      case "model":
        return await model(request, ctx);
      default:
        return text(403, `${new URL(request.url).hostname} is not reachable from the ship sandbox`);
    }
  } catch {
    return text(502, "the request could not be forwarded");
  }
}
