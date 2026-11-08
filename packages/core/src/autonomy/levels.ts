// GTM-agents: autonomy levels and action classes.
//
// Every action the system can take on its own belongs to an action class with a level:
//   0  observe only
//   1  draft and ask (the default)
//   2  act and notify
//   3  act, report in a digest
// Levels are raised only by a person, from evidence. The classes in PERMANENT_HUMAN can never
// rise above 1: their level is capped when it is read and when it is set, and nothing reads a
// flag or config value to loosen them.

export const AUTONOMY_LEVELS = [0, 1, 2, 3] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 1;

/** Action classes whose level can be earned. */
export const EARNABLE_ACTION_CLASSES = [
  "cold_batch",
  "reply_send",
  "reply_demo_link",
  "reply_question",
  "ship_spec",
  "ship_notification",
  "post_meeting_followup",
  "rebook",
  "retrospective_actuation",
  "brain_edit",
  "lifecycle_activation",
  "feedback",
  "reengage",
  "at_risk",
  "renewal",
  "other",
] as const;

/** Action classes that always need a person, whatever the evidence. */
export const PERMANENT_HUMAN = [
  "merge_code",
  "pricing_billing_auth",
  "offers",
  "proof_of_value_send",
  "data_deletion",
] as const;

export const ACTION_CLASSES = [...EARNABLE_ACTION_CLASSES, ...PERMANENT_HUMAN] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
export type PermanentHumanClass = (typeof PERMANENT_HUMAN)[number];

const permanent: ReadonlySet<string> = new Set(PERMANENT_HUMAN);

export function isPermanentHuman(actionClass: string): actionClass is PermanentHumanClass {
  return permanent.has(actionClass);
}

const known: ReadonlySet<string> = new Set(ACTION_CLASSES);

/**
 * The effective level for a class. Permanently human classes are capped at 1. A class string that
 * is not an exact, known action class (a typo, different casing, a value read from storage) never
 * gets more than the default. Unknown or malformed stored values fall back to the default.
 */
export function effectiveLevel(actionClass: string, stored: unknown): AutonomyLevel {
  const level = typeof stored === "number" && (AUTONOMY_LEVELS as readonly number[]).includes(stored) ? (stored as AutonomyLevel) : DEFAULT_AUTONOMY_LEVEL;
  if (!known.has(actionClass)) return Math.min(level, DEFAULT_AUTONOMY_LEVEL) as AutonomyLevel;
  return isPermanentHuman(actionClass) ? (Math.min(level, 1) as AutonomyLevel) : level;
}
