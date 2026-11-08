// GTM-agents: the model gateway port. Core asks for a role, never a model id; gtm.config.ts maps
// roles to models, and usage comes back on every call so core can write the cost ledger.
import type { Cost } from "./types.ts";

export const MODEL_ROLES = ["strategist", "worker", "writer", "judge", "triage", "classifier", "coder", "embedding"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface CompletionRequest {
  role: ModelRole;
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
}

export interface ModelGateway {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  embed(texts: string[], role?: "embedding"): Promise<{ vectors: number[][]; model: string; cost?: Cost }>;
  /** Optional cheap classifier tier: a small model returning a probability per label. */
  classify?(args: { labels: string[]; text: string; role?: "classifier" }): Promise<{ probabilities: Record<string, number>; model: string; cost?: Cost }>;
}
