// GTM-agents SDK: the product event catalogue, the envelope, and a typed builder for every event
// (docs/EVENT-CONTRACT.md, version 1).
//
// The builders fill in what the contract requires and the host should not have to think about: a
// stable id (reuse it if you retry from a queue of your own), the version, an ISO 8601 UTC
// occurred_at, a null org and ref when there are none. `userDeleted` hashes the address for you and
// never puts it in the event.
import { emailSha256 } from "./crypto.ts";

/** The contract version this SDK speaks. Changes are additive; a breaking change bumps it. */
export const CONTRACT_VERSION = 1 as const;

/** Every catalogue event type, in the contract's order. Anything else must be `custom.<name>`. */
export const PRODUCT_EVENT_TYPES = [
  "user.signed_up",
  "org.created",
  "user.activated",
  "usage.limit_reached",
  "billing.subscribed",
  "billing.subscription_changed",
  "billing.subscription_canceled",
  "billing.payment_failed",
  "billing.topup_purchased",
  "org.api_key_created",
  "feedback.submitted",
  "user.deleted",
] as const;

export type CatalogueEventType = (typeof PRODUCT_EVENT_TYPES)[number];
export type CustomEventType = `custom.${string}`;
export type ProductEventType = CatalogueEventType | CustomEventType;

/** The user an event is about. `email` is required on every type except `user.deleted`. */
export interface EventUser {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
}

/** What `user.deleted` carries: the user id and the hash of their address, never the address. */
export interface ErasedUser {
  id: string;
  email_sha256: string;
}

/** The host's tenant. `domain` and `plan_tier` are optional, but the agent keys accounts by domain. */
export interface EventOrg {
  id: string;
  name: string;
  domain?: string | null;
  plan_tier?: string | null;
}

/** The `data` payload of each catalogue type. Unknown keys are kept and ignored by the agent. */
export interface EventDataMap {
  "user.signed_up": { plan: string; source?: string };
  "org.created": { plan: string };
  "user.activated": { event: string; count?: number };
  "usage.limit_reached": { limit: string; used: number; period: string };
  /** `amount` is in the currency's minor unit (cents), `interval` is month or year. */
  "billing.subscribed": { plan: string; interval: string; amount: number; currency: string };
  /** Send only real changes; a renewal that changes nothing is not an event. */
  "billing.subscription_changed": { from_plan: string; to_plan: string; status: string };
  "billing.subscription_canceled": { plan: string; ends_at: string; reason?: string };
  "billing.payment_failed": { amount: number; currency: string; attempt: number };
  "billing.topup_purchased": { sku: string; amount: number; currency: string };
  "org.api_key_created": { scopes?: string[] };
  /** The text is full taint on the agent side: it is never treated as an instruction. */
  "feedback.submitted": { text: string; context?: string; rating?: number };
  "user.deleted": Record<string, never>;
}

export type EventData<T extends ProductEventType> = T extends CatalogueEventType ? EventDataMap[T] : Record<string, unknown>;

/** The envelope every push carries. */
export interface ProductEvent<T extends ProductEventType = ProductEventType> {
  id: string;
  version: typeof CONTRACT_VERSION;
  type: T;
  occurred_at: string;
  user: T extends "user.deleted" ? ErasedUser : T extends CustomEventType ? EventUser | null : EventUser;
  org: EventOrg | null;
  ref: string | null;
  data: EventData<T>;
}

/** What a builder needs. `id` and `occurredAt` default to a fresh id and now. */
export interface EventInput<T extends CatalogueEventType> {
  user: EventUser;
  org?: EventOrg | null;
  /** The attribution token the host stored at sign-up (users.signup_ref), or null. */
  ref?: string | null;
  data: EventDataMap[T];
  id?: string;
  occurredAt?: Date | string;
}

/** A new event id: globally unique and stable across retries once assigned. */
export function newEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** ISO 8601 UTC for a Date or a parseable string. Throws on anything else, before anything is sent. */
export function isoUtc(value: Date | string | undefined): string {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("occurredAt must be a valid date");
  return date.toISOString();
}

/** Build any catalogue event except `user.deleted` (use userDeleted, which hashes the address). */
export function productEvent<T extends Exclude<CatalogueEventType, "user.deleted">>(type: T, input: EventInput<T>): ProductEvent<T> {
  return {
    id: input.id ?? newEventId(),
    version: CONTRACT_VERSION,
    type,
    occurred_at: isoUtc(input.occurredAt),
    user: input.user,
    org: input.org ?? null,
    ref: input.ref ?? null,
    data: input.data,
  } as ProductEvent<T>;
}

type Input<T extends Exclude<CatalogueEventType, "user.deleted">> = EventInput<T>;

export const userSignedUp = (input: Input<"user.signed_up">) => productEvent("user.signed_up", input);
export const orgCreated = (input: Input<"org.created">) => productEvent("org.created", input);
export const userActivated = (input: Input<"user.activated">) => productEvent("user.activated", input);
export const usageLimitReached = (input: Input<"usage.limit_reached">) => productEvent("usage.limit_reached", input);
export const billingSubscribed = (input: Input<"billing.subscribed">) => productEvent("billing.subscribed", input);
export const billingSubscriptionChanged = (input: Input<"billing.subscription_changed">) => productEvent("billing.subscription_changed", input);
export const billingSubscriptionCanceled = (input: Input<"billing.subscription_canceled">) => productEvent("billing.subscription_canceled", input);
export const billingPaymentFailed = (input: Input<"billing.payment_failed">) => productEvent("billing.payment_failed", input);
export const billingTopupPurchased = (input: Input<"billing.topup_purchased">) => productEvent("billing.topup_purchased", input);
export const orgApiKeyCreated = (input: Input<"org.api_key_created">) => productEvent("org.api_key_created", input);
export const feedbackSubmitted = (input: Input<"feedback.submitted">) => productEvent("feedback.submitted", input);

/**
 * `user.deleted` for an erased user. Pass the address you held; the event carries only its hash
 * (lowercased and trimmed first), with no name and no org.
 */
export async function userDeleted(input: { userId: string; email: string; id?: string; occurredAt?: Date | string }): Promise<ProductEvent<"user.deleted">> {
  return {
    id: input.id ?? newEventId(),
    version: CONTRACT_VERSION,
    type: "user.deleted",
    occurred_at: isoUtc(input.occurredAt),
    user: { id: input.userId, email_sha256: await emailSha256(input.email) },
    org: null,
    ref: null,
    data: {},
  };
}

/** `custom.<name>`: anything else the host wants the agent to know. Routed only if a playbook subscribes. */
export function customEvent(name: string, input: { user?: EventUser | null; org?: EventOrg | null; ref?: string | null; data?: Record<string, unknown>; id?: string; occurredAt?: Date | string }): ProductEvent<CustomEventType> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) throw new TypeError("a custom event name is 1 to 63 lowercase letters, digits, dots, dashes or underscores");
  return {
    id: input.id ?? newEventId(),
    version: CONTRACT_VERSION,
    type: `custom.${name}`,
    occurred_at: isoUtc(input.occurredAt),
    user: input.user ?? null,
    org: input.org ?? null,
    ref: input.ref ?? null,
    data: input.data ?? {},
  };
}

const isCatalogue = (type: string): type is CatalogueEventType => (PRODUCT_EVENT_TYPES as readonly string[]).includes(type);

/**
 * Why an event would be refused with a 400, or null when its shape is right. The agent checks the
 * same rules; this lets a host catch a mistake in its own tests.
 */
export function eventProblem(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "the event must be an object";
  const e = event as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 128) return "id must be a string of 1 to 128 characters";
  if (e.version !== CONTRACT_VERSION) return `version must be ${CONTRACT_VERSION}`;
  if (typeof e.type !== "string" || !(isCatalogue(e.type) || /^custom\.[a-z0-9][a-z0-9_.-]{0,62}$/.test(e.type))) return "type must be a catalogue type or custom.<name>";
  if (typeof e.occurred_at !== "string" || Number.isNaN(Date.parse(e.occurred_at))) return "occurred_at must be an ISO 8601 time";
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) return "data must be an object";
  const user = e.user as Record<string, unknown> | null | undefined;
  if (isCatalogue(e.type)) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || user.id.length === 0) return "user.id is required";
    if (e.type === "user.deleted") {
      if (typeof user.email_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(user.email_sha256)) return "user.email_sha256 must be lowercase hex SHA-256";
      if ("email" in user || "name" in user) return "user.deleted carries no email or name";
    } else if (typeof user.email !== "string" || !user.email.includes("@")) return "user.email is required";
  }
  if (e.org !== null && e.org !== undefined) {
    const org = e.org as Record<string, unknown>;
    if (typeof org !== "object" || typeof org.id !== "string" || typeof org.name !== "string") return "org needs an id and a name, or must be null";
  }
  if (e.ref !== null && e.ref !== undefined && typeof e.ref !== "string") return "ref must be a string or null";
  return null;
}
