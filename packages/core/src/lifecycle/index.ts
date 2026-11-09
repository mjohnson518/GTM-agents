// GTM-agents: the lifecycle's public surface (docs/LIFECYCLE.md): the state machine, its one writer,
// the side effects (outreach stop, deal mirror, funnel events, warmth, erasure), the time-based
// checks and MRR snapshot, the jobs, and createLifecycle, the wiring a deployment passes to
// createWorker; and the follow-ups to product users (createLifecycleFollowups and the fu- commands).
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
// Lifecycle follow-ups to product users: the rules and writer, the sweep and its job, and the commands.
export { COUNTED_STATUSES, FOLLOWUP_ACTION_CLASSES, FOLLOWUP_KINDS, FOLLOWUP_LIMITS, FOLLOWUP_RULES, WENT_OUT_STATUSES, capProblem, composeFollowup, defaultTemplateId, dueWindow, followupLinks, isFollowupKind, predecessorPending } from "./followup-rules.ts";
export type { ComposedFollowup, FollowupContact, FollowupKind, FollowupRule } from "./followup-rules.ts";
export { FOLLOWUP_JOB, FOLLOWUP_SCHEDULE, createLifecycleFollowups, runLifecycleFollowups, tidyDraftedFollowups } from "./followups.ts";
export type { FollowupDeps, FollowupResult, LifecycleFollowupOptions } from "./followups.ts";
export { FOLLOWUP_HELP_LINES, parseFollowupCommand, runFollowupCommand } from "./followup-commands.ts";
export type { FollowupCommand, FollowupCommandDeps } from "./followup-commands.ts";
