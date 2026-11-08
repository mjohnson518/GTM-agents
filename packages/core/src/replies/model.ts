// GTM-agents: one model call for reply handling, through the model gateway port with a role.
//
// The model id and its price come from gtm.config.ts (models.roles and models.pricing). A role with
// no model or no price is unavailable, and so is a gateway that is not configured. Every call is
// checked against the budget first (the spend gate: the job's daily cap, the global limits and the
// run ceiling, failing closed) and its cost is recorded after. A call that fails or times out is
// recorded at an upper estimate, since it may have been billed. Nothing here ever throws.
//
// `called` tells the caller whether a model was reached: a refusal before the call (no model, no
// price, budget) costs nothing and may be retried soon; a failed call may have cost money.
import type { GtmConfig } from "../config/schema.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { ModelGateway, ModelRole } from "../ports/model.ts";
import type { ReviewSpend } from "../quality/reviewer.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";

export interface ModelCallDeps {
  model: ModelGateway | undefined;
  config: Pick<GtmConfig, "models">;
  /** The spend gate for this run (sourcing/spend.ts createSpendGate satisfies it). */
  spend: ReviewSpend;
  job: string;
  runId?: string;
  timeoutMs: number;
  log?: JobLogger;
}

export interface ModelCallRequest {
  role: Extract<ModelRole, "triage" | "writer">;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  /** Ids for gateway logs, never prompt content. */
  metadata?: Record<string, string>;
}

export type ModelCallResult = { ok: true; text: string; model: string } | { ok: false; reason: string; called: boolean };

export async function callModel(deps: ModelCallDeps, request: ModelCallRequest): Promise<ModelCallResult> {
  if (!deps.model) return { ok: false, reason: "no model gateway is configured", called: false };
  const modelId = deps.config.models.roles[request.role];
  const price = modelId ? deps.config.models.pricing[modelId] : undefined;
  if (!modelId || !price) return { ok: false, reason: `the ${request.role} role needs a model in models.roles and its price in models.pricing`, called: false };
  try {
    if (!(await deps.spend.allow())) return { ok: false, reason: "the budget refused the call", called: false };
  } catch (error) {
    return { ok: false, reason: `the budget could not be read: ${sanitizeErrorMessage(error)}`, called: false };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the ${request.role} model did not answer within ${deps.timeoutMs} ms`));
    }, deps.timeoutMs);
  });
  let recorded = false;
  try {
    const result = await Promise.race([
      deps.model.complete({
        role: request.role,
        model: modelId,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        jsonSchema: request.jsonSchema,
        maxTokens: request.maxTokens,
        temperature: 0,
        metadata: { job: deps.job, ...(deps.runId ? { run_id: deps.runId } : {}), ...(request.metadata ?? {}) },
        signal: controller.signal,
      }),
      timeout,
    ]);
    const billed = result.model || modelId;
    const billedPrice = deps.config.models.pricing[billed];
    await deps.spend.recordModel({ provider: deps.model.name, model: billed, usage: result.usage, price: billedPrice ?? price });
    recorded = true;
    if (!billedPrice) return { ok: false, reason: `the gateway answered with ${billed}, which has no price in models.pricing`, called: true };
    return { ok: true, text: result.text, model: billed };
  } catch (error) {
    if (!recorded) {
      const estimate = { inputTokens: Math.ceil((request.system.length + request.user.length) / 4), outputTokens: request.maxTokens };
      await deps.spend.recordModel({ provider: deps.model.name, model: modelId, usage: estimate, price }).catch(() => undefined);
    }
    deps.log?.warn(`the ${request.role} model call failed`, { error: sanitizeErrorMessage(error) });
    return { ok: false, reason: `the ${request.role} model could not run: ${sanitizeErrorMessage(error)}`, called: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The first JSON object in a model's answer: the whole text, or the span from the first "{" to the last "}". */
export function jsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = text.trim();
  const tries = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(trimmed.slice(start, end + 1));
  for (const candidate of tries) {
    try {
      out.push(JSON.parse(candidate));
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return out;
}
