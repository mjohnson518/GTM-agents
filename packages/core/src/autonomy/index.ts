// GTM-agents: public entry point for earned autonomy that needs no Worker binding: levels and
// action classes, the permanently human-only classes, the outbound writer registry and its
// scorers, and the auto-send rules for replies. The CLI and the evals import this. Everything that
// reads or writes D1 or KV (the level reader, evidence, demotion, promotion, the commands, the
// jobs) is in @gtm-agents/core/autonomy/runtime. docs/AUTONOMY.md describes how they fit together.
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
// The outbound writer registry and its scorers.
export { OUTBOUND_WRITERS, WRITER_EVAL_FILE, evalGap, writersFor } from "./writers.ts";
export type { OutboundWriter } from "./writers.ts";
export { figuresIn, scoreOutboundText } from "./scorers.ts";
export type { ScoreInput, ScoreResult } from "./scorers.ts";
// The auto-send rules for replies.
export {
  AUTO_SEND_CLASSES,
  AUTO_SEND_MIN_CONFIDENCE,
  autoSendPrecheck,
  competitorNames,
  decideReplyAutoSend,
  groundingProblem,
  linksIn,
  mentionsTime,
  plainAddress,
  riskIn,
} from "./auto-send-rules.ts";
export type { AutoSendCheck, AutoSendFailure, AutoSendQuality, ReplyAutoSendInput } from "./auto-send-rules.ts";
export { AUTONOMY_FLAGS, readFlagState } from "./flags.ts";
