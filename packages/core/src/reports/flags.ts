// GTM-agents: the flags the scheduled reports read. Each defaults to off and is listed in
// packages/core/src/flags/registry.ts, so `gtm doctor` shows it. A flag that cannot be read counts as
// off: a report is never a reason to fail anything else.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const REPORT_FLAGS = Object.freeze({
  /** The daily scorecard, one operator message each weekday. It carries spend, so the daily cost digest stands down while it is on. */
  scorecard: "ops:daily_scorecard",
  /** The weekly funnel digest, Monday mornings. */
  funnel: "ops:funnel_digest",
  /** The daily cost digest, weekdays, while the scorecard is off. */
  cost: "ops:cost_digest",
});

/** A boolean flag. Unreadable means off. */
export async function reportFlagOn(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}
