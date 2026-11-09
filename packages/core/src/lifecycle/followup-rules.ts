// GTM-agents: the lifecycle follow-up rules, and the writer that renders a follow-up from the
// operator's approved template. Pure: no database, no network, no clock but the one passed in.
//
// Each kind follows one lifecycle state, a fixed delay after the contact entered it:
//
//   kind             state       delay     class                  gap since the last   approvable for
//   first_use        signed_up   24 h      lifecycle_activation   3 days               2 days
//   last_first_use   signed_up   72 h      lifecycle_activation   36 hours             2 days
//   usefulness       activated   2 h       feedback               1 day                7 days
//   upgrade_offer    at_wall     10 min    offers (human)         3 days               2 days
//   reengage         stalled     1 h       reengage               3 days               7 days
//   at_risk          at_risk     1 h       at_risk                3 days               7 days
//   win_back         churned     30 days   offers (human)         3 days               14 days
//
// A follow-up is decided only while it is fresh (from its due time until `freshHours` later), so
// turning the feature on never mails everyone who churned last year. At most 4 go to one person in
// any 30 days. The last first-use nudge waits while the first one is still being decided. Offers
// are permanently human: they are always drafted for a person, whatever any level says.
//
// The writer never writes copy. It fills the operator's approved template of kind `lifecycle`
// (id `lifecycle-<kind>` with dashes, unless the deployment names another) with the contact's own
// first and last name, the agent's name and the booking URL, and nothing else: no product usage, no
// attributes, nothing from outside. A variable with no value holds the follow-up (skip rather than
// guess). The quality gate then checks the result as it checks every outbound message.
import type { ActionClass } from "../autonomy/levels.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { LifecycleState } from "../data/enums.ts";
import { checkOutboundQuality, hostFromConfig, usableFirstName, type LinkPolicy, type QualityResult } from "../quality/gate.ts";
import { renderTemplate, type TemplateValues } from "../templates/render.ts";

export const FOLLOWUP_KINDS = ["first_use", "last_first_use", "usefulness", "upgrade_offer", "reengage", "at_risk", "win_back"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export interface FollowupRule {
  kind: FollowupKind;
  /** What the operator reads. */
  label: string;
  /** What the classifier is told the message is for. */
  purpose: string;
  state: LifecycleState;
  delayMs: number;
  /** How long after its due time a follow-up may still be decided. */
  freshMs: number;
  actionClass: ActionClass;
  /** An offer: permanently human, always a draft. */
  offer: boolean;
  /** The least time since the person's last follow-up. */
  minGapMs: number;
  /** How long a draft of it can be approved. */
  maxDraftAgeMs: number;
  /** A kind that must have been decided first. */
  predecessor?: FollowupKind;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const FOLLOWUP_LIMITS = Object.freeze({
  /** Follow-ups one person may get in any window of this length. */
  capWindowMs: 30 * DAY,
  capCount: 4,
  /** Candidates one sweep decides. */
  sweepRows: 25,
  /** Drafted follow-ups one sweep checks for withdrawal or expiry. */
  tidyRows: 100,
  /** Repeating fu-approve within this long sends a follow-up outside the window (to wait for its opening). */
  windowOverrideMs: HOUR,
  /** The classifier's answer must arrive within this long. */
  classifierTimeoutMs: 15_000,
});

export const FOLLOWUP_RULES: Readonly<Record<FollowupKind, FollowupRule>> = Object.freeze({
  first_use: { kind: "first_use", label: "first-use nudge", purpose: "a nudge to try the product for the first time, a day after signing up", state: "signed_up", delayMs: 24 * HOUR, freshMs: 48 * HOUR, actionClass: "lifecycle_activation", offer: false, minGapMs: 3 * DAY, maxDraftAgeMs: 2 * DAY },
  last_first_use: { kind: "last_first_use", label: "last first-use nudge", purpose: "a last nudge to try the product, three days after signing up", state: "signed_up", delayMs: 72 * HOUR, freshMs: 4 * DAY, actionClass: "lifecycle_activation", offer: false, minGapMs: 36 * HOUR, maxDraftAgeMs: 2 * DAY, predecessor: "first_use" },
  usefulness: { kind: "usefulness", label: "usefulness check", purpose: "a short question on whether the product was useful, after the first real use", state: "activated", delayMs: 2 * HOUR, freshMs: 3 * DAY, actionClass: "feedback", offer: false, minGapMs: DAY, maxDraftAgeMs: 7 * DAY },
  upgrade_offer: { kind: "upgrade_offer", label: "upgrade offer", purpose: "an offer to upgrade, after reaching a plan limit", state: "at_wall", delayMs: 10 * MINUTE, freshMs: 3 * DAY, actionClass: "offers", offer: true, minGapMs: 3 * DAY, maxDraftAgeMs: 2 * DAY },
  reengage: { kind: "reengage", label: "re-engage note", purpose: "a note to someone who signed up or used the product and then went quiet", state: "stalled", delayMs: HOUR, freshMs: 7 * DAY, actionClass: "reengage", offer: false, minGapMs: 3 * DAY, maxDraftAgeMs: 7 * DAY },
  at_risk: { kind: "at_risk", label: "at-risk check-in", purpose: "a check-in with a paying customer whose payment failed or who went quiet", state: "at_risk", delayMs: HOUR, freshMs: 7 * DAY, actionClass: "at_risk", offer: false, minGapMs: 3 * DAY, maxDraftAgeMs: 7 * DAY },
  win_back: { kind: "win_back", label: "win-back offer", purpose: "an offer to come back, a month after canceling", state: "churned", delayMs: 30 * DAY, freshMs: 14 * DAY, actionClass: "offers", offer: true, minGapMs: 3 * DAY, maxDraftAgeMs: 14 * DAY },
});

/** The action classes follow-ups are sent under. */
export const FOLLOWUP_ACTION_CLASSES: readonly ActionClass[] = [...new Set(FOLLOWUP_KINDS.map((k) => FOLLOWUP_RULES[k].actionClass))];

export const isFollowupKind = (value: unknown): value is FollowupKind => typeof value === "string" && (FOLLOWUP_KINDS as readonly string[]).includes(value);

/** The template id a kind is written from by default: `lifecycle-<kind>` with dashes. */
export const defaultTemplateId = (kind: FollowupKind): string => `lifecycle-${kind.replace(/_/g, "-")}`;

/** Statuses that count against the caps and the gap: it went out (or may have), waits to, or is being decided. */
export const COUNTED_STATUSES = ["claimed", "drafted", "sending", "sent", "queued", "failed"] as const;
/** Statuses that count against the caps when a draft is approved: it went out, may have, or is going. */
export const WENT_OUT_STATUSES = ["claimed", "sending", "sent", "queued", "failed"] as const;
/** Statuses that mean the follow-up is still being decided. */
export const PENDING_STATUSES = ["claimed", "drafted", "sending"] as const;

/** The entry times a kind is due for at `now`: entered at or before `dueBy`, and after `freshAfter`. Pure. */
export function dueWindow(rule: FollowupRule, now: Date): { dueBy: string; freshAfter: string } {
  return { dueBy: new Date(now.getTime() - rule.delayMs).toISOString(), freshAfter: new Date(now.getTime() - rule.delayMs - rule.freshMs).toISOString() };
}

/** Why the caps hold a follow-up now, or null. `history` is when each counted follow-up of the last 30 days happened. Pure. */
export function capProblem(history: readonly number[], now: Date, rule: FollowupRule): "cap" | "gap" | null {
  const since = now.getTime() - FOLLOWUP_LIMITS.capWindowMs;
  const recent = history.filter((at) => Number.isFinite(at) && at > since);
  if (recent.length >= FOLLOWUP_LIMITS.capCount) return "cap";
  if (recent.some((at) => now.getTime() - at < rule.minGapMs)) return "gap";
  return null;
}

/**
 * Whether a predecessor still being decided holds a kind: its row is pending, or it has no row yet
 * and is still fresh, so the sweep will decide it first. Pure.
 */
export function predecessorPending(rule: FollowupRule, predecessorStatus: string | null, enteredAt: string, now: Date): boolean {
  if (!rule.predecessor) return false;
  if (predecessorStatus !== null) return (PENDING_STATUSES as readonly string[]).includes(predecessorStatus);
  const before = FOLLOWUP_RULES[rule.predecessor];
  return now.getTime() <= Date.parse(enteredAt) + before.delayMs + before.freshMs;
}

/** The link policy for follow-ups: the company's domain, its site, the product's app and the booking URL. Pure. */
export function followupLinks(config: Pick<GtmConfig, "company" | "sending">, appUrl: string | undefined): LinkPolicy {
  const domains = [config.company.domain, hostFromConfig(config.company.url), hostFromConfig(appUrl)].filter((d): d is string => Boolean(d));
  return { domains: [...new Set(domains)], exactUrls: config.sending.bookingUrl ? [config.sending.bookingUrl] : [] };
}

export interface FollowupContact {
  email: string;
  first_name: string | null;
  last_name: string | null;
  account_key: string | null;
}

export type ComposedFollowup =
  | { status: "composed"; subject: string; body: string; quality: QualityResult; values: TemplateValues }
  | { status: "held"; missing: string[] };

const clean = (value: string | null | undefined, max: number): string | undefined => {
  const text = (value ?? "").normalize("NFKC").replace(/[^\p{L}\p{M}' .-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
  return text.length > 1 ? text : undefined;
};

/** Render a follow-up from its approved template, and run the quality gate on it. Pure. */
export function composeFollowup(
  template: { subject: string; body: string },
  contact: FollowupContact,
  config: Pick<GtmConfig, "agent" | "company" | "sending">,
  links: LinkPolicy,
): ComposedFollowup {
  const values: TemplateValues = {
    first_name: usableFirstName(contact.first_name) ?? undefined,
    last_name: clean(contact.last_name, 60),
    sender_name: config.agent.name,
    booking_url: config.sending.bookingUrl,
  };
  const rendered = renderTemplate(template, values);
  if (!rendered.ok) return { status: "held", missing: rendered.missing };
  const sources = [template.subject, template.body, values.first_name, values.last_name, config.company.name, config.company.product.name, config.agent.name].filter((s): s is string => typeof s === "string" && s.length > 0);
  const quality = checkOutboundQuality({
    kind: "lifecycle",
    subject: rendered.subject,
    body: rendered.body,
    recipient: contact.email,
    contact: { email: contact.email, firstName: contact.first_name, accountName: null, accountKey: contact.account_key },
    links,
    claimSources: sources,
  });
  return { status: "composed", subject: rendered.subject, body: rendered.body, quality, values };
}
