// GTM-agents: the flags the experiments module reads, and how it reads them.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Reads fail
// toward doing less on their own:
//   - experiments:enabled and experiments:self_review_enabled are switches; unreadable is off, so
//     no experiment enrolls anyone and no proposal is made;
//   - outreach:allocation_mode is weighted unless it reads exactly "thompson"; unreadable is
//     weighted (the operator's own volume weights, the escape hatch);
//   - outreach:send_time_experiment is a switch; unreadable is off;
//   - experiments:template_weight:<template> overrides a template's volume_weight once a person
//     approved a weight proposal; unset, unreadable or malformed uses the template file's weight;
//   - experiments:control_template names the protected control; unset or unreadable uses the
//     general template with the highest volume weight.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const EXPERIMENT_FLAGS = Object.freeze({
  enabled: "experiments:enabled",
  selfReview: "experiments:self_review_enabled",
  controlTemplate: "experiments:control_template",
  allocationMode: "outreach:allocation_mode",
  sendTime: "outreach:send_time_experiment",
  holdoutRate: "outreach:holdout_rate",
});

/** The flag holding a template's approved weight override. */
export function templateWeightKey(templateId: string): string {
  return `experiments:template_weight:${templateId}`;
}

/** The most a weight override may hold. */
export const MAX_TEMPLATE_WEIGHT = 100;

export async function readSwitch(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

export type AllocationMode = "weighted" | "thompson";

/** The allocation mode: thompson only when the flag says exactly that. */
export async function readAllocation(flags: FlagReader): Promise<{ requested: string; mode: AllocationMode }> {
  try {
    const raw = (await flags.get(EXPERIMENT_FLAGS.allocationMode))?.trim().toLowerCase() ?? "";
    return { requested: raw || "weighted", mode: raw === "thompson" ? "thompson" : "weighted" };
  } catch {
    return { requested: "unreadable", mode: "weighted" };
  }
}

/** Parse a weight override: a finite number from 0 to MAX_TEMPLATE_WEIGHT, or null. Pure. */
export function parseWeight(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= MAX_TEMPLATE_WEIGHT ? n : null;
}

/** A template's weight override, or null to use its file's weight. Never throws. */
export async function readWeightOverride(flags: FlagReader, templateId: string): Promise<number | null> {
  try {
    return parseWeight(await flags.get(templateWeightKey(templateId)));
  } catch {
    return null;
  }
}

/** The operator's protected control template id, or null to use the highest-weight general template. */
export async function readControlTemplate(flags: FlagReader): Promise<string | null> {
  try {
    const raw = (await flags.get(EXPERIMENT_FLAGS.controlTemplate))?.trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}
