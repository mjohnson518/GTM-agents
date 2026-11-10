// GTM-agents: the model gateway port. Core asks for a role, never a model id; gtm.config.ts maps
// roles to models, and usage comes back on every call so core can write the cost ledger.
import type { Cost } from "./types.ts";

export const MODEL_ROLES = ["strategist", "worker", "writer", "judge", "triage", "classifier", "coder", "embedding"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * The content blocks core writes into `messages` when it runs a tool loop. An adapter maps them to
 * its vendor's shapes. Assistant turns are sent back as `CompletionResult.content` when the adapter
 * returned it, so vendor-specific blocks (such as reasoning blocks) survive the loop unchanged.
 */
export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface CompletionRequest {
  role: ModelRole;
  /** The model id gtm.config.ts maps the role to. Adapters use it when set; core prices the call by it. */
  model?: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }>;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** Structured output when the vendor supports it. */
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  /** Run id, job, contact id: for gateway logs, never prompt content. */
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  model: string;
  cost?: Cost;
  /**
   * The assistant turn as the vendor returned it. To continue a tool loop, send it back unchanged
   * as the assistant message's content. Core treats it as opaque.
   */
  content?: Array<Record<string, unknown>>;
}

/** Receives a streamed completion's text while the vendor produces it. */
export interface ModelStreamHandlers {
  /**
   * One piece of the answer's text, in order: the pieces joined are the result's `text`. Text the
   * vendor produces inside a tool call's input or a reasoning block is never passed here. It is for
   * display only: an exception it throws is ignored and never fails the call.
   */
  onText(text: string): void;
}

export interface ModelGateway {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /**
   * Optional: the same call as complete(), streamed. It takes the same request, resolves to the same
   * result once the vendor has finished (usage included, so core prices it exactly as a completion),
   * and hands the answer's text to `handlers.onText` as it arrives. `req.signal` stops it mid-answer.
   * Core uses it only where a person watches the answer arrive, and calls complete() on a gateway
   * that does not have it.
   */
  stream?(req: CompletionRequest, handlers: ModelStreamHandlers): Promise<CompletionResult>;
  embed(texts: string[], role?: "embedding"): Promise<{ vectors: number[][]; model: string; cost?: Cost }>;
  /** Optional cheap classifier tier: a small model returning a probability per label. */
  classify?(args: { labels: string[]; text: string; role?: "classifier" }): Promise<{ probabilities: Record<string, number>; model: string; cost?: Cost }>;
}
