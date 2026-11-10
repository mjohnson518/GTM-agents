// GTM-agents: the status enums of the data model, defined once. The CHECK constraints in the
// migrations list the same values, and a test keeps the two in step. Do not invent parallel enums.
export { DRAFT_STATUSES, type DraftStatus } from "../security/approval-digest.ts";
export { SEND_PATHS, type SendPath } from "../sending/gates.ts";
export { SIGNAL_TYPES, type SignalType } from "../ports/discovery.ts";
export { VERIFICATION_STATUSES, type VerificationStatus } from "../ports/contact.ts";
export { TEMPLATE_KINDS, type TemplateKind } from "../templates/schema.ts";

/** Contact warmth, in forward order, then the two terminal side states. */
export const WARMTH_STATES = ["cold", "contacted", "warming", "engaged", "hot", "customer", "churned", "opted_out"] as const;
export type Warmth = (typeof WARMTH_STATES)[number];
/** The forward ladder. A contact only climbs it. */
export const WARMTH_LADDER: readonly Warmth[] = ["cold", "contacted", "warming", "engaged", "hot", "customer"];
/** Terminal: warmth never changes again, except that a churned contact can still opt out. */
export const TERMINAL_WARMTH: readonly Warmth[] = ["churned", "opted_out"];

export const DEAL_STAGES = ["prospecting", "contacted", "engaged", "demo_scheduled", "trial", "proposal", "negotiation", "closed_won", "closed_lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const CLOSED_DEAL_STAGES: readonly DealStage[] = ["closed_won", "closed_lost"];

export const CANDIDATE_STATUSES = ["raw", "enriched", "qualified", "borderline", "rejected", "promoted", "duplicate"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Draft kinds: every template kind, plus drafts that are written rather than assembled. */
export const DRAFT_KINDS = ["cold_intro", "follow_up", "breakup", "check_in", "proposal", "lifecycle", "reply", "warm_intro", "recap", "referral_ask", "proof_of_value"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * The values the experiments.primary_metric column's CHECK allows. Which of them an experiment may
 * be pre-registered on is EXPERIMENT_METRICS in packages/core/src/metrics/experiments.ts, the one
 * list the experiments module reads; the column also allows meeting_booked for a later version.
 */
export const EXPERIMENT_METRICS = ["positive_reply", "meeting_booked", "conversation_started", "signed_up", "activated", "paid"] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

/** Customer lifecycle states: before sign-up, in the product, and the terminal deleted state. */
export const PRE_SIGNUP_STATES = ["sighted", "qualified", "parked", "contacted", "engaged", "nurturing", "opted_out"] as const;
export const PRODUCT_STATES = ["signed_up", "stalled", "activated", "at_wall", "paying", "expanding", "at_risk", "churned"] as const;
export const LIFECYCLE_STATES = [...PRE_SIGNUP_STATES, ...PRODUCT_STATES, "deleted"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
