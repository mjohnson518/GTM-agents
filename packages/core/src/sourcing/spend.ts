// GTM-agents: the spend gate for paid provider calls made by sourcing jobs.
//
// Every paid call in a sourcing job (a search, a people lookup, an email find, a verification, a
// model call) goes through one gate:
//   - before the call, allow() asks the budget gate (budget/gate.ts) whether new spend may start,
//     with the job's daily cap (its ceilings.maxSpendCents and any budget:job:<job>:daily_cents
//     flag). It fails closed: a refusal, or a budget that cannot be read, stops every later paid
//     call in the run, and the run reports why;
//   - with a run id, the run's own ceiling (budget:run_ceiling_cents) applies as well;
//   - after the call, record() writes the cost to the ledger with the job and run ids. Recording is
//     bookkeeping: it never throws and never fails the run.
// The job runner also checks the budget before the job starts; this gate covers the calls inside.
import { checkBudget, checkRunCeiling } from "../budget/gate.ts";
import { MICRO_CENTS_PER_CENT, recordCost, tokenCostMicroCents, type ModelPrice, type TokenUsage } from "../budget/cost-ledger.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { Cost } from "../ports/types.ts";

/** Micro-cents per US dollar: 100 cents, 10,000 micro-cents each. */
export const MICRO_CENTS_PER_USD = 100 * MICRO_CENTS_PER_CENT;

export interface SpendGate {
  /** True when a paid call may start now. Once false, it stays false for the rest of the run. */
  allow(): Promise<boolean>;
  /** Record what a provider call cost. Never throws. */
  record(cost: Cost | undefined, fallback: { provider: string; capability: string }): Promise<void>;
  /** Record what a model call cost, priced from models.pricing. Never throws. */
  recordModel(args: { provider: string; model: string; usage: TokenUsage; price: ModelPrice }): Promise<void>;
  /** Why paid calls stopped, or null while they may continue. */
  readonly stopped: string | null;
  /** Paid calls allowed so far in this run. */
  readonly calls: number;
}

export interface SpendGateOptions {
  db: D1Database;
  flags: FlagReader;
  job: string;
  runId?: string;
  /** The job's ceilings.maxSpendCents. */
  jobCapCents?: number;
  now?: () => Date;
  log?: JobLogger;
}

/** The micro-cents a provider cost stands for. Credits without a dollar price count as zero. */
export function costMicroCents(cost: Cost | undefined): number {
  const usd = cost?.usd;
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? Math.round(usd * MICRO_CENTS_PER_USD) : 0;
}

export function createSpendGate(options: SpendGateOptions): SpendGate {
  const clock = options.now ?? (() => new Date());
  let stopped: string | null = null;
  let calls = 0;
  return {
    get stopped() {
      return stopped;
    },
    get calls() {
      return calls;
    },
    async allow() {
      if (stopped !== null) return false;
      const decision = await checkBudget({
        db: options.db,
        flags: options.flags,
        now: clock(),
        job: options.job,
        ...(options.jobCapCents !== undefined ? { jobCapCents: options.jobCapCents } : {}),
      });
      if (!decision.allowed) {
        stopped = `budget: ${decision.reason}`;
        options.log?.warn("paid calls stopped", { job: options.job, reason: decision.reason });
        return false;
      }
      if (options.runId !== undefined) {
        const run = await checkRunCeiling({ db: options.db, flags: options.flags, runId: options.runId });
        if (run.state !== "ok") {
          stopped = "budget: run_ceiling";
          options.log?.warn("paid calls stopped", { job: options.job, reason: "run_ceiling" });
          return false;
        }
      }
      calls += 1;
      return true;
    },
    async record(cost, fallback) {
      if (cost && cost.usd === undefined) options.log?.warn("a provider returned a cost without a dollar price; recorded as zero", { provider: cost.provider, capability: cost.capability });
      await recordCost(
        options.db,
        {
          provider: cost?.provider ?? fallback.provider,
          capability: cost?.capability ?? fallback.capability,
          ...(cost?.units !== undefined ? { units: cost.units } : {}),
          costMicroCents: costMicroCents(cost),
          job: options.job,
          ...(options.runId !== undefined ? { runId: options.runId } : {}),
        },
        clock(),
      );
    },
    async recordModel({ provider, model, usage, price }) {
      let micro: number;
      try {
        micro = tokenCostMicroCents(usage, price);
      } catch {
        // The caller checked the price before the call; an invalid one here is recorded as unknown.
        options.log?.warn("a model call could not be priced", { provider, model });
        return;
      }
      await recordCost(
        options.db,
        { provider, capability: "model", model, usage, costMicroCents: micro, job: options.job, ...(options.runId !== undefined ? { runId: options.runId } : {}) },
        clock(),
      );
    },
  };
}
