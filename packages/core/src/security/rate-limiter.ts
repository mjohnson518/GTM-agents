// GTM-agents: per-category rate limits.
//
// A fixed window per category and identifier, counted in KV. It is best-effort: KV is eventually
// consistent and the read-then-write is not atomic, so concurrent calls in different locations can
// overshoot a limit. It exists to stop runaway loops and to stay inside providers' limits, not to
// enforce an exact quota; spend is enforced exactly by the budget gate, which reads the database.
//
// It is bookkeeping, so it fails open: if KV cannot be read or written, the call is allowed and the
// result says it was degraded. A category with no configured limit is not limited.
import type { KvStore } from "../shared/kv.ts";

export interface RateLimit {
  max: number;
  windowSeconds: number;
}

/** Default limits. Tool classes and manifests name these categories in `rateCategory`. */
export const RATE_LIMITS: Readonly<Record<string, RateLimit>> = Object.freeze({
  api: { max: 100, windowSeconds: 60 },
  chat: { max: 30, windowSeconds: 60 },
  web: { max: 40, windowSeconds: 3600 },
  enrichment: { max: 30, windowSeconds: 3600 },
  mail: { max: 50, windowSeconds: 3600 },
  search: { max: 20, windowSeconds: 3600 },
  git_write: { max: 20, windowSeconds: 3600 },
  sandbox: { max: 10, windowSeconds: 3600 },
  code_mode: { max: 30, windowSeconds: 3600 },
  esp: { max: 30, windowSeconds: 3600 },
  billing: { max: 20, windowSeconds: 3600 },
});

export interface RateLimitResult {
  allowed: boolean;
  /** Calls left in this window after this one. Infinity when the category has no limit. */
  remaining: number;
  retryAfterSeconds?: number;
  /** True when KV failed and the call was allowed without being counted. */
  degraded?: boolean;
}

// KV requires an expiration of at least 60 seconds.
const MIN_TTL_SECONDS = 60;

export interface RateLimitOptions {
  limits?: Readonly<Record<string, RateLimit>>;
  now?: number;
}

/** Count one call against `category` for `identifier`, and say whether it may proceed. */
export async function checkRateLimit(kv: KvStore | undefined | null, category: string, identifier: string, options: RateLimitOptions = {}): Promise<RateLimitResult> {
  const limits = options.limits ?? RATE_LIMITS;
  const limit = Object.hasOwn(limits, category) ? limits[category] : undefined;
  // A missing or malformed limit is no limit: rate limits are bookkeeping and fail open.
  if (!limit || !(Number.isInteger(limit.max) && limit.max >= 0) || !(Number.isFinite(limit.windowSeconds) && limit.windowSeconds > 0)) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  }
  const now = options.now ?? Date.now();
  const windowMs = limit.windowSeconds * 1000;
  const window = Math.floor(now / windowMs);
  const key = `ratelimit:${category}:${identifier}:${window}`;
  try {
    if (!kv) throw new Error("the KV binding is missing");
    const current = Number.parseInt((await kv.get(key)) ?? "0", 10) || 0;
    if (current >= limit.max) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000)) };
    }
    await kv.put(key, String(current + 1), { expirationTtl: Math.max(MIN_TTL_SECONDS, limit.windowSeconds + MIN_TTL_SECONDS) });
    return { allowed: true, remaining: limit.max - current - 1 };
  } catch {
    return { allowed: true, remaining: -1, degraded: true };
  }
}
