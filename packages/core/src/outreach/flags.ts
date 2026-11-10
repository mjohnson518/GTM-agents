// GTM-agents: the flags the cold batch reads, and how it reads them.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Reads fail
// in the direction that sends less or decides less on its own:
//   - a switch that cannot be read is off (the batch, auto-approve, the model reviewer);
//   - the autonomy level for cold_batch falls back to 1 (draft and ask) on any read or parse error;
//   - a cap that cannot be read, or does not parse as a whole number, is 0;
//   - the verification floor falls back to the strictest value, high, when it cannot be read or is
//     not a known value.
// The holdout rate is measurement, not a gate: an unreadable or malformed value uses the default.
import type { AutonomyLevel } from "../autonomy/levels.ts";
import { readAutonomyLevel } from "../autonomy/store.ts";
import type { GtmConfig } from "../config/schema.ts";
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const OUTREACH_FLAGS = Object.freeze({
  /** Master switch for the daily cold batch. */
  enabled: "cold_batch:enabled",
  /** Send passing drafts without a release code. */
  autoApprove: "cold_batch:auto_approve",
  /** The operator's limit, which can only lower the day's volume. */
  dailyLimit: "cold_batch:daily_limit",
  /** The stored autonomy level of the cold_batch action class. */
  coldBatchLevel: "autonomy:cold_batch",
  minConfidence: "outreach:min_email_confidence",
  holdoutRate: "outreach:holdout_rate",
  allocationMode: "outreach:allocation_mode",
  /** The model reviewer in the quality gate. */
  modelReview: "quality:model_review_enabled",
  /** Shared with the send path: messages per UTC day from the sending domain. */
  domainDailyCap: "delivery:domain_daily_cap",
  /** Shared with the send path: cold and sequence messages per account in any 7 days. */
  accountWeeklyCap: "delivery:account_weekly_cap",
});

export const OUTREACH_LIMITS = Object.freeze({
  /** The most first touches one batch may hold, whatever the ramp says. */
  batchMax: 1500,
  domainDailyCap: { default: 500, max: 10_000 },
  accountWeeklyCap: { default: 3, max: 50 },
});

export const HOLDOUT_RATE_DEFAULT = 0.05;
export const HOLDOUT_RATE_MAX = 0.2;

export const CONFIDENCE_FLOORS = ["high", "medium", "low"] as const;
export type ConfidenceFloor = (typeof CONFIDENCE_FLOORS)[number];

/** A boolean flag. Unreadable means off. */
export async function readOn(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

/** A whole-number cap: the default when unset, clamped to `max`. Unreadable or malformed is 0. */
export async function readWholeNumber(flags: FlagReader, key: string, limit: { default: number; max: number }): Promise<number> {
  let raw: string | null;
  try {
    raw = await flags.get(key);
  } catch {
    return 0;
  }
  if (raw === null || raw.trim() === "") return limit.default;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, limit.max);
}

/** The operator's daily limit: unset means no extra limit; unreadable or malformed is 0. */
export async function readDailyLimit(flags: FlagReader): Promise<number> {
  return readWholeNumber(flags, OUTREACH_FLAGS.dailyLimit, { default: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY });
}

/** The holdout share, from 0 to 0.2. Unset, unreadable or malformed values use the default. */
export async function readHoldoutRate(flags: FlagReader): Promise<number> {
  let raw: string | null;
  try {
    raw = await flags.get(OUTREACH_FLAGS.holdoutRate);
  } catch {
    return HOLDOUT_RATE_DEFAULT;
  }
  if (raw === null || raw.trim() === "") return HOLDOUT_RATE_DEFAULT;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return HOLDOUT_RATE_DEFAULT;
  return Math.min(n, HOLDOUT_RATE_MAX);
}

/** The verification floor for cold sends: medium when unset; an unknown value or an unreadable flag is high. */
export async function readConfidenceFloor(flags: FlagReader): Promise<ConfidenceFloor> {
  let raw: string | null;
  try {
    raw = await flags.get(OUTREACH_FLAGS.minConfidence);
  } catch {
    return "high";
  }
  const value = raw?.trim().toLowerCase();
  if (!value) return "medium";
  return value === "medium" || value === "low" ? value : "high";
}

export interface AutoApproveDecision {
  /** True when passing drafts may be approved without a person. */
  auto: boolean;
  /** Why: the operator's switch, or the class's earned level. */
  reason: "flag" | "autonomy_level" | null;
  level: AutonomyLevel;
}

/**
 * Whether the cold batch approves its own passing drafts: the cold_batch:auto_approve switch, or the
 * cold_batch class at level 2 or above. The level comes from the one autonomy reader
 * (autonomy/store.ts): the stored autonomy:cold_batch value, or the config's starting level when
 * none is stored, passed through effectiveLevel; any read or parse error is level 1. With the
 * database, the latest recorded level change caps it, and a standing demotion (or a change record
 * that cannot be read) also stops the auto-approve switch until a person sets the level again.
 */
export async function readAutoApprove(flags: FlagReader, config: Pick<GtmConfig, "autonomy">, db?: D1Database): Promise<AutoApproveDecision> {
  const flag = await readOn(flags, OUTREACH_FLAGS.autoApprove);
  const reading = await readAutonomyLevel({ flags, config, ...(db ? { db } : {}) }, "cold_batch");
  const level: AutonomyLevel = reading.level;
  // A standing demotion, or observe only, stops the switch too.
  if (reading.demoted || level === 0) return { auto: false, reason: null, level };
  if (flag) return { auto: true, reason: "flag", level };
  if (level >= 2) return { auto: true, reason: "autonomy_level", level };
  return { auto: false, reason: null, level };
}
