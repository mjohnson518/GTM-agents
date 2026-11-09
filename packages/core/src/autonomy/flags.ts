// GTM-agents: the flags earned autonomy reads.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it, and every
// one defaults off. A flag that cannot be read counts as off.
//   - autonomy_review:enabled: the weekly promotion review. It only proposes; nothing is applied
//     without the operator's confirmation. Not named autonomy:<something>, because every
//     autonomy:<name> key is an action class's level;
//   - inbound:auto_send_tier: automatic replies. A reply goes out on its own only with this on AND
//     its class at level 2 or above AND replies:send_enabled and quality:model_review_enabled on.
// Demotion has no flag: tightening is always safe, and a demotion that waited for a switch would
// let a class keep acting on its own after the harm that should have stopped it.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const AUTONOMY_FLAGS = Object.freeze({
  /** The weekly promotion review (proposals only). */
  review: "autonomy_review:enabled",
  /** Automatic replies, together with the class's level. */
  replyAutoSend: "inbound:auto_send_tier",
});

/** A boolean flag: true, false, or null when it cannot be read. */
export async function readFlagState(flags: FlagReader, key: string): Promise<boolean | null> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return null;
  }
}
