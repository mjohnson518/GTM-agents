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
}

export interface ApprovalRequest {
  approvalId: string;
  kind: "send" | "sequence" | "learning" | "config" | "pr" | "custom";
  /** sha256 of the exact content being approved. */
  digest: string;
  summary: string;
  preview: string;
  actions: Array<"approve" | "edit" | "skip" | "snooze" | "reject">;
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
  /** Register the webhook URL with the vendor (used by `gtm setup`). */
  registerWebhook(url: string): Promise<void>;
}
