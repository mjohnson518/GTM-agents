// GTM-agents: the flags the self-improvement loops read. One switch per loop, every one off by
// default and listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. A switch that
// cannot be read is off, so a loop never runs because its flag store failed.
//
// No flag loosens what applies on its own. A brain edit or a retrospective action applies without a
// person only at its earned autonomy level (brain_edit, retrospective_actuation at level 2 or
// above), read through the autonomy module's reader.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const LEARNING_FLAGS = Object.freeze({
  editMining: "learning:edit_mining_enabled",
  voice: "learning:voice_enabled",
  retrospective: "learning:retrospective_enabled",
  agentReview: "learning:agent_review_enabled",
  objections: "learning:objections_enabled",
  fitness: "learning:fitness_enabled",
  benchmark: "learning:benchmark_enabled",
  evolution: "learning:evolution_enabled",
});

export type LearningFlag = (typeof LEARNING_FLAGS)[keyof typeof LEARNING_FLAGS];

/** True only when the switch reads on. Unreadable is off. */
export async function learningFlagOn(flags: FlagReader, key: LearningFlag): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}
