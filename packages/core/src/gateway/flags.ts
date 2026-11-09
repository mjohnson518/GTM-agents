// GTM-agents: flag writes from the dashboard. The same checks as `gtm flags set` (an exact key from
// the registry, a value of the flag's kind and range), plus what only a person at a terminal or in
// the operator chat may do:
//   - autonomy:<class> is refused: a level changes only through autonomy-set and autonomy-confirm,
//     the two-step command that checks the evidence and the class's latest change. A permanently
//     human-only class above 1 is refused first, with its own message;
//   - system:halt is refused: the master stop is not lifted or forged by a raw write from here;
//   - the kill switch keys are refused: pause and resume go through cockpit.pause and cockpit.resume,
//     which use the kill switch module;
//   - switches that let mail go out without a person (automatic replies, auto-approved cold
//     batches, the signal fast lane) are refused: loosening a human gate stays with `gtm flags`;
//   - state flags (written by jobs, such as a breaker record or a template weight a proposal sets)
//     are refused: they are not settings.
import { ACTION_CLASSES, isPermanentHuman } from "../autonomy/levels.ts";
import { FLAGS, findFlag, type FlagDefinition } from "../flags/registry.ts";
import { HALT_KEY } from "../security/halt.ts";
import { COLD_PAUSE_CRITICAL_KEY, COLD_PAUSE_KEY } from "../sending/kill-switch.ts";

const TRUE_VALUES = new Set(["true", "on", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "off", "0", "no"]);
const MAX_VALUE_BYTES = 16 * 1024;
const AUTONOMY_PREFIX = "autonomy:";

const ALLOWED: Array<[RegExp, readonly string[]]> = [
  [/^budget:enforcement$/, ["soft", "hard"]],
  [/^verification:promotion_policy$/, ["strict", "allow_risky"]],
  [/^sequences:reply_intake$/, ["poll", "routed"]],
  [/^outreach:allocation_mode$/, ["weighted", "thompson"]],
  [/^outreach:min_email_confidence$/, ["high", "medium", "low"]],
  [/^classifier_tier:/, ["off", "shadow", "on"]],
];

const SHARES: Array<[RegExp, number, number, boolean]> = [
  [/^budget:alert_threshold$/, 0, 1, false],
  [/^outreach:holdout_rate$/, 0, 0.2, true],
];

export type FlagWriteCheck = { ok: true; definition: FlagDefinition; value: string | null } | { ok: false; error: string };

const isStateFlag = (definition: FlagDefinition): boolean => definition.description.startsWith("State:");

/** Flags that let something be sent without a person approving it. */
export const HUMAN_GATE_FLAGS: readonly string[] = Object.freeze(["inbound:auto_send_tier", "cold_batch:auto_approve", "signal_response:auto_send"]);

/** Check a dashboard flag write. `value` null unsets the flag. */
export function checkFlagWrite(key: string, raw: string | null): FlagWriteCheck {
  const definition = findFlag(key);
  if (!definition) return { ok: false, error: `"${key}" is not a known flag` };
  if (key.includes("<")) return { ok: false, error: `"${key}" is a pattern; name one flag` };
  if (key.startsWith(AUTONOMY_PREFIX)) {
    const actionClass = key.slice(AUTONOMY_PREFIX.length);
    if (!(ACTION_CLASSES as readonly string[]).includes(actionClass)) return { ok: false, error: `"${actionClass}" is not an action class` };
    if (isPermanentHuman(actionClass) && raw !== null && Number(raw.trim()) > 1) return { ok: false, error: `${actionClass} is permanently human-only; its autonomy level can never be above 1` };
    return { ok: false, error: "autonomy levels change only with autonomy-set and autonomy-confirm in the operator chat, which check the evidence first" };
  }
  if (key === HALT_KEY) return { ok: false, error: "the system halt is set and lifted with gtm flags or the operator chat, never as a raw flag write here" };
  if (key === COLD_PAUSE_KEY || key === COLD_PAUSE_CRITICAL_KEY) return { ok: false, error: "pause and resume cold outreach from the cockpit, which uses the kill switch" };
  if (HUMAN_GATE_FLAGS.includes(key)) return { ok: false, error: `${key} lets mail go out without a person; change it with gtm flags` };
  if (isStateFlag(definition)) return { ok: false, error: `${key} is state a job writes, not a setting` };
  if (raw === null) return { ok: true, definition, value: null };

  const value = raw.trim();
  if (value === "") return { ok: false, error: "the value is empty; unset the flag to return it to its default" };
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) return { ok: false, error: `the value is larger than ${MAX_VALUE_BYTES} bytes` };
  switch (definition.kind) {
    case "boolean": {
      const lower = value.toLowerCase();
      if (TRUE_VALUES.has(lower)) return { ok: true, definition, value: "true" };
      if (FALSE_VALUES.has(lower)) return { ok: true, definition, value: "false" };
      return { ok: false, error: `${key} is a boolean flag: use true or false` };
    }
    case "number": {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) return { ok: false, error: `${key} is a number flag: "${value.slice(0, 40)}" is not a number of zero or more` };
      const n = Number(value);
      const share = SHARES.find(([pattern]) => pattern.test(key));
      if (share) {
        const [, min, max, minAllowed] = share;
        return (minAllowed ? n >= min : n > min) && n <= max ? { ok: true, definition, value } : { ok: false, error: `${key} is a share ${minAllowed ? "from" : "above"} ${min} ${minAllowed ? "to" : "and at most"} ${max}` };
      }
      return Number.isInteger(n) ? { ok: true, definition, value } : { ok: false, error: `${key} is a whole number` };
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return { ok: false, error: `${key} holds JSON, and the value does not parse` };
      }
      if (parsed === null || typeof parsed !== "object") return { ok: false, error: `${key} holds a JSON object, for example {"reason":"maintenance"}; unset it to clear it` };
      return { ok: true, definition, value };
    }
    case "string": {
      if (/[\r\n]/.test(value)) return { ok: false, error: "the value must be one line" };
      const allowed = ALLOWED.find(([pattern]) => pattern.test(key))?.[1];
      if (allowed && !allowed.includes(value)) return { ok: false, error: `${key} is one of ${allowed.join(", ")}` };
      return { ok: true, definition, value };
    }
  }
}

/** Every registry entry that names one key (not a pattern family). */
export const CONCRETE_FLAGS: readonly FlagDefinition[] = FLAGS.filter((f) => !f.key.includes("<"));

/** True when flags.set accepts this key; for a pattern family, when it accepts the family's instances. */
export function isEditableFlag(key: string): boolean {
  return checkFlagWrite(key.includes("<") ? key.replace(/<[a-z_]+>/g, "example") : key, null).ok;
}
