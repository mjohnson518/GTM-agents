// GTM-agents: the ship loop's model calls, through the model gateway port with a role.
//
// The model id and its price come from gtm.config.ts (models.roles and models.pricing): a role with
// no model or no price is unavailable, and so is a gateway that is not configured. Every call is
// checked against the budget first (the spend gate: the job's daily cap, the global limits and the
// run ceiling, failing closed) and its cost is recorded after. A completion that fails or times out
// is recorded at an upper estimate, since it may have been billed. Nothing here throws.
//
// `called` tells the caller whether a model was reached: a refusal before the call (no model, no
// price, the budget) cost nothing; a failed call may have.
import type { GtmConfig } from "@gtm-agents/core/config";
import type { JobLogger } from "@gtm-agents/core/jobs";
import type { ModelGateway, ModelRole } from "@gtm-agents/core/ports";
import { sanitizeErrorMessage } from "@gtm-agents/core/security";
import type { SpendGate } from "@gtm-agents/core/sourcing";

export interface ShipModelDeps {
  model: ModelGateway | undefined;
  config: Pick<GtmConfig, "models">;
  spend: Pick<SpendGate, "allow" | "record" | "recordModel">;
  job: string;
  runId?: string;
  log?: JobLogger;
}

export interface CompletionCall {
  role: Exclude<ModelRole, "embedding">;
  system: string;
  /** The user turn. Untrusted text goes here, fenced, and never into `system`. */
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
  /** Ids for gateway logs, never prompt content. */
  metadata?: Record<string, string>;
}

export type CompletionOutcome = { ok: true; text: string; model: string } | { ok: false; reason: string; called: boolean };

function timeoutAfter(ms: number, what: string, controller: AbortController): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${what} did not answer within ${ms} ms`));
    }, ms);
  });
  return { promise, clear: () => (timer !== undefined ? clearTimeout(timer) : undefined) };
}

/** One schema-bound completion. Never throws. */
export async function complete(deps: ShipModelDeps, call: CompletionCall): Promise<CompletionOutcome> {
  if (!deps.model) return { ok: false, reason: "no model gateway is configured", called: false };
  const modelId = deps.config.models.roles[call.role];
  const price = modelId ? deps.config.models.pricing[modelId] : undefined;
  if (!modelId || !price) return { ok: false, reason: `the ${call.role} role needs a model in models.roles and its price in models.pricing`, called: false };
  try {
    if (!(await deps.spend.allow())) return { ok: false, reason: "the budget refused the call", called: false };
  } catch (error) {
    return { ok: false, reason: `the budget could not be read: ${sanitizeErrorMessage(error)}`, called: false };
  }
  const controller = new AbortController();
  const timeout = timeoutAfter(call.timeoutMs, `the ${call.role} model`, controller);
  let recorded = false;
  try {
    const result = await Promise.race([
      deps.model.complete({
        role: call.role,
        model: modelId,
        system: call.system,
        messages: [{ role: "user", content: call.user }],
        jsonSchema: call.jsonSchema,
        maxTokens: call.maxTokens,
        temperature: 0,
        metadata: { job: deps.job, ...(deps.runId ? { run_id: deps.runId } : {}), ...(call.metadata ?? {}) },
        signal: controller.signal,
      }),
      timeout.promise,
    ]);
    const billed = result.model || modelId;
    const billedPrice = deps.config.models.pricing[billed];
    await deps.spend.recordModel({ provider: deps.model.name, model: billed, usage: result.usage, price: billedPrice ?? price });
    recorded = true;
    if (!billedPrice) return { ok: false, reason: `the gateway answered with ${billed}, which has no price in models.pricing`, called: true };
    return { ok: true, text: typeof result.text === "string" ? result.text : "", model: billed };
  } catch (error) {
    if (!recorded) {
      const estimate = { inputTokens: Math.ceil((call.system.length + call.user.length) / 4), outputTokens: call.maxTokens };
      await deps.spend.recordModel({ provider: deps.model.name, model: modelId, usage: estimate, price }).catch(() => undefined);
    }
    deps.log?.warn(`the ${call.role} model call failed`, { error: sanitizeErrorMessage(error) });
    return { ok: false, reason: `the ${call.role} model could not run: ${sanitizeErrorMessage(error)}`, called: true };
  } finally {
    timeout.clear();
  }
}

export type EmbedOutcome = { ok: true; vectors: number[][]; model: string } | { ok: false; reason: string; called: boolean };

/**
 * Embeddings for `texts`, one vector each, in order (role embedding). The role must name a model in
 * gtm.config.ts; the adapter reports what the call cost. Never throws.
 */
export async function embed(deps: ShipModelDeps, texts: readonly string[], timeoutMs: number): Promise<EmbedOutcome> {
  if (!deps.model) return { ok: false, reason: "no model gateway is configured", called: false };
  if (!deps.config.models.roles.embedding) return { ok: false, reason: "the embedding role needs a model in models.roles", called: false };
  if (texts.length === 0) return { ok: true, vectors: [], model: deps.config.models.roles.embedding };
  try {
    if (!(await deps.spend.allow())) return { ok: false, reason: "the budget refused the call", called: false };
  } catch (error) {
    return { ok: false, reason: `the budget could not be read: ${sanitizeErrorMessage(error)}`, called: false };
  }
  const controller = new AbortController();
  const timeout = timeoutAfter(timeoutMs, "the embedding model", controller);
  try {
    const result = await Promise.race([deps.model.embed([...texts], "embedding"), timeout.promise]);
    await deps.spend.record(result.cost, { provider: deps.model.name, capability: "embedding" });
    const vectors = Array.isArray(result.vectors) ? result.vectors : [];
    const usable = vectors.length === texts.length && vectors.every((v) => Array.isArray(v) && v.length > 0 && v.length === vectors[0]?.length && v.every((x) => typeof x === "number" && Number.isFinite(x)));
    if (!usable) return { ok: false, reason: "the embedding model answered with vectors that cannot be used", called: true };
    return { ok: true, vectors, model: typeof result.model === "string" && result.model ? result.model : deps.config.models.roles.embedding };
  } catch (error) {
    deps.log?.warn("the embedding call failed", { error: sanitizeErrorMessage(error) });
    return { ok: false, reason: `the embedding model could not run: ${sanitizeErrorMessage(error)}`, called: true };
  } finally {
    timeout.clear();
  }
}

/** The first JSON object in a model's answer: the whole text, or the span from the first "{" to the last "}". */
export function jsonObjectIn(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const tries = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(trimmed.slice(start, end + 1));
  for (const candidate of tries) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return null;
}
