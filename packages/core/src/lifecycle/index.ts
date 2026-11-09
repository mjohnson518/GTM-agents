// GTM-agents: the lifecycle's public surface (docs/LIFECYCLE.md): the state machine, its one writer,
// the side effects (outreach stop, deal mirror, funnel events, warmth, erasure), the time-based
// checks and MRR snapshot, the jobs, and createLifecycle, the wiring a deployment passes to
// createWorker.
export { LIFECYCLE_EVENT_KINDS, PAYING_STATES, dealStageFor, firstTimeColumn, isPaying, isPreSignup, isProductState, nextState, transitionTable, warmthFor } from "./states.ts";
export type { LifecycleEvent, LifecycleEventKind } from "./states.ts";
export { ATTRIBUTION_METHODS, applyLifecycleEvent, lifecycleState, recordMeetingBooked } from "./apply.ts";
export type { ApplyContext, ApplyResult, AttributionMethod, LifecycleDeps, LifecyclePatch } from "./apply.ts";
export { CANCEL_REASONS, TRANSITION_EFFECTS, cancelReason, dealPath, mirrorDeal, runTransitionEffects, stopColdOutreach } from "./effects.ts";
export type { LifecycleSource, TransitionEffect, TransitionRecord } from "./effects.ts";
export { runLifecycleChecks, snapshotMrr } from "./checks.ts";
export type { CheckResult } from "./checks.ts";
export { LIFECYCLE_FLAGS, LIFECYCLE_LIMITS, pullStateKey } from "./flags.ts";
export { LIFECYCLE_SCHEDULES, createLifecycle } from "./jobs.ts";
export type { LifecycleOptions, LifecycleWiring } from "./jobs.ts";
