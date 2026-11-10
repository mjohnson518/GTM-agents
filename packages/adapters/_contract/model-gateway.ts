// GTM-agents: the shared contract for ModelGateway adapters.
//
// Call it from an adapter's contract.test.ts with recorded vendor responses:
//
//   runModelGatewayContract((ctx) => createAdapter(ctx), fixtures);
//
// It checks what core relies on, whatever the vendor:
//   - a plain completion returns text, an "end" stop reason and populated usage, including cache
//     write and read token counts, which core prices at their own multipliers;
//   - a tool-use completion returns tool calls with an id, a name and an object input;
//   - a tool call round-trips: core's neutral tool_result block, sent with the assistant turn the
//     gateway returned, reaches the vendor under the same call id with the same content;
//   - vendor failures become AdapterError with the right code and retryable flag;
//   - a gateway with the optional stream() hands the answer's text over in order, in more than one
//     piece, and resolves to the same result a completion gives: the pieces joined are its text,
//     tool calls are whole, and usage is populated so core prices a streamed call like any other.
//     A gateway without stream() provides no streamed fixtures.
import type { AdapterContext, CompletionRequest, CompletionResult, ModelContentBlock, ModelGateway } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";

/** Recorded responses a fixture must provide, answered in the order a test asks for them. */
export type ModelScenario = "text" | "tool_use" | "after_tool" | "rate_limited" | "auth_failure" | "overloaded";

/** Recorded streamed responses a gateway with stream() must provide: a text answer, and a tool call with some text before it. */
export type StreamScenario = "text_stream" | "tool_use_stream";

export interface ModelGatewayFixtures {
  /** A context whose fetch answers the given scenarios in order, and the requests it saw. */
  context(...scenarios: ModelScenario[]): { ctx: AdapterContext; calls: Request[] };
  /** For a gateway with stream() (and only then): a context whose fetch answers streamed scenarios in order. */
  streamed?: (...scenarios: StreamScenario[]) => { ctx: AdapterContext; calls: Request[] };
  /** The tool name the recorded "tool_use" response asks for. */
  toolName: string;
  /** Reads the tool result an outbound request carries, in the vendor's wire format. */
  sentToolResult(request: Request): Promise<{ toolCallId: string; content: string; isError: boolean } | null>;
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    role: "strategist",
    model: "contract-test-model",
    system: "You are a test agent for Acme.",
    messages: [{ role: "user", content: "Summarize Acme's pricing page." }],
    maxTokens: 512,
    metadata: { run_id: "run_contract", turn_id: "turn_contract", job: "contract" },
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<{ code: unknown; retryable: unknown; name: unknown }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown; name?: unknown };
    return { code: e.code, retryable: e.retryable, name: e.name };
  }
  throw new Error("expected the call to fail");
}

export function runModelGatewayContract(create: (ctx: AdapterContext) => ModelGateway, fixtures: ModelGatewayFixtures): void {
  describe("ModelGateway contract", () => {
    it("returns text, an end stop reason and populated usage, cache tokens included", async () => {
      const { ctx } = fixtures.context("text");
      const result = await create(ctx).complete(request());
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.stopReason).toBe("end");
      expect(result.toolCalls).toEqual([]);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(typeof result.usage.cacheReadTokens).toBe("number");
      expect(typeof result.usage.cacheWriteTokens).toBe("number");
      expect(result.model.length).toBeGreaterThan(0);
    });

    it("returns tool calls with an id, a name and an object input", async () => {
      const { ctx } = fixtures.context("tool_use");
      const tools = [{ name: fixtures.toolName, description: "A tool for the contract test.", inputSchema: { type: "object", properties: {} } }];
      const result = await create(ctx).complete(request({ tools }));
      expect(result.stopReason).toBe("tool_use");
      expect(result.toolCalls.length).toBeGreaterThan(0);
      const call = result.toolCalls[0];
      expect(call?.name).toBe(fixtures.toolName);
      expect(call?.id.length).toBeGreaterThan(0);
      expect(call?.input !== null && typeof call?.input === "object" && !Array.isArray(call?.input)).toBe(true);
    });

    it("round-trips a tool call: the result reaches the vendor under the same call id", async () => {
      const { ctx, calls } = fixtures.context("tool_use", "after_tool");
      const gateway = create(ctx);
      const tools = [{ name: fixtures.toolName, description: "A tool for the contract test.", inputSchema: { type: "object", properties: {} } }];
      const first: CompletionResult = await gateway.complete(request({ tools }));
      const call = first.toolCalls[0];
      if (!call) throw new Error("the tool_use fixture returned no tool call");
      const assistant: Array<Record<string, unknown>> = first.content ?? [{ type: "tool_use", id: call.id, name: call.name, input: call.input }];
      const result: ModelContentBlock = { type: "tool_result", toolCallId: call.id, content: '<tool_output source="web_fetch">Acme has three plans.</tool_output>' };
      const second = await gateway.complete(
        request({
          tools,
          messages: [
            { role: "user", content: "Summarize Acme's pricing page." },
            { role: "assistant", content: assistant },
            { role: "user", content: [result] },
          ],
        }),
      );
      expect(second.text.length).toBeGreaterThan(0);
      const sent = await fixtures.sentToolResult(calls.at(-1) as Request);
      expect(sent).toEqual({ toolCallId: call.id, content: '<tool_output source="web_fetch">Acme has three plans.</tool_output>', isError: false });
    });

    it("maps a rate limit to a retryable rate_limited AdapterError", async () => {
      const { ctx } = fixtures.context("rate_limited");
      expect(await failure(create(ctx).complete(request()))).toEqual({ code: "rate_limited", retryable: true, name: "AdapterError" });
    });

    it("maps an authentication failure to a non-retryable auth AdapterError", async () => {
      const { ctx } = fixtures.context("auth_failure");
      expect(await failure(create(ctx).complete(request()))).toEqual({ code: "auth", retryable: false, name: "AdapterError" });
    });

    it("maps an overloaded vendor to a retryable unavailable AdapterError", async () => {
      const { ctx } = fixtures.context("overloaded");
      expect(await failure(create(ctx).complete(request()))).toEqual({ code: "unavailable", retryable: true, name: "AdapterError" });
    });

    /** The gateway for a streamed scenario, or null when it does not stream (and then must provide no streamed fixtures). */
    function streaming(...scenarios: StreamScenario[]): ModelGateway | null {
      const streams = "stream" in create(fixtures.context().ctx);
      if (!streams) {
        expect(fixtures.streamed, "a gateway without stream() provides no streamed fixtures").toBeUndefined();
        return null;
      }
      if (!fixtures.streamed) throw new Error("a gateway with stream() must provide streamed fixtures");
      return create(fixtures.streamed(...scenarios).ctx);
    }

    it("streams the answer's text in order and resolves to a completion's result, usage included", async () => {
      const gateway = streaming("text_stream");
      if (!gateway?.stream) return;
      const pieces: string[] = [];
      const result = await gateway.stream(request(), { onText: (text) => pieces.push(text) });
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.join("")).toBe(result.text);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.stopReason).toBe("end");
      expect(result.toolCalls).toEqual([]);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(typeof result.usage.cacheReadTokens).toBe("number");
      expect(typeof result.usage.cacheWriteTokens).toBe("number");
      expect(result.model.length).toBeGreaterThan(0);
    });

    it("streams a tool call whole: only answer text reaches onText, and the call has an id, a name and an object input", async () => {
      const gateway = streaming("tool_use_stream");
      if (!gateway?.stream) return;
      const tools = [{ name: fixtures.toolName, description: "A tool for the contract test.", inputSchema: { type: "object", properties: {} } }];
      const pieces: string[] = [];
      const result = await gateway.stream(request({ tools }), { onText: (text) => pieces.push(text) });
      expect(result.stopReason).toBe("tool_use");
      expect(pieces.join("")).toBe(result.text);
      const call = result.toolCalls[0];
      expect(call?.name).toBe(fixtures.toolName);
      expect(call?.id.length).toBeGreaterThan(0);
      expect(call?.input !== null && typeof call?.input === "object" && !Array.isArray(call?.input) && Object.keys(call?.input ?? {}).length > 0).toBe(true);
      for (const piece of pieces) expect(piece).not.toContain(JSON.stringify(call?.input));
    });
  });
}
