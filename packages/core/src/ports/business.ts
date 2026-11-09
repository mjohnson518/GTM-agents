// GTM-agents: ports for calendars, billing, an optional CRM mirror, and module sandboxes.
import type { Cost } from "./types.ts";

export interface CalendarEvent {
  id?: string;
  title: string;
  start: string;
  end: string;
  attendees: Array<{ email: string; name?: string }>;
  description?: string;
  conferencing?: "auto" | "none";
  location?: string;
}

/** One attendee, as booking detection reads it: the address, whether it is the calendar's own account, and the answer. */
export interface CalendarAttendee {
  /** Lowercase. */
  email: string;
  self: boolean;
  responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
}

/**
 * What listEvents returns. It never carries a title, description, location, conferencing link or
 * attendee name: an adapter asks the vendor for these fields only, and drops anything else.
 */
export interface CalendarEventSummary {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** ISO 8601 UTC. Null for an all-day event, or a cancelled one the calendar no longer describes. */
  start: string | null;
  end: string | null;
  /** True for an event with dates but no times. */
  allDay: boolean;
  /** The recurring series an instance belongs to, or null for a one-off event. */
  seriesId: string | null;
  organizer: { email: string; self: boolean } | null;
  attendees: CalendarAttendee[];
}

/** For booking detection, core asks only for ids, status, times, attendees and organizer; never titles or descriptions. */
export interface CalendarProvider {
  readonly name: string;
  /**
   * Which methods work. A read-only adapter says so here and refuses the others with a
   * non-retryable "invalid" AdapterError, without a request.
   */
  readonly capabilities?: Partial<Record<"list" | "freeBusy" | "write", boolean>>;
  freeBusy(args: { start: string; end: string }): Promise<Array<{ start: string; end: string }>>;
  /** Single events (recurring ones expanded) in the window, cancelled ones included with status "cancelled". */
  listEvents(args: { start: string; end: string }): Promise<CalendarEventSummary[]>;
  createEvent(event: CalendarEvent, effectKey: string): Promise<{ id: string; htmlLink?: string }>;
  updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<void>;
  cancelEvent(id: string): Promise<void>;
}

/** How often a price recurs. An amount with no interval is read as monthly. */
export type BillingInterval = "day" | "week" | "month" | "year";

/**
 * A billing webhook, as an adapter maps it. Amounts are integers in the currency's minor unit
 * (cents). `email` is the customer's address when the vendor's payload carries it: core resolves an
 * existing contact by it and never creates one. `at` is ISO 8601 UTC.
 */
export type BillingEvent =
  | { type: "checkout_completed"; customerId: string; email?: string; plan?: string; amount?: number; currency?: string; interval?: BillingInterval; at: string; providerEventId: string }
  | {
      type: "subscription_created" | "subscription_updated" | "subscription_canceled";
      customerId: string;
      subscriptionId: string;
      /** The vendor's status: active, trialing, past_due, unpaid, incomplete, canceled, or another the core keeps unchanged. */
      status: string;
      email?: string;
      plan?: string;
      amount?: number;
      currency?: string;
      interval?: BillingInterval;
      at: string;
      providerEventId: string;
    }
  | { type: "payment_failed"; customerId: string; subscriptionId?: string; email?: string; amount?: number; currency?: string; at: string; providerEventId: string }
  | { type: "ignored"; providerEventId: string; reason: string };

export interface BillingProvider {
  readonly name: string;
  /**
   * Verifies the signature with a 5-minute tolerance, in constant time, before reading anything
   * else, then maps the payload. Throws an AdapterError: "auth" for a missing, bad or stale
   * signature, "invalid" for a payload it cannot map, "unavailable" when its webhook secret is unset.
   */
  parseWebhook(request: Request): Promise<BillingEvent>;
  getCustomerByEmail(email: string): Promise<{ customerId: string; plan?: string; status?: string } | null>;
  listSubscriptions(customerId: string): Promise<Array<{ subscriptionId: string; plan: string; status: string; amount?: number; currency?: string; renewsAt?: string }>>;
  /** Human-only (action class "offers"). Core refuses to call it without a person's approval. */
  createCheckoutLink?(args: { plan: string; email: string; effectKey: string }): Promise<{ url: string; expiresAt?: string }>;
}

/** One-way mirror into an external CRM. The database in this system is the truth. */
export interface CrmSink {
  readonly name: string;
  upsertAccount(account: { key: string; name: string; domain: string; attributes: Record<string, unknown> }): Promise<{ externalId: string }>;
  upsertContact(contact: {
    id: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    title?: string;
    accountKey?: string;
    warmth: string;
    attributes: Record<string, unknown>;
  }): Promise<{ externalId: string }>;
  logActivity(activity: { contactId: string; type: "email_sent" | "reply" | "meeting" | "note"; at: string; summary: string }): Promise<void>;
}

/** Used by the ship and code-mode modules; not part of the core contract. */
export interface Sandbox {
  exec(args: { cmd: string; cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  destroy(): Promise<void>;
}

export type { Cost };
