// GTM-agents: the scoring module's public surface: the one title classifier, the free account
// prescore, the optional model fit score and the intent score.
export { SENIORITY_RANK, classifyTitle, compareTitleClasses, seniorityOf, titleKey } from "./titles.ts";
export type { ClassifyOptions, PersonFitDecision, TitleClass } from "./titles.ts";
export { PRESCORE_SIGNAL_DAYS, computePrescore, runPrescore } from "./prescore.ts";
export type { AccountAggregate, Prescore, PrescoreRunOptions } from "./prescore.ts";
export {
  DISQUALIFIED_MAX_SCORE,
  FIT_MAX_ATTEMPTS,
  FIT_OUTPUT_SCHEMA,
  FIT_REFRESH_DAYS,
  FIT_RUBRIC,
  LOW_FIT_SCORE,
  effectiveFitScore,
  parseFitOutput,
  runFitScoring,
} from "./fit.ts";
export type { FitOutput, FitScoringOptions, FitScoringResult } from "./fit.ts";
export { INTENT_BANDS, intentAllowsFirstTouch, intentBand, intentScore, runIntentScoring, signalFreshness } from "./intent.ts";
export type { IntentBand, IntentInput, IntentScore } from "./intent.ts";
