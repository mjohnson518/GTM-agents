// GTM-agents: the customer lifecycle state machine, pure (docs/LIFECYCLE.md).
//
// One lifecycle per contact, from first sighting to paying customer, churn or erasure. The table:
//
//   event                    from                                          to
//   qualified                sighted, parked                               qualified
//   parked                   sighted, qualified                            parked
//   outreach_sent            sighted, qualified, parked, nurturing         contacted
//   replied                  contacted, nurturing                          engaged
//   meeting_booked           any pre-sign-up state but opted_out           engaged
//   sequence_exhausted       contacted                                     nurturing
//   unsubscribed             any pre-sign-up state                         opted_out
//   signed_up                any pre-sign-up state                         signed_up
//   activated                signed_up, stalled                            activated
//   stalled_check            signed_up                                     stalled
//   limit_reached            signed_up, stalled, activated                 at_wall
//   subscribed               any but deleted                               paying
//   subscription_changed     paying states                                 expanding (up) or paying (down)
//   payment_failed           paying, expanding                             at_risk
//   canceled                 paying states                                 churned
//   dormant                  paying, expanding / activated, at_wall        at_risk / stalled
//   recovered                at_risk                                       paying
//   user_deleted             any                                           deleted
//
// Paying states are paying, expanding and at_risk. `deleted` is terminal. An unknown (state, event)
// pair, or one that would leave the state where it is, is no transition: never a guess. A contact
// with no lifecycle row yet is treated as sighted. Opting out ends the pre-sign-up lifecycle only; a
// product user stays in their product state, and suppression is what stops mail to them.
import { PRE_SIGNUP_STATES, PRODUCT_STATES, type DealStage, type LifecycleState, type Warmth } from "../data/enums.ts";

export const PAYING_STATES: readonly LifecycleState[] = Object.freeze(["paying", "expanding", "at_risk"]);

export type LifecycleEvent =
  | { kind: "qualified" }
  | { kind: "parked" }
  | { kind: "outreach_sent" }
  | { kind: "replied" }
  | { kind: "meeting_booked" }
  | { kind: "sequence_exhausted" }
  | { kind: "unsubscribed" }
  | { kind: "signed_up" }
  | { kind: "activated" }
  | { kind: "stalled_check" }
  | { kind: "limit_reached" }
  | { kind: "subscribed" }
  | { kind: "subscription_changed"; direction: "up" | "down" }
  | { kind: "payment_failed" }
  | { kind: "canceled" }
  | { kind: "dormant" }
  | { kind: "recovered" }
  | { kind: "user_deleted" };

export type LifecycleEventKind = LifecycleEvent["kind"];

export const LIFECYCLE_EVENT_KINDS: readonly LifecycleEventKind[] = Object.freeze([
  "qualified",
  "parked",
  "outreach_sent",
  "replied",
  "meeting_booked",
  "sequence_exhausted",
  "unsubscribed",
  "signed_up",
  "activated",
  "stalled_check",
  "limit_reached",
  "subscribed",
  "subscription_changed",
  "payment_failed",
  "canceled",
  "dormant",
  "recovered",
  "user_deleted",
]);

export const isPreSignup = (state: LifecycleState | null): boolean => state === null || (PRE_SIGNUP_STATES as readonly string[]).includes(state);
export const isProductState = (state: LifecycleState | null): boolean => state !== null && (PRODUCT_STATES as readonly string[]).includes(state);
export const isPaying = (state: LifecycleState | null): boolean => state !== null && PAYING_STATES.includes(state);

function target(state: LifecycleState, event: LifecycleEvent): LifecycleState | null {
  const among = (...states: LifecycleState[]) => states.includes(state);
  switch (event.kind) {
    case "qualified":
      return among("sighted", "parked") ? "qualified" : null;
    case "parked":
      return among("sighted", "qualified") ? "parked" : null;
    case "outreach_sent":
      return among("sighted", "qualified", "parked", "nurturing") ? "contacted" : null;
    case "replied":
      return among("contacted", "nurturing") ? "engaged" : null;
    case "meeting_booked":
      return isPreSignup(state) && state !== "opted_out" ? "engaged" : null;
    case "sequence_exhausted":
      return among("contacted") ? "nurturing" : null;
    case "unsubscribed":
      return isPreSignup(state) ? "opted_out" : null;
    case "signed_up":
      return isPreSignup(state) ? "signed_up" : null;
    case "activated":
      return among("signed_up", "stalled") ? "activated" : null;
    case "stalled_check":
      return among("signed_up") ? "stalled" : null;
    case "limit_reached":
      return among("signed_up", "stalled", "activated") ? "at_wall" : null;
    case "subscribed":
      return "paying";
    case "subscription_changed":
      return isPaying(state) ? (event.direction === "up" ? "expanding" : "paying") : null;
    case "payment_failed":
      return among("paying", "expanding") ? "at_risk" : null;
    case "canceled":
      return isPaying(state) ? "churned" : null;
    case "dormant":
      if (among("paying", "expanding")) return "at_risk";
      if (among("activated", "at_wall")) return "stalled";
      return null;
    case "recovered":
      return among("at_risk") ? "paying" : null;
    case "user_deleted":
      return "deleted";
  }
}

/**
 * Where `event` moves a contact in `current` (null: no row yet, treated as sighted), or null when
 * it does not move them.
 */
export function nextState(current: LifecycleState | null, event: LifecycleEvent): LifecycleState | null {
  if (current === "deleted") return null;
  const to = target(current ?? "sighted", event);
  return to === null || to === current ? null : to;
}

/** Every (from, event kind, to) the table allows, for documentation and tests. Pure. */
export function transitionTable(states: readonly LifecycleState[]): Array<{ from: LifecycleState | null; event: string; to: LifecycleState }> {
  const events: LifecycleEvent[] = LIFECYCLE_EVENT_KINDS.flatMap((kind): LifecycleEvent[] =>
    kind === "subscription_changed" ? [{ kind, direction: "up" }, { kind, direction: "down" }] : [{ kind }],
  );
  const rows: Array<{ from: LifecycleState | null; event: string; to: LifecycleState }> = [];
  for (const from of [null, ...states]) {
    for (const event of events) {
      const to = nextState(from, event);
      if (to) rows.push({ from, event: event.kind === "subscription_changed" ? `${event.kind}:${event.direction}` : event.kind, to });
    }
  }
  return rows;
}

/** The first-time timestamp column a state sets once, or null. */
export function firstTimeColumn(state: LifecycleState): "signed_up_at" | "activated_at" | "first_paid_at" | "churned_at" | null {
  switch (state) {
    case "signed_up":
      return "signed_up_at";
    case "activated":
      return "activated_at";
    case "paying":
    case "expanding":
      return "first_paid_at";
    case "churned":
      return "churned_at";
    default:
      return null;
  }
}

/**
 * The warmth a state summarizes to, or null when it carries none. Warmth is written forward only
 * (advanceWarmth), so the summary can raise warmth but never lower it, and it never leaves a
 * terminal warmth.
 */
export function warmthFor(state: LifecycleState): Warmth | null {
  switch (state) {
    case "contacted":
    case "nurturing":
      return "contacted";
    case "engaged":
      return "engaged";
    case "signed_up":
    case "stalled":
    case "activated":
    case "at_wall":
      return "hot";
    case "paying":
    case "expanding":
    case "at_risk":
      return "customer";
    case "churned":
      return "churned";
    case "opted_out":
      return "opted_out";
    default:
      return null;
  }
}

/** The deal stage a state calls for (the deal mirror), or null. */
export function dealStageFor(state: LifecycleState): DealStage | null {
  switch (state) {
    case "signed_up":
      return "trial";
    case "at_wall":
      return "proposal";
    case "paying":
    case "expanding":
      return "closed_won";
    case "churned":
      return "closed_lost";
    default:
      return null;
  }
}
