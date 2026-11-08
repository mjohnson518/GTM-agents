// GTM-agents: the slice of a KV namespace that core's controls use. Cloudflare's KVNamespace
// satisfies it, and tests can pass a store that fails on purpose.

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The current time as an ISO 8601 UTC string, the timestamp format of every core table. */
export function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}

/** Midnight UTC of the day containing `now`, as ISO 8601. */
export function startOfUtcDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Midnight UTC on the first day of the month containing `now`, as ISO 8601. */
export function startOfUtcMonth(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}
