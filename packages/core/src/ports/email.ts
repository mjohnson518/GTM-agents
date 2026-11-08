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
  /** Optional: the most messages one sendBatch call takes (the manifest's limits.batchSize). Core chunks to it. */
  readonly batchLimit?: number;
  sendBatch(messages: OutboundMessage[]): Promise<{ outcomes: SendOutcome[]; cost?: Cost }>;
  /**
   * Verify the webhook signature (vendor scheme, 5-minute replay window) and return typed events.
   * Throws AdapterError("auth") on a bad signature. Core returns 200 only after this resolves.
   */
  parseWebhook(request: Request): Promise<EmailEvent[]>;
  /** Optional: delivery state for reconciliation. */
  getDelivery?(providerMessageId: string): Promise<{ state: "queued" | "delivered" | "bounced" | "complained" | "unknown"; at?: string }>;
  /**
   * Optional: the RFC 5322 Message-ID the provider gave a sent email, in angle brackets, for
   * threading follow-ups under it. Some providers replace a Message-ID set by the sender, so core
   * asks for the real one. Resolves to null when the provider has none for that id (yet); throws
   * AdapterError when the lookup fails. Without this method, follow-up steps cannot be threaded and
   * the sequence sweep holds them.
   */
  getMessageId?(providerMessageId: string): Promise<string | null>;
}

export interface InboundMessage {
  /** The provider's id for the message. With the provider's name it is the dedup key. */
  providerMessageId: string;
  threadId: string;
  from: { email: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  /** The body as plain text: text/plain when the message has it, else text derived from text/html. Full taint. */
  text: string;
  /** ISO 8601. */
  receivedAt: string;
  inReplyTo?: string;
  references?: string[];
  /**
   * The headers structural triage reads, with lowercase keys (INBOUND_HEADER_NAMES in
   * @gtm-agents/core/inbox): auto-submitted, precedence, list-id, x-autoreply, message-id and
   * friends. Untrusted, like everything else in the message.
   */
  headers: Record<string, string>;
  /** True for mail the mailbox itself sent: a sent copy, a draft, a message from its own address. */
  isFromUs: boolean;
  /**
   * True for an unsent draft in the mailbox, false for a message that was sent or received. An adapter
   * that cannot tell leaves it out, and reply handling then never counts an unmarked message of ours
   * as a sent reply.
   */
  isDraft?: boolean;
  /**
   * For a delivery status notification: the text of its machine-readable parts (message/delivery-status,
   * text/rfc822-headers, the returned message's header block), so core can read the failed recipient.
   * Untrusted: core acts on it only for an address it actually sent to.
   */
  deliveryReport?: string;
}

/** One listNew call. */
export interface InboxListArgs {
  /** ISO 8601. Used when there is no cursor, or the cursor has expired: list mail received since then. */
  since?: string;
  /** Where a previous call left off (its page's cursor). */
  cursor?: string;
  /** The most messages to return. */
  limit: number;
  /**
   * Optional: which of these provider message ids core already holds. The adapter asks before it
   * fetches full messages and leaves the known ones out, so a quiet poll or a sweep costs little.
   */
  known?: (providerMessageIds: readonly string[]) => Promise<ReadonlySet<string>>;
}

/**
 * A page of new mail. For an inbox, `cursor` is where the next call resumes, and it is set whenever
 * the provider gave one, including when nothing new arrived. Core stores it only after every item
 * has been recorded.
 */
export interface InboxPage extends Page<InboundMessage> {
  /** True when more messages wait past `limit`: call again with `cursor`. */
  more?: boolean;
  /** True when the cursor passed in had expired and the listing fell back to `since`. */
  reset?: boolean;
}

export interface InboxProvider {
  readonly name: string;
  /**
   * Optional: what this mailbox can do beyond receiving. Each is true unless set to false; an
   * inbound-only adapter sets all three false, and core then skips threads, drafts and sends
   * cleanly instead of failing on every run. Methods it cannot do refuse with a non-retryable
   * "invalid" AdapterError (send: the same refusal as an outcome).
   */
  readonly capabilities?: Partial<Record<"threads" | "drafts" | "send", boolean>>;
  listNew(args: InboxListArgs): Promise<InboxPage>;
  /** Optional: whether a mailbox draft still exists (false once it was sent or discarded). Throws AdapterError on a read error. */
  draftExists?(draftId: string): Promise<boolean>;
  getThread(threadId: string): Promise<InboundMessage[]>;
  createDraft(draft: { threadId?: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[] }): Promise<{ draftId: string }>;
  updateDraft(draftId: string, text: string): Promise<void>;
  deleteDraft(draftId: string): Promise<void>;
  /** Send a reply from the mailbox. effectKey is claimed by core. */
  send(message: OutboundMessage & { threadId?: string }): Promise<SendOutcome>;
  /** Optional push notifications, so new replies arrive within a minute. */
  watch?(): Promise<{ expiresAt: string }>;
}
