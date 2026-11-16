// GTM-agents: the CRM mirror's flags (docs/CRM.md).
//
// crm:mirror_enabled turns the mirror on and defaults off; a flag that cannot be read is off.
// crm:mirror_per_run bounds the rows one run handles across every stream; a value that cannot be
// read or is not a whole number is 0, so nothing is mirrored.
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { readCap } from "../sending/flags.ts";

export const CRM_MIRROR_FLAG = "crm:mirror_enabled";
export const CRM_PER_RUN_FLAG = "crm:mirror_per_run";
export const CRM_PER_RUN = { default: 100, max: 500 } as const;

/** Whether the mirror is on. Unreadable means off. */
export async function isCrmMirrorEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(CRM_MIRROR_FLAG));
  } catch {
    return false;
  }
}

/** Rows one run may handle. Unreadable or malformed means 0. */
export const crmPerRun = (flags: FlagReader): Promise<number> => readCap(flags, CRM_PER_RUN_FLAG, CRM_PER_RUN);
