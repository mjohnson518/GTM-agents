// GTM-agents: the contract between whatever composes outreach (the cold batch, sequences, replies)
// and the send function at the provider boundary.
//
// A composer builds OutreachItems and hands them to a SendOutreach function. The send function runs
// every boundary check itself (halt, kill switch, suppression, content lint, verification policy,
// send window, caps, circuit breaker), so no caller can skip one, and reports one outcome per item.
import type { SendPath } from "./gates.ts";

export interface OutreachItem {
  /**
   * Stable for this message, such as `<date>:<contact>` for the cold batch. The send function claims
   * it in the effects ledger, so the same item is never sent twice.
   */
  idempotencyKey: string;
  path: SendPath;
  contactId: string;
  /** The recipient's normalized address. */
  to: string;
  toName?: string;
  subject: string;
  /** Plain text, without the footer: the send function appends it. */
  body: string;
  draftId?: string;
  campaignId?: string;
  templateId?: string;
  experimentId?: string;
  experimentArm?: string;
  sequenceStep?: number;
  /** For follow-ups and replies: the provider message ids to thread under. */
  inReplyTo?: string;
  references?: readonly string[];
  /**
   * When the send relies on an approval: the digest the operator approved. The send function
   * recomputes the draft's digest and refuses a mismatch.
   */
  approvedDigest?: string;
  /**
   * For a reply through the warm mailbox: the mailbox thread it answers. The send function checks
   * that the contact wrote in on that thread before sending on it.
   */
  threadId?: string;
}

/** Why an item waits for later instead of going now. */
export type DeferReason = "halted" | "cold_paused" | "outside_window" | "domain_cap" | "account_cap" | "circuit_open" | "provider_unavailable";

/** Why an item will not be sent at all. */
export type SendRefusal = "suppressed" | "unparseable" | "undeliverable" | "content_lint" | "approval_mismatch" | "invalid";

export type OutreachOutcome =
  | {
      idempotencyKey: string;
      status: "sent";
      providerMessageId: string;
      sendId: string;
      /** Bookkeeping writes that failed after the send (logged and dropped; the send stands). */
      failedWrites?: string[];
    }
  | { idempotencyKey: string; status: "deferred"; reason: DeferReason; nextAttemptAt: string }
  | { idempotencyKey: string; status: "blocked"; reason: SendRefusal; message: string }
  | { idempotencyKey: string; status: "duplicate" }
  | { idempotencyKey: string; status: "failed"; retryable: boolean; message: string };

/** The send function. Always resolves, with one outcome per item, in order. */
export type SendOutreach = (items: readonly OutreachItem[]) => Promise<OutreachOutcome[]>;
