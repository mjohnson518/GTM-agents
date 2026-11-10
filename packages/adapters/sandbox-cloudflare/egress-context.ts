// GTM-agents: what the egress entrypoint gives the egress rules (egress.ts) from the Worker
// environment: secrets, the model gate, the turn counter and the cost ledger.
//
// The model gate is a gate, so it fails closed. A model call is refused when the system is halted,
// when ship:enabled or ship:builds_enabled is not on, when the daily cap for job ship_build or a
// global hard limit is reached, when the task has reached its run ceiling, or when any of those
// cannot be read. Recording a call's cost is bookkeeping: it never throws and never delays the
// response. Every cost row carries job ship_build and run ship:<task>, which is what lets the daily
// cap and the per-task ceiling see the spend.
import { checkBudget, checkRunCeiling, recordCost, tokenCostMicroCents, type ModelPrice } from "@gtm-agents/core/budget";
import { isFlagOn } from "@gtm-agents/core/jobs";
import { readHalt } from "@gtm-agents/core/security";
import type { EgressContext, EgressProps, GateDecision } from "./egress.ts";
import type { SandboxOptions } from "./options.ts";
import type { ModelTurn } from "./runner.ts";

/** The job and run that the sandbox's model spend is recorded under. */
export const SHIP_BUILD_JOB = "ship_build";
export const shipRunId = (taskId: string): string => `ship:${taskId}`;

/** The bindings the sandbox classes read. */
export interface ShipSandboxEnv {
  DB: D1Database;
  KV: KVNamespace;
}

export interface EgressSetup {
  options: SandboxOptions;
  /** The deployment's coder model, or null when none is configured. */
  coderModel: string | null;
  /** The coder model's price, or undefined when it has none: then no model call is forwarded. */
  price: ModelPrice | undefined;
  /** The vendor named in cost rows. */
  provider: string;
  /** The Durable Object binding of the sandbox class, which counts each task's model turns. */
  binding: string;
}

interface TurnTaker {
  takeModelTurn(limit: number, maxInFlight: number): Promise<ModelTurn>;
  releaseModelTurn(ticket: string): Promise<void>;
}

export function createEgressContext<E extends ShipSandboxEnv>(setup: EgressSetup, env: E, props: EgressProps, runtime: { fetch: typeof fetch; waitUntil(promise: Promise<unknown>): void; now?: () => Date }): EgressContext {
  const vars = env as unknown as Record<string, unknown>;
  const flags = { get: (key: string) => env.KV.get(key) };
  const runId = shipRunId(props.taskId);
  const now = runtime.now ?? (() => new Date());
  const turnTaker = (): TurnTaker => {
    const namespace = vars[setup.binding] as DurableObjectNamespace | undefined;
    if (!namespace) throw new Error(`the ${setup.binding} binding is missing`);
    return namespace.getByName(props.taskId) as unknown as TurnTaker;
  };
  return {
    options: setup.options,
    fetch: runtime.fetch,
    secret: (name) => {
      const value = vars[name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    coderModel: setup.coderModel,
    priced: setup.price !== undefined,
    async gate(): Promise<GateDecision> {
      try {
        const halt = await readHalt(env.KV);
        if (halt.halted) return { allowed: false, message: "the system is halted" };
        for (const flag of setup.options.requiredFlags) if (!isFlagOn(await flags.get(flag))) return { allowed: false, message: `${flag} is off` };
        const budget = await checkBudget({ db: env.DB, flags, now: now(), job: SHIP_BUILD_JOB, jobCapCents: setup.options.dailySpendCents });
        if (!budget.allowed) return { allowed: false, message: budget.message };
        const run = await checkRunCeiling({ db: env.DB, flags, runId });
        if (run.state !== "ok") return { allowed: false, message: "this task has reached its spend ceiling (budget:run_ceiling_cents)" };
        return { allowed: true };
      } catch {
        return { allowed: false, message: "the gate could not be read" };
      }
    },
    async takeTurn() {
      return turnTaker().takeModelTurn(setup.options.limits.maxModelTurns, setup.options.concurrentModelCalls);
    },
    async releaseTurn(ticket) {
      try {
        await turnTaker().releaseModelTurn(ticket);
      } catch {
        // A slot that is not released goes stale on its own (IN_FLIGHT_STALE_MS).
      }
    },
    async record(usage, model) {
      try {
        const costMicroCents = tokenCostMicroCents(usage, setup.price);
        await recordCost(env.DB, { provider: setup.provider, capability: "model", model, usage, costMicroCents, job: SHIP_BUILD_JOB, runId }, now());
      } catch {
        // Bookkeeping fails open.
      }
    },
    waitUntil: (promise) => runtime.waitUntil(promise),
  };
}
