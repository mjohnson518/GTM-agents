// GTM-agents: the flags and KV state the delivery half of the send path reads, and how it reads
// them.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Reads fail
// closed, in the direction that sends less:
//   - a boolean switch that cannot be read is off;
//   - a cap that cannot be read, or does not parse as a whole number, is 0, so nothing more goes
//     out under it until it can be read.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { KvStore } from "../shared/kv.ts";

export const DELIVERY_FLAGS = Object.freeze({
  /** Master switch for the provider boundary's actual send, the deferred replay and the bounce monitor. */
  enabled: "delivery:enabled",
  /** Messages per UTC day through the provider, from the sending domain. */
  domainDailyCap: "delivery:domain_daily_cap",
  /** Cold and sequence messages per recipient account in any 7 days. */
  accountWeeklyCap: "delivery:account_weekly_cap",
  /** Lets the ramp job move the warm-up level on delivery evidence. */
  rampAuto: "outreach:ramp_auto",
  rampLevel: "outreach:ramp_level",
  rampChangedAt: "outreach:ramp_changed_at",
  /** The operator's limit on the cold batch, which can only lower the ramp level. */
  coldDailyLimit: "cold_batch:daily_limit",
  coldBatchEnabled: "cold_batch:enabled",
  /** When the bounce monitor last lifted a warning pause, kept for 14 days. */
  lastAutoResume: "delivery:last_auto_resume",
});

/** The circuit breaker's KV record for one UTC day. */
export const breakerKey = (day: string): string => `delivery:breaker:${day}`;

/** Defaults and hard maximums for the caps. The registry shows the same defaults. */
export const DELIVERY_LIMITS = Object.freeze({
  domainDailyCap: { default: 500, max: 10_000 },
  accountWeeklyCap: { default: 3, max: 50 },
});

/** A FlagReader over a KV store. A missing store throws, so each caller fails in its own direction. */
export function kvFlags(kv: Pick<KvStore, "get"> | undefined | null): FlagReader {
  return {
    get: async (key) => {
      if (!kv) throw new Error("the KV binding is missing");
      return kv.get(key);
    },
  };
}

/** A boolean flag. Unreadable means off. */
export async function readSwitch(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

/**
 * A whole-number cap: the default when unset, clamped to `max`. A value that cannot be read or
 * does not parse is 0.
 */
export async function readCap(flags: FlagReader, key: string, limit: { default: number; max: number }): Promise<number> {
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
