// GTM-agents: the Worker environment: bindings declared in wrangler.jsonc, plus vars and secrets.
// docs/ARCHITECTURE.md describes what each binding is for. Secrets come from `wrangler secret put`.

export interface EventMessage {
  /** The event row id; the consumer loads the payload from the database and blob storage. */
  id: string;
}

/** One operator message on CHAT_QUEUE. The webhook writes it after verifying and allowlisting the sender. */
export interface ChatMessage {
  /** The effects-ledger key the webhook claimed for this update. */
  updateId: string;
  chatId: string;
  userId: string;
  messageId?: string;
  sessionKey: string;
  text: string;
}

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  BUCKET: R2Bucket;
  MEMORY: Vectorize;
  AI: Ai;
  GATEWAY: DurableObjectNamespace;
  FOLLOWUP_AGENT: DurableObjectNamespace;
  EVENTS_QUEUE: Queue<EventMessage>;
  CHAT_QUEUE: Queue<ChatMessage>;
  ASSETS: Fetcher;

  /** Public base URL of this deployment, used in unsubscribe and booking links. */
  AGENT_BASE_URL?: string;
  ENVIRONMENT?: string;

  GATEWAY_TOKEN?: string;
  UNSUBSCRIBE_SIGNING_KEY?: string;
  PRODUCT_APP_URL?: string;
  PRODUCT_WEBHOOK_SECRET?: string;
  PRODUCT_READ_SECRET?: string;

  /** The shared secret the mailbox push subscription carries to POST /api/webhooks/mail (docs/INBOX.md). */
  MAIL_PUSH_SECRET?: string;
  /** The Google OAuth client the Google adapters authenticate with. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The refresh token for the warm mailbox (inbox-gmail), granted with the Gmail scopes. */
  GMAIL_REFRESH_TOKEN?: string;
  /** The Pub/Sub topic Gmail push notifications publish to: projects/<project>/topics/<topic>. */
  GMAIL_PUBSUB_TOPIC?: string;
}
