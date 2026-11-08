// GTM-agents: contract and behavior tests for the llm-gateway adapter, against recorded, synthetic
// Messages API responses. Nothing here reaches the network.
import { AdapterError } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { runModelGatewayContract, type ModelScenario } from "../_contract/model-gateway.ts";
import { createAdapter } from "./index.ts";
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

async function body(request: Request): Promise<Record<string, unknown>> {
  return await request.clone().json<Record<string, unknown>>();
}

runModelGatewayContract((ctx) => createAdapter(ctx), {
  toolName: "web_fetch",
  context(...scenarios) {
    const recorded = recordedFetch(routes(scenarios));
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
