// GTM-agents: the targeting flags and limits (docs/TARGETING.md).
//
// targeting:enabled turns on the Product and ICP page's write methods (save, discard, propose, and
// starting a draft); targeting:draft_enabled turns on the AI draft, which reads the operator's
// site and calls a model. Both default off and read fail closed: a flag that cannot be read is off.
// targeting:drafts_daily_max bounds drafts per UTC day across the deployment; a value that cannot
// be read is 0, so nothing is drafted.
import type { FlagReader } from "../jobs/registry.ts";
import { isFlagOn } from "../jobs/loop.ts";
import { readCap } from "../sending/flags.ts";

export const TARGETING_FLAG = "targeting:enabled";
export const TARGETING_DRAFT_FLAG = "targeting:draft_enabled";
export const TARGETING_DRAFTS_DAILY_MAX_FLAG = "targeting:drafts_daily_max";
export const TARGETING_DRAFTS_DAILY_MAX = { default: 10, max: 50 } as const;
/** The job name a draft's spend is checked and recorded under, so budget:job:targeting_draft:daily_cents caps it. */
export const TARGETING_JOB = "targeting_draft";
/** The most one UTC day of drafts may spend, in cents, whatever the budget flags say. */
export const TARGETING_DAILY_CENTS = 100;

async function on(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

export const isTargetingEnabled = (flags: FlagReader): Promise<boolean> => on(flags, TARGETING_FLAG);
export const isTargetingDraftEnabled = (flags: FlagReader): Promise<boolean> => on(flags, TARGETING_DRAFT_FLAG);
export const targetingDraftsDailyMax = (flags: FlagReader): Promise<number> => readCap(flags, TARGETING_DRAFTS_DAILY_MAX_FLAG, TARGETING_DRAFTS_DAILY_MAX);
