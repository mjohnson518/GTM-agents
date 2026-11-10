// GTM-agents: the flags the ship loop's planning side reads. Every one is off by default and listed
// in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Each needs ship:enabled as well,
// and a flag that cannot be read is off, so nothing here runs or spends because the flag store
// failed.
//
// No flag loosens what happens without a person. A spec is approved automatically, and a note is
// sent automatically, only at an earned autonomy level (ship_spec, ship_notification at level 2 or
// above), read through the autonomy module's reader.
import { isFlagOn, type FlagReader } from "@gtm-agents/core/jobs";

export const SHIP_FLAGS = Object.freeze({
  enabled: "ship:enabled",
  themes: "ship:themes_enabled",
  specs: "ship:specs_enabled",
  notes: "ship:notes_enabled",
});

export type ShipFlag = (typeof SHIP_FLAGS)[keyof typeof SHIP_FLAGS];

/** True only when the flag reads on. Unreadable is off. */
export async function shipFlagOn(flags: FlagReader, key: ShipFlag): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

/** True only when ship:enabled and `key` both read on. */
export async function shipStepOn(flags: FlagReader, key: Exclude<ShipFlag, "ship:enabled">): Promise<boolean> {
  return (await shipFlagOn(flags, SHIP_FLAGS.enabled)) && (await shipFlagOn(flags, key));
}
