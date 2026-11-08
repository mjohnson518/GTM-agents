// GTM-agents: the Worker environment: bindings declared in wrangler.jsonc, plus vars and secrets.
// docs/ARCHITECTURE.md describes what each binding is for. Secrets come from `wrangler secret put`.

export interface EventMessage {
  /** The event row id; the consumer loads the payload from the database and blob storage. */
  id: string;
}

export interface ChatMessage {
  updateId: string;
  chatId: string;
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
}
