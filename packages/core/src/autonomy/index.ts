// GTM-agents: public entry point for autonomy levels and action classes.
export {
  ACTION_CLASSES,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY_LEVEL,
  EARNABLE_ACTION_CLASSES,
  PERMANENT_HUMAN,
  effectiveLevel,
  isPermanentHuman,
} from "./levels.ts";
export type { ActionClass, AutonomyLevel, PermanentHumanClass } from "./levels.ts";
