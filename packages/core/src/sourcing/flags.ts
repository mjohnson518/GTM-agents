// GTM-agents: the flags sourcing reads, and how it reads them.
//
// Every sourcing capability is behind a flag that defaults off, and every per-run row ceiling is a
// flag with a conservative default (packages/core/src/flags/registry.ts lists them all for
// `gtm doctor`). Reads fail closed:
//   - a boolean flag that cannot be read is off;
//   - a ceiling that cannot be read, or does not parse as a whole number, is 0, so the stage does
//     nothing this run rather than guess how much it may do;
//   - a policy flag that cannot be read, or holds an unknown value, is the strict policy.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";

export const SOURCING_FLAGS = Object.freeze({
  /** Master switch for the discovery cycle: search, enrich, qualify and promote. */
  enabled: "discovery:enabled",
  searchesPerCycle: "discovery:searches_per_cycle",
  resultsPerSearch: "discovery:results_per_search",
  rawBacklogMax: "discovery:raw_backlog_max",
  enrichPerCycle: "discovery:enrich_per_cycle",
  qualifyPerCycle: "discovery:qualify_per_cycle",
  promotePerCycle: "discovery:promote_per_cycle",
  /** Finders after the first one in the email waterfall. */
  waterfall: "discovery:email_waterfall_enabled",
  promotionPolicy: "verification:promotion_policy",
  prescoreEnabled: "fit:prescore_enabled",
  fitEnabled: "fit:scoring_enabled",
  fitTopN: "fit:score_top_n",
  fitPerRun: "fit:score_per_run",
});

/** Defaults and hard maximums for the per-run ceilings. The registry shows the same defaults. */
export const SOURCING_LIMITS = Object.freeze({
  searchesPerCycle: { default: 5, max: 25 },
  resultsPerSearch: { default: 10, max: 100 },
  rawBacklogMax: { default: 300, max: 10_000 },
  enrichPerCycle: { default: 40, max: 50 },
  qualifyPerCycle: { default: 20, max: 100 },
  promotePerCycle: { default: 50, max: 100 },
  fitTopN: { default: 1000, max: 10_000 },
  fitPerRun: { default: 20, max: 100 },
});

/** A boolean flag. Unreadable means off. */
export async function readFlagOn(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

/**
 * A whole-number ceiling: the default when unset, clamped to `max`. A value that cannot be read
 * or does not parse is 0, so the stage does nothing this run.
 */
export async function readCeiling(flags: FlagReader, key: string, limit: { default: number; max: number }, log?: JobLogger): Promise<number> {
  let raw: string | null;
  try {
    raw = await flags.get(key);
  } catch {
    log?.warn("a ceiling flag could not be read; the stage is skipped this run", { flag: key });
    return 0;
  }
  if (raw === null || raw.trim() === "") return limit.default;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) {
    log?.warn("a ceiling flag is not a whole number; the stage is skipped this run", { flag: key });
    return 0;
  }
  return Math.min(n, limit.max);
}

export const PROMOTION_POLICIES = ["strict", "allow_risky"] as const;
export type PromotionPolicy = (typeof PROMOTION_POLICIES)[number];

/**
 * The verification policy for promotion. Only `allow_risky` loosens it; anything else, including a
 * flag that cannot be read, is `strict` (only deliverable addresses are promoted).
 */
export async function readPromotionPolicy(flags: FlagReader): Promise<PromotionPolicy> {
  try {
    const raw = (await flags.get(SOURCING_FLAGS.promotionPolicy))?.trim().toLowerCase();
    return raw === "allow_risky" ? "allow_risky" : "strict";
  } catch {
    return "strict";
  }
}
