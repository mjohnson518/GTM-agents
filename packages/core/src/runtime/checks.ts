// GTM-agents: pre-call checks for the tool dispatcher: rate limits and budgets.
//
// Pass them as `checks` when building a dispatcher. They run after the security gates and before
// the handler:
//   - rateLimitCheck counts calls to tools that declare a rateCategory. It fails open, like the
//     rate limiter it wraps;
//   - budgetCheck refuses every tool once the chat turn or the run has reached its spend ceiling,
//     and refuses paid tools once the job cap or a hard global limit is reached. A tool counts as
//     paid when it reaches a third party (it has a rateCategory), runs another agent (delegates),
//     or was never declared. It fails closed, like the budget gate it wraps.
import { checkBudget, checkRunCeiling, checkTurnCeiling } from "../budget/gate.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { ALLOWED, blocked } from "../security/action-gate.ts";
import { isUndeclaredClass } from "../security/registry.ts";
import { checkRateLimit, type RateLimit } from "../security/rate-limiter.ts";
import type { KvStore } from "../shared/kv.ts";
import type { PreCallCheck } from "./dispatcher.ts";

export interface RateLimitCheckOptions {
  kv: KvStore | undefined | null;
  /** Whose calls are counted. Defaults to one bucket for the whole deployment. */
  identifier?: string;
  limits?: Readonly<Record<string, RateLimit>>;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

export function rateLimitCheck(options: RateLimitCheckOptions): PreCallCheck {
  return async (call, cls) => {
    if (!cls.rateCategory) return ALLOWED;
    const result = await checkRateLimit(options.kv, cls.rateCategory, options.identifier ?? "global", {
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.now ? { now: options.now() } : {}),
    });
    if (result.allowed) return ALLOWED;
    return blocked("rate_limited", call.name, `the ${cls.rateCategory} rate limit is reached; try again in ${result.retryAfterSeconds ?? 60} seconds.`);
  };
}

export interface BudgetCheckOptions {
  db: D1Database;
  flags: FlagReader;
  /** The job this dispatcher works for, so the job's daily cap applies. */
  job?: string;
  jobCapCents?: number;
  /** The run whose ceiling applies. */
  runId?: string;
  /** The chat turn whose ceiling applies. */
  turnId?: string;
  now?: () => Date;
}

export function budgetCheck(options: BudgetCheckOptions): PreCallCheck {
  return async (call, cls) => {
    if (options.turnId !== undefined) {
      const turn = await checkTurnCeiling({ db: options.db, flags: options.flags, turnId: options.turnId });
      if (!turn.allowed) return blocked("over_budget", call.name, turn.message);
    }
    if (options.runId !== undefined) {
      const run = await checkRunCeiling({ db: options.db, flags: options.flags, runId: options.runId });
      if (run.state !== "ok") return blocked("over_budget", call.name, `this run has reached its spend ceiling (${run.state}).`);
    }
    if (!cls.rateCategory && !cls.delegates && !isUndeclaredClass(cls)) return ALLOWED;
    const decision = await checkBudget({
      db: options.db,
      flags: options.flags,
      ...(options.now ? { now: options.now() } : {}),
      ...(options.job !== undefined ? { job: options.job } : {}),
      ...(options.jobCapCents !== undefined ? { jobCapCents: options.jobCapCents } : {}),
    });
    return decision.allowed ? ALLOWED : blocked("over_budget", call.name, decision.message);
  };
}
