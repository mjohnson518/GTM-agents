// GTM-agents: the budget gate.
//
// Spend limits, read from flags (docs: the budget:* rows of `gtm doctor`'s flag table):
//   - a global daily and monthly limit. In "soft" mode they only report nearLimit; in "hard" mode
//     they block once reached;
//   - a per-job daily cap (budget:job:<job>:daily_cents, and a job's ceilings.maxSpendCents),
//     always enforced whatever the mode;
//   - a per-run ceiling (budget:run_ceiling_cents): tools stop at the ceiling and the run aborts at
//     1.25 times it;
//   - a per-turn chat ceiling (chat:turn_max_cents), which counts everything a turn spends,
//     delegated runs included, because their cost rows carry the turn's id.
// Spend is read from the cost ledger, the database, so it is exact.
//
// It is a gate, so it fails closed: a limit that cannot be read or does not parse, or a ledger
// that cannot be read, blocks. A limit of 0 is a real setting that forbids spend. Caps stop new
// spend once reached; a single call can still take spend past a cap.
import type { FlagReader } from "../jobs/registry.ts";
import { startOfUtcDay, startOfUtcMonth } from "../shared/kv.ts";
import { microCentsToCents } from "./cost-ledger.ts";

export const BUDGET_DEFAULTS = Object.freeze({
  dailyLimitCents: 2000,
  monthlyLimitCents: 50000,
  enforcement: "soft",
  alertThreshold: 0.8,
  runCeilingCents: 1000,
  turnCeilingCents: 50,
});

export const RUN_CEILING_ABORT_FACTOR = 1.25;

export const BUDGET_KEYS = Object.freeze({
  dailyLimitCents: "budget:daily_limit_cents",
  monthlyLimitCents: "budget:monthly_limit_cents",
  enforcement: "budget:enforcement",
  alertThreshold: "budget:alert_threshold",
  runCeilingCents: "budget:run_ceiling_cents",
  turnCeilingCents: "chat:turn_max_cents",
});

export const jobCapKey = (job: string): string => `budget:job:${job}:daily_cents`;

export interface BudgetSettings {
  dailyLimitCents: number;
  monthlyLimitCents: number;
  enforcement: "soft" | "hard";
  alertThreshold: number;
  runCeilingCents: number;
  turnCeilingCents: number;
}

export class BudgetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetReadError";
  }
}

const unset = (raw: string | null): boolean => raw === null || raw.trim() === "";

function parseCents(raw: string | null, fallback: number, key: string): number {
  if (unset(raw)) return fallback;
  const n = Number((raw ?? "").trim());
  if (!Number.isInteger(n) || n < 0) throw new BudgetReadError(`${key} must be a whole number of cents`);
  return n;
}

function parseShare(raw: string | null, fallback: number, key: string): number {
  if (unset(raw)) return fallback;
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new BudgetReadError(`${key} must be a number above 0 and at most 1`);
  return n;
}

/** Read every budget setting. Throws BudgetReadError (or the flag store's error) when one cannot be read. */
export async function readBudgetSettings(flags: FlagReader): Promise<BudgetSettings> {
  const [daily, monthly, enforcement, threshold, run, turn] = await Promise.all([
    flags.get(BUDGET_KEYS.dailyLimitCents),
    flags.get(BUDGET_KEYS.monthlyLimitCents),
    flags.get(BUDGET_KEYS.enforcement),
    flags.get(BUDGET_KEYS.alertThreshold),
    flags.get(BUDGET_KEYS.runCeilingCents),
    flags.get(BUDGET_KEYS.turnCeilingCents),
  ]);
  const mode = unset(enforcement) ? BUDGET_DEFAULTS.enforcement : (enforcement ?? "").trim();
  if (mode !== "soft" && mode !== "hard") throw new BudgetReadError(`${BUDGET_KEYS.enforcement} must be soft or hard`);
  return {
    dailyLimitCents: parseCents(daily, BUDGET_DEFAULTS.dailyLimitCents, BUDGET_KEYS.dailyLimitCents),
    monthlyLimitCents: parseCents(monthly, BUDGET_DEFAULTS.monthlyLimitCents, BUDGET_KEYS.monthlyLimitCents),
    enforcement: mode,
    alertThreshold: parseShare(threshold, BUDGET_DEFAULTS.alertThreshold, BUDGET_KEYS.alertThreshold),
    runCeilingCents: parseCents(run, BUDGET_DEFAULTS.runCeilingCents, BUDGET_KEYS.runCeilingCents),
    turnCeilingCents: parseCents(turn, BUDGET_DEFAULTS.turnCeilingCents, BUDGET_KEYS.turnCeilingCents),
  };
}

export interface SpendFilter {
  /** ISO 8601 lower bound on created_at. */
  since?: string;
  job?: string;
  runId?: string;
  turnId?: string;
}

/** Total recorded spend matching `filter`, in micro-cents. Throws when the ledger cannot be read. */
export async function spentMicroCents(db: D1Database, filter: SpendFilter): Promise<number> {
  const clauses: string[] = [];
  const params: string[] = [];
  const add = (sql: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    clauses.push(`${sql} ?${params.length}`);
  };
  add("created_at >=", filter.since);
  add("job =", filter.job);
  add("run_id =", filter.runId);
  add("turn_id =", filter.turnId);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = await db.prepare(`SELECT COALESCE(SUM(cost_micro_cents), 0) AS total FROM cost_events ${where}`).bind(...params).first<{ total: number }>();
  const total = Number(row?.total ?? 0);
  if (!Number.isFinite(total)) throw new BudgetReadError("the cost ledger returned an unreadable total");
  return total;
}

export type BudgetBlockReason = "daily_limit" | "monthly_limit" | "job_cap" | "turn_ceiling" | "run_ceiling" | "unreadable";

export type BudgetDecision =
  | { allowed: true; nearLimit: boolean; spentTodayCents: number; spentMonthCents: number; jobSpentTodayCents?: number }
  | { allowed: false; reason: BudgetBlockReason; message: string };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function unreadable(error: unknown): BudgetDecision {
  const detail = error instanceof BudgetReadError ? error.message : "the budget could not be read";
  return { allowed: false, reason: "unreadable", message: `Spend is blocked: ${detail}.` };
}

export interface BudgetCheckInput {
  db: D1Database;
  flags: FlagReader;
  now?: Date;
  /** The job the spend belongs to, so its daily cap applies. */
  job?: string;
  /** A cap from code, such as a job's ceilings.maxSpendCents. The lower of this and the flag applies. */
  jobCapCents?: number;
}

/** Whether new spend may start. */
export async function checkBudget(input: BudgetCheckInput): Promise<BudgetDecision> {
  const now = input.now ?? new Date();
  try {
    const settings = await readBudgetSettings(input.flags);
    let jobCap = input.jobCapCents;
    if (jobCap !== undefined && !(Number.isInteger(jobCap) && jobCap >= 0)) throw new BudgetReadError("a job cap must be a whole number of cents");
    if (input.job !== undefined) {
      const raw = await input.flags.get(jobCapKey(input.job));
      if (!unset(raw)) {
        const flagCap = parseCents(raw, 0, jobCapKey(input.job));
        jobCap = jobCap === undefined ? flagCap : Math.min(jobCap, flagCap);
      }
    }
    const day = startOfUtcDay(now);
    const [today, month, job] = await Promise.all([
      spentMicroCents(input.db, { since: day }),
      spentMicroCents(input.db, { since: startOfUtcMonth(now) }),
      input.job !== undefined ? spentMicroCents(input.db, { since: day, job: input.job }) : Promise.resolve(0),
    ]);
    const spentTodayCents = microCentsToCents(today);
    const spentMonthCents = microCentsToCents(month);
    const jobSpentTodayCents = microCentsToCents(job);
    if (jobCap !== undefined && jobSpentTodayCents >= jobCap) {
      return { allowed: false, reason: "job_cap", message: `The daily cap for job ${input.job ?? "(unnamed)"} is reached: ${dollars(jobSpentTodayCents)} of ${dollars(jobCap)}.` };
    }
    if (settings.enforcement === "hard") {
      if (spentTodayCents >= settings.dailyLimitCents) {
        return { allowed: false, reason: "daily_limit", message: `The daily spend limit is reached: ${dollars(spentTodayCents)} of ${dollars(settings.dailyLimitCents)}.` };
      }
      if (spentMonthCents >= settings.monthlyLimitCents) {
        return { allowed: false, reason: "monthly_limit", message: `The monthly spend limit is reached: ${dollars(spentMonthCents)} of ${dollars(settings.monthlyLimitCents)}.` };
      }
    }
    const nearLimit =
      spentTodayCents >= settings.dailyLimitCents * settings.alertThreshold || spentMonthCents >= settings.monthlyLimitCents * settings.alertThreshold;
    return { allowed: true, nearLimit, spentTodayCents, spentMonthCents, ...(input.job !== undefined ? { jobSpentTodayCents } : {}) };
  } catch (error) {
    return unreadable(error);
  }
}

/** Whether a chat turn may make another paid call. Counts the turn's delegated runs too. */
export async function checkTurnCeiling(input: { db: D1Database; flags: FlagReader; turnId: string }): Promise<BudgetDecision> {
  try {
    const settings = await readBudgetSettings(input.flags);
    const spent = microCentsToCents(await spentMicroCents(input.db, { turnId: input.turnId }));
    if (spent >= settings.turnCeilingCents) {
      return { allowed: false, reason: "turn_ceiling", message: `This turn has spent ${dollars(spent)}, its ceiling is ${dollars(settings.turnCeilingCents)}.` };
    }
    return { allowed: true, nearLimit: false, spentTodayCents: 0, spentMonthCents: 0 };
  } catch (error) {
    return unreadable(error);
  }
}

export type RunSpendState = "ok" | "ceiling" | "abort";

/** Where a run's spend stands: under the ceiling, at it (stop tools), or past 1.25 times it (abort). */
export function runSpendState(spentCents: number, ceilingCents: number): RunSpendState {
  if (spentCents >= ceilingCents * RUN_CEILING_ABORT_FACTOR) return "abort";
  if (spentCents >= ceilingCents) return "ceiling";
  return "ok";
}

/** A run's spend against its ceiling. A ledger or setting that cannot be read reads as "abort". */
export async function checkRunCeiling(input: { db: D1Database; flags: FlagReader; runId: string }): Promise<{ state: RunSpendState; spentCents: number; ceilingCents: number }> {
  try {
    const settings = await readBudgetSettings(input.flags);
    const spent = microCentsToCents(await spentMicroCents(input.db, { runId: input.runId }));
    return { state: runSpendState(spent, settings.runCeilingCents), spentCents: spent, ceilingCents: settings.runCeilingCents };
  } catch {
    return { state: "abort", spentCents: 0, ceilingCents: 0 };
  }
}
