// GTM-agents: contract and behavior tests for the llm-gateway adapter, against recorded, synthetic
// Messages API responses. Nothing here reaches the network.
import { AdapterError } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { runModelGatewayContract, type ModelScenario, type StreamScenario } from "../_contract/model-gateway.ts";
import { createAdapter, echoableContent } from "./index.ts";
import manifest from "./manifest.json";

const MESSAGES = "https://api.anthropic.com/v1/messages";
const SECRETS = { ANTHROPIC_API_KEY: "test-anthropic-key" };

const RESPONSES: Record<ModelScenario, () => Response> = {
  text: () =>
    json({
      id: "msg_text_01",
      type: "message",
      role: "assistant",
      model: "contract-test-model",
      content: [{ type: "text", text: "Acme offers three plans, billed monthly." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 18, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 },
    }),
  tool_use: () =>
    json({
      id: "msg_tool_01",
      type: "message",
      role: "assistant",
      model: "contract-test-model",
      content: [
        { type: "thinking", thinking: "", signature: "sig-synthetic-01" },
        { type: "tool_use", id: "toolu_synthetic_01", name: "web_fetch", input: { url: "https://acme.example/pricing" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 140, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
    }),
  after_tool: () =>
    json({
      id: "msg_after_01",
      type: "message",
      role: "assistant",
      model: "contract-test-model",
      content: [{ type: "text", text: "The page lists three plans." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 300, output_tokens: 22, cache_creation_input_tokens: 0, cache_read_input_tokens: 1040 },
    }),
  rate_limited: () =>
    json({ type: "error", error: { type: "rate_limit_error", message: "Request rate limit reached." } }, { status: 429, headers: { "retry-after": "30" } }),
  auth_failure: () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }),
  overloaded: () => json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }),
};

function routes(scenarios: ModelScenario[], url = MESSAGES): RecordedRoute[] {
  return scenarios.map((s) => ({ method: "POST", url, respond: () => RESPONSES[s](), times: 1 }));
}

type SseEventSpec = [event: string, data: Record<string, unknown>];

/** Server-sent events as the Messages API writes them. */
function sseText(events: SseEventSpec[], newline = "\n"): string {
  return events.map(([event, data]) => `event: ${event}${newline}data: ${JSON.stringify(data)}${newline}${newline}`).join("");
}

/** A streamed response whose body arrives `chunkBytes` bytes at a time (whole when omitted). */
function sse(events: SseEventSpec[], options: { chunkBytes?: number; newline?: string } = {}): Response {
  const bytes = new TextEncoder().encode(sseText(events, options.newline));
  const size = options.chunkBytes ?? bytes.length;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const start = (usage: Record<string, number> = { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 }): SseEventSpec => [
  "message_start",
  { type: "message_start", message: { id: "msg_stream_01", type: "message", role: "assistant", model: "contract-test-model", content: [], stop_reason: null, usage } },
];
const textBlock = (index: number, ...pieces: string[]): SseEventSpec[] => [
  ["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }],
  ...pieces.map((text): SseEventSpec => ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }]),
  ["content_block_stop", { type: "content_block_stop", index }],
];
const toolBlock = (index: number, id: string, ...json: string[]): SseEventSpec[] => [
  ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "web_fetch", input: {} } }],
  ...json.map((partial_json): SseEventSpec => ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }]),
  ["content_block_stop", { type: "content_block_stop", index }],
];
const end = (stop_reason: string, usage: Record<string, number> = { output_tokens: 18 }): SseEventSpec[] => [
  ["message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage }],
  ["message_stop", { type: "message_stop" }],
];

const TEXT_STREAM: SseEventSpec[] = [start(), ["ping", { type: "ping" }], ...textBlock(0, "Acme offers ", "three plans, ", "billed monthly."), ...end("end_turn")];
const TOOL_STREAM: SseEventSpec[] = [
  start({ input_tokens: 140, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 }),
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-synthetic-01" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ...textBlock(1, "Let me read ", "the pricing page."),
  ...toolBlock(2, "toolu_synthetic_01", '{"url": "https://ac', 'me.example/pricing"}'),
  ...end("tool_use", { output_tokens: 40 }),
];
const STREAMS: Record<StreamScenario, SseEventSpec[]> = { text_stream: TEXT_STREAM, tool_use_stream: TOOL_STREAM };

function streamRoutes(...responses: Array<() => Response>): RecordedRoute[] {
  return responses.map((respond) => ({ method: "POST", url: MESSAGES, respond, times: 1 }));
}

const streamRequest = { role: "strategist" as const, model: "contract-test-model", system: "s", messages: [{ role: "user" as const, content: "x" }], maxTokens: 64 };

async function body(request: Request): Promise<Record<string, unknown>> {
  return await request.clone().json<Record<string, unknown>>();
}

runModelGatewayContract((ctx) => createAdapter(ctx), {
  toolName: "web_fetch",
  context(...scenarios) {
    const recorded = recordedFetch(routes(scenarios));
    return { ctx: testContext({ secrets: SECRETS, fetch: recorded.fetch }), calls: recorded.calls };
  },
  streamed(...scenarios) {
    const recorded = recordedFetch(streamRoutes(...scenarios.map((scenario) => () => sse(STREAMS[scenario], { chunkBytes: 37 }))));
    return { ctx: testContext({ secrets: SECRETS, fetch: recorded.fetch }), calls: recorded.calls };
  },
  async sentToolResult(request) {
    const messages = (await body(request)).messages as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1);
    const block = Array.isArray(last?.content) ? (last.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_result") : undefined;
    if (!block) return null;
    return { toolCallId: String(block.tool_use_id), content: String(block.content), isError: block.is_error === true };
  },
});

describe("llm-gateway", () => {
  it("declares the ModelGateway port and its secrets in its manifest", () => {
    expect(manifest.ports).toEqual(["ModelGateway"]);
    expect(manifest.requiredSecrets).toEqual(["ANTHROPIC_API_KEY"]);
    expect(manifest.optionalSecrets).toEqual(["AI_GATEWAY_TOKEN"]);
  });

  it("sends the configured model, the key, the API version, a cacheable system prompt and tool schemas, and no sampling parameters", async () => {
    const recorded = recordedFetch(routes(["text"]));
    await createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch })).complete({
      role: "strategist",
      model: "contract-test-model",
      system: "You are Avery.",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "contacts_search", description: "Search contacts.", inputSchema: { type: "object" } }],
      maxTokens: 256,
      temperature: 0.2,
    });
    const request = recorded.calls[0] as Request;
    expect(request.headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(request.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
    const sent = await body(request);
    expect(sent.model).toBe("contract-test-model");
    expect(sent.max_tokens).toBe(256);
    expect(sent.system).toEqual([{ type: "text", text: "You are Avery.", cache_control: { type: "ephemeral" } }]);
    expect(sent.tools).toEqual([{ name: "contacts_search", description: "Search contacts.", input_schema: { type: "object" } }]);
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("metadata");
  });

  it("passes the vendor's own blocks, reasoning included, back unchanged within a tool loop", async () => {
    const recorded = recordedFetch(routes(["tool_use", "after_tool"]));
    const gateway = createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch }));
    const first = await gateway.complete({ role: "strategist", model: "m", system: "s", messages: [{ role: "user", content: "go" }], maxTokens: 64 });
    expect(first.usage).toEqual({ inputTokens: 140, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 0 });
    await gateway.complete({
      role: "strategist",
      model: "m",
      system: "s",
      maxTokens: 64,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: first.content ?? [] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "toolu_synthetic_01", content: "refused", isError: true }] },
      ],
    });
    const messages = (await body(recorded.calls[1] as Request)).messages as Array<{ content: unknown }>;
    expect(messages[1]?.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig-synthetic-01" },
      { type: "tool_use", id: "toolu_synthetic_01", name: "web_fetch", input: { url: "https://acme.example/pricing" } },
    ]);
    expect(messages[2]?.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_synthetic_01", content: "refused", is_error: true }]);
  });

  it("routes through an AI Gateway with its token and the request metadata, and can leave the provider key to the gateway", async () => {
    const base = "https://gateway.example/v1/account/gateway/anthropic";
    const recorded = recordedFetch([...routes(["text"], `${base}/v1/messages`), ...routes(["text"], `${base}/v1/messages`)]);
    const secrets = { ...SECRETS, AI_GATEWAY_TOKEN: "test-gateway-token" };
    const req = { role: "strategist" as const, model: "m", system: "s", messages: [{ role: "user" as const, content: "x" }], maxTokens: 16, metadata: { run_id: "run_1", turn_id: "turn_1" } };
    await createAdapter(testContext({ secrets, fetch: recorded.fetch, options: { aiGatewayBaseUrl: `${base}/` } })).complete(req);
    const viaGateway = recorded.calls[0] as Request;
    expect(viaGateway.headers.get("cf-aig-authorization")).toBe("Bearer test-gateway-token");
    expect(JSON.parse(viaGateway.headers.get("cf-aig-metadata") ?? "{}")).toEqual({ run_id: "run_1", turn_id: "turn_1" });
    expect(viaGateway.headers.get("x-api-key")).toBe("test-anthropic-key");
    await createAdapter(testContext({ secrets, fetch: recorded.fetch, options: { aiGatewayBaseUrl: base, byok: true } })).complete(req);
    expect((recorded.calls[1] as Request).headers.get("x-api-key")).toBeNull();
  });

  it("refuses an AI Gateway URL that is not https", () => {
    expect(() => createAdapter(testContext({ secrets: SECRETS, options: { aiGatewayBaseUrl: "http://gateway.example/anthropic" } }))).toThrow(AdapterError);
  });

  it("uses the role map only when core sends no model id, and refuses a role with no model", async () => {
    const recorded = recordedFetch(routes(["text"]));
    const gateway = createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch, options: { roles: { writer: "role-mapped-model" } } }));
    await gateway.complete({ role: "writer", system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 16 });
    expect((await body(recorded.calls[0] as Request)).model).toBe("role-mapped-model");
    await expect(gateway.complete({ role: "judge", system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 16 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("asks for structured output with output_config when given a JSON schema", async () => {
    const recorded = recordedFetch(routes(["text"]));
    const schema = { type: "object", properties: { plan: { type: "string" } }, required: ["plan"], additionalProperties: false };
    await createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch })).complete({ role: "classifier", model: "m", system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 16, jsonSchema: schema });
    expect((await body(recorded.calls[0] as Request)).output_config).toEqual({ format: { type: "json_schema", schema } });
  });

  it("keeps the retry-after delay on a rate limit and reports a missing key as auth", async () => {
    const recorded = recordedFetch(routes(["rate_limited"]));
    const req = { role: "strategist" as const, model: "m", system: "s", messages: [{ role: "user" as const, content: "x" }], maxTokens: 16 };
    await expect(createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch })).complete(req)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 30_000 });
    await expect(createAdapter(testContext({ secrets: {}, fetch: recorded.fetch })).complete(req)).rejects.toMatchObject({ code: "auth", retryable: false });
  });

  it("maps a time-out to a retryable timeout error and a network failure to unavailable", async () => {
    const req = { role: "strategist" as const, model: "m", system: "s", messages: [{ role: "user" as const, content: "x" }], maxTokens: 16 };
    const timeout = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
    await expect(createAdapter(testContext({ secrets: SECRETS, fetch: timeout })).complete(req)).rejects.toMatchObject({ code: "timeout", retryable: true });
    const down = () => Promise.reject(new TypeError("network down"));
    await expect(createAdapter(testContext({ secrets: SECRETS, fetch: down })).complete(req)).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("has no embeddings and says so with an AdapterError", async () => {
    await expect(createAdapter(testContext({ secrets: SECRETS })).embed(["acme"])).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("llm-gateway streaming", () => {
  function streamed(responses: Array<() => Response>, onText: (text: string) => void = () => undefined, signal?: AbortSignal) {
    const recorded = recordedFetch(streamRoutes(...responses));
    const gateway = createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch }));
    if (!gateway.stream) throw new Error("the adapter does not stream");
    const result = gateway.stream({ ...streamRequest, ...(signal ? { signal } : {}) }, { onText });
    return { result, calls: recorded.calls };
  }

  it("sends the same request as a completion with stream set, and declares streaming in its manifest", async () => {
    expect(manifest.capabilities).toContain("stream");
    const { result, calls } = streamed([() => sse(TEXT_STREAM)]);
    await result;
    const request = calls[0] as Request;
    expect(request.headers.get("accept")).toBe("text/event-stream");
    const sent = await body(request);
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe("contract-test-model");
    expect(sent.max_tokens).toBe(64);
  });

  it("decodes events split anywhere, characters split across chunks included, with any line ending", async () => {
    const events: SseEventSpec[] = [start(), ...textBlock(0, "Caf\u00e9 plans for Acme, ", "all \u{1F680} monthly."), ...end("end_turn")];
    const whole = await streamed([() => sse(events)]).result;
    for (const [chunkBytes, newline] of [
      [1, "\n"],
      [5, "\r\n"],
      [7, "\r"],
    ] as const) {
      const pieces: string[] = [];
      const result = await streamed([() => sse(events, { chunkBytes, newline })], (t) => pieces.push(t)).result;
      expect(result.text).toBe(whole.text);
      expect(pieces.join("")).toBe("Caf\u00e9 plans for Acme, all \u{1F680} monthly.");
    }
  });

  it("assembles reasoning signatures and tool inputs, so the content can be sent back unchanged", async () => {
    const pieces: string[] = [];
    const result = await streamed([() => sse(TOOL_STREAM, { chunkBytes: 11 })], (t) => pieces.push(t)).result;
    expect(pieces).toEqual(["Let me read ", "the pricing page."]);
    expect(result.toolCalls).toEqual([{ id: "toolu_synthetic_01", name: "web_fetch", input: { url: "https://acme.example/pricing" } }]);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig-synthetic-01" },
      { type: "text", text: "Let me read the pricing page." },
      { type: "tool_use", id: "toolu_synthetic_01", name: "web_fetch", input: { url: "https://acme.example/pricing" } },
    ]);
  });

  it("prices by the cumulative usage of the final message_delta", async () => {
    const events: SseEventSpec[] = [start(), ...textBlock(0, "Three plans."), ...end("end_turn", { input_tokens: 130, output_tokens: 25, cache_read_input_tokens: 40 })];
    const result = await streamed([() => sse(events)]).result;
    expect(result.usage).toEqual({ inputTokens: 130, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 900 });
  });

  it("maps an HTTP failure on a streamed request as a completion does", async () => {
    await expect(streamed([() => RESPONSES.rate_limited()]).result).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 30_000 });
  });

  it("turns an error event mid-stream into an AdapterError, after the text that came before it", async () => {
    const pieces: string[] = [];
    const events: SseEventSpec[] = [start(), ...textBlock(0, "Acme").slice(0, 2), ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]];
    await expect(streamed([() => sse(events)], (t) => pieces.push(t)).result).rejects.toMatchObject({ name: "AdapterError", code: "unavailable", retryable: true });
    expect(pieces).toEqual(["Acme"]);
  });

  it("refuses a stream that ends before message_stop", async () => {
    await expect(streamed([() => sse(TEXT_STREAM.slice(0, -1))]).result).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("carries what was billed on a stream that stops after it started, and nothing on one that never started", async () => {
    // Cut off after message_start and some text: the input as reported, the output estimated from what arrived.
    const cut: SseEventSpec[] = [start(), ...textBlock(0, "Acme has three plans and ").slice(0, 2)];
    const error = (await streamed([() => sse(cut)]).result.catch((e: unknown) => e)) as AdapterError;
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.usage?.inputTokens).toBeGreaterThan(0);
    expect(error.usage?.outputTokens).toBeGreaterThanOrEqual(Math.ceil("Acme has three plans and ".length / 3));
    // An error event after message_start carries it too.
    const overloaded = (await streamed([() => sse([start(), ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]])]).result.catch((e: unknown) => e)) as AdapterError;
    expect(overloaded.code).toBe("unavailable");
    expect(overloaded.usage).toBeDefined();
    // A request refused before any event was billed nothing.
    const refused = (await streamed([() => RESPONSES.rate_limited()]).result.catch((e: unknown) => e)) as AdapterError;
    expect(refused.usage).toBeUndefined();
  });

  it("stops reading when the request's signal is aborted mid-answer, and cancels the body", async () => {
    const bytes = new TextEncoder().encode(sseText([start(), ...textBlock(0, "Acme offers ").slice(0, 2)]));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const pieces: string[] = [];
    const { result } = streamed([() => new Response(body, { headers: { "content-type": "text/event-stream" } })], (t) => {
      pieces.push(t);
      controller.abort();
    }, controller.signal);
    await expect(result).rejects.toMatchObject({ code: "timeout", retryable: false });
    expect(pieces).toEqual(["Acme offers "]);
    expect(cancelled).toBe(true);
  });

  it("refuses a tool call whose input never arrived whole, and drops one cut off at the length limit", async () => {
    const cut = (stop: string): SseEventSpec[] => [start(), ...textBlock(0, "Reading."), ...toolBlock(1, "toolu_synthetic_02", '{"url": "https://acme'), ...end(stop)];
    await expect(streamed([() => sse(cut("tool_use"))]).result).rejects.toMatchObject({ code: "unknown", retryable: false });
    const truncated = await streamed([() => sse(cut("max_tokens"))]).result;
    expect(truncated.stopReason).toBe("max_tokens");
    expect(truncated.toolCalls).toEqual([]);
    expect(truncated.content).toEqual([{ type: "text", text: "Reading." }]);
  });

  it("never fails the call because the text viewer threw", async () => {
    const result = await streamed([() => sse(TEXT_STREAM)], () => {
      throw new Error("viewer gone");
    }).result;
    expect(result.text).toBe("Acme offers three plans, billed monthly.");
  });

  it("leaves out what the API does not take back from before a fallback boundary", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig-a" },
      { type: "text", text: "Acme has " },
      { type: "tool_use", id: "toolu_a", name: "web_fetch", input: {} },
      { type: "server_tool_use", id: "srv_a", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "srv_a", content: [] },
      { type: "server_tool_use", id: "srv_b", name: "web_search", input: {} },
      { type: "fallback", from: { model: "m1" }, to: { model: "m2" } },
      { type: "thinking", thinking: "", signature: "sig-b" },
      { type: "text", text: "three plans." },
    ];
    const label = (b: Record<string, unknown>): string => {
      const key = [b.id, b.tool_use_id, b.signature, b.text].find((v): v is string => typeof v === "string") ?? "";
      return `${String(b.type)}:${key}`;
    };
    expect(echoableContent(content).map(label)).toEqual([
      "text:Acme has ",
      "server_tool_use:srv_a",
      "web_search_tool_result:srv_a",
      "fallback:",
      "thinking:sig-b",
      "text:three plans.",
    ]);
  });
});
