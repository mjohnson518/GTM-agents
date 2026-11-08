// GTM-agents: ports for sending email and reading the warm mailbox. Core runs every send check
// before an adapter is called; adapters send and parse, and decide nothing.
import type { AdapterErrorCode, Cost, Page } from "./types.ts";

export interface OutboundMessage {
  /** Claimed by core; the vendor idempotency key where supported. */
  effectKey: string;
  from: { email: string; name?: string };
  to: { email: string; name?: string };
  replyTo?: string;
  subject: string;
  /** Plain text only; core has already appended the footer. */
  text: string;
  /** List-Unsubscribe, List-Unsubscribe-Post, In-Reply-To, References. */
  headers: Record<string, string>;
  /** contact_id, campaign_id, draft_id, experiment_id, variant_id, seed. */
  tags: Record<string, string>;
  scheduledAt?: string;
}

export type SendOutcome =
  | { effectKey: string; ok: true; providerMessageId: string }
  | { effectKey: string; ok: false; code: AdapterErrorCode; retryable: boolean; detail?: string };

export type EmailEvent =
  | { type: "delivered"; providerMessageId: string; tags: Record<string, string>; to: string; at: string }
  | { type: "bounced"; providerMessageId: string; tags: Record<string, string>; to: string; at: string; hard: boolean; reason?: string }
  | { type: "complained"; providerMessageId: string; tags: Record<string, string>; to: string; at: string }
  | { type: "failed"; providerMessageId: string; tags: Record<string, string>; to: string; at: string; reason?: string }
  | { type: "unsubscribed"; to: string; at: string; tags?: Record<string, string> }
  /** Ignored by core: email is plain text with no tracking. */
  | { type: "opened" | "clicked"; providerMessageId: string; at: string };

export interface EmailProvider {
  readonly name: string;
  sendBatch(messages: OutboundMessage[]): Promise<{ outcomes: SendOutcome[]; cost?: Cost }>;
  /**
   * Verify the webhook signature (vendor scheme, 5-minute replay window) and return typed events.
   * Throws AdapterError("auth") on a bad signature. Core returns 200 only after this resolves.
   */
  parseWebhook(request: Request): Promise<EmailEvent[]>;
  /** Optional: delivery state for reconciliation. */
  getDelivery?(providerMessageId: string): Promise<{ state: "queued" | "delivered" | "bounced" | "complained" | "unknown"; at?: string }>;
}

export interface InboundMessage {
  providerMessageId: string;
  threadId: string;
  from: { email: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  /** The body; full taint. */
  text: string;
  receivedAt: string;
  inReplyTo?: string;
  references?: string[];
  /** Auto-Submitted, Precedence, List-Id and friends, for structural triage. */
  headers: Record<string, string>;
  isFromUs: boolean;
}

export interface InboxProvider {
  readonly name: string;
  listNew(args: { since?: string; cursor?: string; limit: number }): Promise<Page<InboundMessage>>;
  getThread(threadId: string): Promise<InboundMessage[]>;
  createDraft(draft: { threadId?: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[] }): Promise<{ draftId: string }>;
  updateDraft(draftId: string, text: string): Promise<void>;
  deleteDraft(draftId: string): Promise<void>;
  /** Send a reply from the mailbox. effectKey is claimed by core. */
  send(message: OutboundMessage & { threadId?: string }): Promise<SendOutcome>;
  /** Optional push notifications, so new replies arrive within a minute. */
  watch?(): Promise<{ expiresAt: string }>;
}
