// GTM-agents: the Worker bindings and core secrets every deployment needs.
// `gtm doctor` checks a deployment's wrangler.jsonc and secrets against these lists.

export type BindingKind =
  | "d1_databases"
  | "kv_namespaces"
  | "r2_buckets"
  | "vectorize"
  | "ai"
  | "durable_objects"
  | "queues.producers"
  | "assets";

export interface BindingSpec {
  name: string;
  kind: BindingKind;
  purpose: string;
  /** Durable Object class the binding must point at. */
  className?: string;
}

export const REQUIRED_BINDINGS: readonly BindingSpec[] = [
  { name: "DB", kind: "d1_databases", purpose: "the system of record" },
  { name: "KV", kind: "kv_namespaces", purpose: "flags, caches, counters, the approved brain" },
  { name: "BUCKET", kind: "r2_buckets", purpose: "raw event payloads, briefs, archives" },
  { name: "MEMORY", kind: "vectorize", purpose: "long-term memory" },
  { name: "AI", kind: "ai", purpose: "embeddings and small classifiers" },
  { name: "GATEWAY", kind: "durable_objects", purpose: "dashboard WebSocket RPC", className: "OperatorGateway" },
  { name: "FOLLOWUP_AGENT", kind: "durable_objects", purpose: "per-contact lifecycle timers", className: "FollowupAgent" },
  { name: "EVENTS_QUEUE", kind: "queues.producers", purpose: "event spine dispatch" },
  { name: "CHAT_QUEUE", kind: "queues.producers", purpose: "long chat turns" },
  { name: "ASSETS", kind: "assets", purpose: "the admin dashboard" },
];

export interface SecretSpec {
  name: string;
  required: boolean;
  purpose: string;
}

export const CORE_SECRETS: readonly SecretSpec[] = [
  { name: "GATEWAY_TOKEN", required: true, purpose: "bearer token for the dashboard and the run status API" },
  { name: "UNSUBSCRIBE_SIGNING_KEY", required: true, purpose: "signs one-click unsubscribe and booking links" },
  { name: "PRODUCT_WEBHOOK_SECRET", required: false, purpose: "verifies product events from the host application" },
  { name: "PRODUCT_READ_SECRET", required: false, purpose: "signs reconciliation reads to the host application" },
];
