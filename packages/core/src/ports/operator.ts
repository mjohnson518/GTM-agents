// GTM-agents: the operator channel port. Approval requests carry the content digest and button
// callbacks return it, so core can refuse an approval of content that has since changed.
// Authorization (which chats and users may command the agent) belongs to core, from gtm.config.ts.

export interface OperatorMessage {
  /** Plain text or the channel's minimal markup. */
  text: string;
  /** Rows of buttons. */
  buttons?: Array<Array<{ label: string; action: string; payload: string }>>;
  /** Groups related messages when the channel supports it. */
  threadKey?: string;
  silent?: boolean;
  /** The chat to deliver to, as the channel reported it in an update. Omitted: the channel's default operator chat. */
  chatId?: string;
  /**
   * How soon the operator must see it, for core's operator outbox (operator/outbox.ts); channels
   * ignore it. "reply" answers something the operator just sent and is always delivered at once.
   * "page" (a failing job, an alert) is delivered at once, silently during quiet hours. "notice", the
   * default, may be held for quiet hours or the hourly limit and delivered later, folded with others.
   */
  kind?: "reply" | "page" | "notice";
}

export interface ApprovalRequest {
  approvalId: string;
  /** The chat to deliver to. Omitted: the channel's default operator chat. */
  chatId?: string;
  kind: "send" | "sequence" | "learning" | "config" | "pr" | "custom";
  /** sha256 of the exact content being approved. */
  digest: string;
  summary: string;
  preview: string;
  actions: Array<"approve" | "edit" | "skip" | "snooze" | "reject">;
  /** Deliver without a sound or vibration where the channel supports it (core sets it during quiet hours). */
  silent?: boolean;
}

export type OperatorUpdate =
  | { type: "command"; chatId: string; userId: string; text: string; messageId: string }
  | { type: "callback"; chatId: string; userId: string; action: string; payload: string; messageId: string; callbackId: string }
  | { type: "ignored"; reason: string };

export interface OperatorChannel {
  readonly name: string;
  notify(message: OperatorMessage): Promise<{ messageId: string }>;
  requestApproval(req: ApprovalRequest): Promise<{ messageId: string }>;
  editMessage(messageId: string, message: OperatorMessage): Promise<void>;
  acknowledgeCallback(callbackId: string, text?: string): Promise<void>;
  /** Verify the inbound webhook (for example a secret-token header) and normalize the update. */
  parseUpdate(request: Request): Promise<OperatorUpdate>;
  /** Register the webhook URL with the vendor. A deployment calls it once after deploying. */
  registerWebhook(url: string): Promise<void>;
}
