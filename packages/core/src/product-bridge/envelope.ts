// GTM-agents: the product event envelope as the agent accepts it (docs/EVENT-CONTRACT.md, version 1).
//
// Everything in an envelope is untrusted input from outside, even once its signature checks out: the
// host signs what its users typed. Parsing is strict on the routing fields (id, version, type,
// occurred_at, the user's id and address) and tolerant of extra keys, which are kept and ignored, so
// the host can add data without breaking the agent. Free text is length-capped here: names, roles and
// plan names to short labels, feedback to MAX_FEEDBACK_CHARS. Feedback text and custom events are
// full taint; every other event is structured. Pure: no I/O.
import type { TaintLevel } from "../ports/types.ts";

export const CONTRACT_VERSION = 1;

/** The catalogue, in the contract's order. The SDK exports the same list; a contract test compares them. */
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
export type CatalogueType = (typeof PRODUCT_EVENT_TYPES)[number];
export type ProductEventType = CatalogueType | `custom.${string}`;

/** Events older than this by occurred_at are accepted and routed, but flagged late. */
export const LATE_AFTER_DAYS = 7;
export const MAX_FEEDBACK_CHARS = 4000;
const MAX_ID = 128;
const MAX_NAME = 200;
const MAX_LABEL = 60;
const PRINTABLE_ID = /^[\x21-\x7e]+$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const CUSTOM = /^custom\.[a-z0-9][a-z0-9_.-]{0,62}$/;

export interface EnvelopeUser {
  id: string;
  /** Lowercased and trimmed as received; null on user.deleted. The router normalizes it before use. */
  email: string | null;
  name: string | null;
  role: string | null;
  /** Only on user.deleted. */
  email_sha256: string | null;
}

export interface EnvelopeOrg {
  id: string;
  name: string;
  domain: string | null;
  plan_tier: string | null;
}

export interface ProductEnvelope {
  id: string;
  version: typeof CONTRACT_VERSION;
  type: ProductEventType;
  /** ISO 8601 UTC, normalized. */
  occurred_at: string;
  /** Null only on a custom event that names no user. */
  user: EnvelopeUser | null;
  org: EnvelopeOrg | null;
  /** The attribution token, or null when absent or not shaped like one. */
  ref: string | null;
  data: Record<string, unknown>;
}

export type EnvelopeParse = { ok: true; envelope: ProductEnvelope } | { ok: false; error: string };

export const isCatalogueType = (type: unknown): type is CatalogueType => typeof type === "string" && (PRODUCT_EVENT_TYPES as readonly string[]).includes(type);

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The id alone, for the 401 check that X-Event-Id equals body.id. Null when the body has none. */
export function envelopeId(raw: unknown): string | null {
  return isObject(raw) && typeof raw.id === "string" ? raw.id : null;
}

/**
 * Validate a parsed body. The error is safe to return to the caller: it names the field and never
 * echoes payload content.
 */
export function parseEnvelope(raw: unknown): EnvelopeParse {
  if (!isObject(raw)) return { ok: false, error: "the body must be a JSON object" };
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > MAX_ID || !PRINTABLE_ID.test(raw.id)) return { ok: false, error: "id must be 1 to 128 printable characters" };
  if (raw.version !== CONTRACT_VERSION) return { ok: false, error: `version must be ${CONTRACT_VERSION}` };
  const type = raw.type;
  if (!(isCatalogueType(type) || (typeof type === "string" && CUSTOM.test(type)))) return { ok: false, error: "type must be a catalogue type or custom.<name>" };
  if (typeof raw.occurred_at !== "string" || raw.occurred_at.length > 40 || Number.isNaN(Date.parse(raw.occurred_at))) return { ok: false, error: "occurred_at must be an ISO 8601 time" };
  const occurredAt = new Date(raw.occurred_at).toISOString();
  if (!isObject(raw.data)) return { ok: false, error: "data must be an object" };

  let user: EnvelopeUser | null = null;
  if (raw.user !== undefined && raw.user !== null) {
    if (!isObject(raw.user)) return { ok: false, error: "user must be an object" };
    const id = typeof raw.user.id === "string" && raw.user.id.length > 0 && raw.user.id.length <= MAX_ID && PRINTABLE_ID.test(raw.user.id) ? raw.user.id : null;
    if (!id) return { ok: false, error: "user.id must be 1 to 128 printable characters" };
    if (type === "user.deleted") {
      const hash = raw.user.email_sha256;
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: "user.email_sha256 must be lowercase hex SHA-256" };
      // Whatever else arrived on an erasure (an address, a name) is never kept.
      user = { id, email: null, name: null, role: null, email_sha256: hash };
    } else {
      const email = typeof raw.user.email === "string" ? raw.user.email.trim().toLowerCase() : "";
      if (isCatalogueType(type) && (email.length === 0 || email.length > 254 || !email.includes("@"))) return { ok: false, error: "user.email is required" };
      user = { id, email: email.length > 0 ? email : null, name: text(raw.user.name, MAX_NAME), role: text(raw.user.role, MAX_LABEL), email_sha256: null };
    }
  } else if (isCatalogueType(type)) {
    return { ok: false, error: "user is required" };
  }

  let org: EnvelopeOrg | null = null;
  if (raw.org !== undefined && raw.org !== null) {
    if (!isObject(raw.org)) return { ok: false, error: "org must be an object or null" };
    const id = typeof raw.org.id === "string" && raw.org.id.length > 0 && raw.org.id.length <= MAX_ID && PRINTABLE_ID.test(raw.org.id) ? raw.org.id : null;
    const name = text(raw.org.name, MAX_NAME);
    if (!id || !name) return { ok: false, error: "org needs an id and a name" };
    org = { id, name, domain: text(raw.org.domain, 253)?.toLowerCase() ?? null, plan_tier: text(raw.org.plan_tier, MAX_LABEL) };
  }

  const data: Record<string, unknown> = { ...raw.data };
  if (type === "feedback.submitted") {
    const body = text(data.text, MAX_FEEDBACK_CHARS);
    if (!body) return { ok: false, error: "data.text is required on feedback.submitted" };
    data.text = body;
  }
  const ref = typeof raw.ref === "string" && REF.test(raw.ref) ? raw.ref : null;
  return { ok: true, envelope: { id: raw.id, version: CONTRACT_VERSION, type: type as ProductEventType, occurred_at: occurredAt, user, org, ref, data } };
}

/** Feedback text and free-form custom events are full taint; everything else is structured. */
export function envelopeTaint(type: ProductEventType): TaintLevel {
  return type === "feedback.submitted" || type.startsWith("custom.") ? "full" : "structured";
}

/** True for an event that occurred more than LATE_AFTER_DAYS before it was received. */
export function isLate(occurredAt: string, receivedAt: Date): boolean {
  return receivedAt.getTime() - Date.parse(occurredAt) > LATE_AFTER_DAYS * 86_400_000;
}

/** A short label from untrusted input (a plan, a limit name): plain characters only, capped. Null when nothing is left. */
export function label(value: unknown, max = MAX_LABEL): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").replace(/[^\p{L}\p{N} ._:/+-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/** A non-negative whole number from untrusted input, or null. */
export function count(value: unknown, max = 1_000_000_000): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}
