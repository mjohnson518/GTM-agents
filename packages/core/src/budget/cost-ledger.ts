// GTM-agents: the cost ledger. Every paid call writes one row to cost_events.
//
// Costs are kept in micro-cents (10,000 per cent), so a call that costs a fraction of a cent is not
// recorded as free. Model calls are priced from `models.pricing` in gtm.config.ts, with cache writes
// and reads at their own multipliers. Every row carries the job, run and chat turn it belongs to,
// which is what lets per-job caps, run ceilings and turn ceilings see the spend.
//
// Recording is bookkeeping: recordCost never throws and never blocks the call it records. It
// returns false when the row could not be written.

export const MICRO_CENTS_PER_CENT = 10_000;

export interface ModelPrice {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
  /** Relative to the input price. Defaults to 1.25. */
  cacheWriteMultiplier?: number;
  /** Relative to the input price. Defaults to 0.1. */
  cacheReadMultiplier?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

const count = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

const validRate = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * The cost of one model call, in micro-cents, rounded to the nearest micro-cent. Throws when the
 * price is missing or invalid, so an unpriced model cannot be used as if it were free: price every
 * model in `models.pricing`.
 */
export function tokenCostMicroCents(usage: TokenUsage, price: ModelPrice | undefined): number {
  if (!price || !validRate(price.inputCentsPerMTok) || !validRate(price.outputCentsPerMTok)) {
    throw new TypeError("this model has no valid price in models.pricing, so its cost cannot be recorded");
  }
  if ((price.cacheWriteMultiplier !== undefined && !validRate(price.cacheWriteMultiplier)) || (price.cacheReadMultiplier !== undefined && !validRate(price.cacheReadMultiplier))) {
    throw new TypeError("a cache multiplier in models.pricing is invalid");
  }
  const input = price.inputCentsPerMTok / 1_000_000;
  const output = price.outputCentsPerMTok / 1_000_000;
  const cents =
    count(usage.inputTokens) * input +
    count(usage.outputTokens) * output +
    count(usage.cacheWriteTokens) * input * (price.cacheWriteMultiplier ?? 1.25) +
    count(usage.cacheReadTokens) * input * (price.cacheReadMultiplier ?? 0.1);
  return Math.round(cents * MICRO_CENTS_PER_CENT);
}

/** Micro-cents to whole cents, rounding up so a nonzero cost never reads as free. */
export function microCentsToCents(microCents: number): number {
  return Math.ceil(Math.max(0, microCents) / MICRO_CENTS_PER_CENT);
}

export interface CostEvent {
  /** The vendor, such as a model provider or a data provider. */
  provider: string;
  /** What was bought: "model", "email_find", "send" and so on. */
  capability: string;
  model?: string;
  /** Rows, emails or credits: whatever the price table counts. */
  units?: number;
  usage?: TokenUsage;
  costMicroCents: number;
  job?: string;
  runId?: string;
  turnId?: string;
}

/** Write one cost row. Never throws; returns false when the row could not be written. */
export async function recordCost(db: D1Database, event: CostEvent, now: Date = new Date()): Promise<boolean> {
  try {
    const cost = Math.round(event.costMicroCents);
    if (!Number.isFinite(cost) || cost < 0) return false;
    await db
      .prepare(
        `INSERT INTO cost_events (provider, capability, model, units, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
           cost_micro_cents, job, run_id, turn_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        event.provider,
        event.capability,
        event.model ?? null,
        event.units ?? null,
        event.usage?.inputTokens ?? null,
        event.usage?.outputTokens ?? null,
        event.usage?.cacheWriteTokens ?? null,
        event.usage?.cacheReadTokens ?? null,
        cost,
        event.job ?? null,
        event.runId ?? null,
        event.turnId ?? null,
        now.toISOString(),
      )
      .run();
    return true;
  } catch {
    return false;
  }
}
