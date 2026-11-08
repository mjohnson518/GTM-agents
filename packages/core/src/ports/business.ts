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

/** For booking detection, core asks only for ids, status, times, attendees and organizer; never titles or descriptions. */
export interface CalendarProvider {
  readonly name: string;
  freeBusy(args: { start: string; end: string }): Promise<Array<{ start: string; end: string }>>;
  listEvents(args: { start: string; end: string }): Promise<CalendarEvent[]>;
  createEvent(event: CalendarEvent, effectKey: string): Promise<{ id: string; htmlLink?: string }>;
  updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<void>;
  cancelEvent(id: string): Promise<void>;
}

export type BillingEvent =
  | { type: "checkout_completed"; customerId: string; email?: string; plan?: string; amount?: number; currency?: string; at: string; providerEventId: string }
  | {
      type: "subscription_created" | "subscription_updated" | "subscription_canceled";
      customerId: string;
      subscriptionId: string;
      status: string;
      plan?: string;
      amount?: number;
      currency?: string;
      at: string;
      providerEventId: string;
    }
  | { type: "payment_failed"; customerId: string; subscriptionId?: string; amount?: number; currency?: string; at: string; providerEventId: string }
  | { type: "ignored"; providerEventId: string; reason: string };

export interface BillingProvider {
  readonly name: string;
  /** Verifies the signature with a 5-minute tolerance. */
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
