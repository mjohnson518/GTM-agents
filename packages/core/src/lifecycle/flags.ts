// GTM-agents: the flags the lifecycle, the product bridge and billing read, and their limits.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Reads fail
// in the direction that does less: an unreadable switch is off.

export const LIFECYCLE_FLAGS = Object.freeze({
  /**
   * The product bridge and the lifecycle: POST /api/webhooks/product records events, the spine
   * routes them, the state machine moves contacts and deals, and the lifecycle jobs run (the sweep,
   * the stalled and dormant checks, the MRR snapshot, payload retention).
   */
  enabled: "lifecycle:enabled",
  /** The nightly signed pull from the product (users, feedback, deletions). Needs lifecycle:enabled too. */
  reconcile: "lifecycle:reconcile_enabled",
  /** POST /api/webhooks/billing, through the BillingProvider port. Needs lifecycle:enabled too. */
  billing: "billing:enabled",
  /** Attribution tokens: identity resolution reads them only while this is on. */
  refTokens: "outreach:ref_tokens_enabled",
});

/** The pull's state per resource: {since, cursor, fullAt}. A rebuildable cache in KV. */
export const pullStateKey = (resource: "users" | "feedback" | "deletions"): string => `lifecycle:pull:${resource}`;

export const LIFECYCLE_LIMITS = Object.freeze({
  /** A signed-up user with no value event this long after signing up is stalled. */
  stalledAfterHours: 72,
  /** An active or paying user idle this long is dormant. */
  dormantAfterDays: 14,
  /** Contacts each lifecycle check moves per run. */
  checkRows: 200,
  /** Pages of up to pullPageSize rows read per resource per run. */
  pullPages: 3,
  pullPageSize: 200,
  /** The pull re-reads everything once this many days after its last full read. */
  fullReadDays: 7,
  /** One read waits at most this long, and reads at most this much. */
  pullTimeoutMs: 10_000,
  pullMaxBytes: 2 * 1024 * 1024,
  /** Unrouted events the sweep routes per run. */
  sweepRows: 100,
  /** Routed event payloads are deleted from blob storage after this many days; the rows stay. */
  payloadRetentionDays: 90,
  payloadRetentionRows: 500,
});
