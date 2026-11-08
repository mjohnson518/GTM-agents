// GTM-agents: the provider circuit breaker.
//
// Three consecutive provider failures in one UTC day open the breaker for the rest of that day:
// every send that reaches it is deferred to the next midnight UTC, and the operator is paged once.
// A batch that the provider accepts resets the count. A failure is a provider call that threw, or
// one where no message was accepted and the provider refused for its own reasons (unavailable,
// rate limited, out of quota, an authentication problem, an ambiguous error). A message the
// provider rejected as invalid is the message's problem, not the provider's, and does not count.
//
// State is one KV record per UTC day, {consecutive, openedAt}, kept two days. Reading it is a gate:
// a missing binding or a failed read counts as open. Writing it is bookkeeping: a failed write is
// dropped (and the halt, read from the same store, fails closed anyway).
import type { KvStore } from "../shared/kv.ts";
import { breakerKey } from "./flags.ts";
import { utcDay } from "./pages.ts";

export const BREAKER_THRESHOLD = 3;
const TTL_SECONDS = 2 * 24 * 60 * 60;

export interface BreakerState {
  open: boolean;
  consecutive: number;
  openedAt?: string;
  /** True when the state could not be read, which counts as open. */
  unreadable?: boolean;
}

function parse(raw: string | null): { consecutive: number; openedAt?: string } | null {
  if (raw === null) return { consecutive: 0 };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const consecutive = typeof record.consecutive === "number" && Number.isInteger(record.consecutive) && record.consecutive >= 0 ? record.consecutive : null;
    if (consecutive === null) return null;
    return { consecutive, ...(typeof record.openedAt === "string" ? { openedAt: record.openedAt } : {}) };
  } catch {
    return null;
  }
}

export async function readBreaker(kv: Pick<KvStore, "get"> | undefined | null, now: Date): Promise<BreakerState> {
  if (!kv) return { open: true, consecutive: 0, unreadable: true };
  let raw: string | null;
  try {
    raw = await kv.get(breakerKey(utcDay(now)));
  } catch {
    return { open: true, consecutive: 0, unreadable: true };
  }
  const record = parse(raw);
  if (!record) return { open: true, consecutive: 0, unreadable: true };
  const open = record.openedAt !== undefined || record.consecutive >= BREAKER_THRESHOLD;
  return { open, consecutive: record.consecutive, ...(record.openedAt ? { openedAt: record.openedAt } : {}) };
}

/** Count one provider failure. Returns the new state; `opened` is true when this failure opened it. */
export async function recordProviderFailure(kv: KvStore | undefined | null, now: Date): Promise<BreakerState & { opened: boolean }> {
  const current = await readBreaker(kv, now);
  const consecutive = current.consecutive + 1;
  const wasOpen = current.open;
  const open = wasOpen || consecutive >= BREAKER_THRESHOLD;
  const openedAt = current.openedAt ?? (open ? now.toISOString() : undefined);
  try {
    await kv?.put(breakerKey(utcDay(now)), JSON.stringify({ consecutive, ...(openedAt ? { openedAt } : {}) }), { expirationTtl: TTL_SECONDS });
  } catch {
    // Bookkeeping: the count is lost, and the next failure starts again from what is stored.
  }
  return { open, consecutive, ...(openedAt ? { openedAt } : {}), opened: open && !wasOpen };
}

/** A batch the provider accepted: reset the count, unless the breaker is already open for the day. */
export async function recordProviderSuccess(kv: KvStore | undefined | null, now: Date): Promise<void> {
  try {
    const current = await readBreaker(kv, now);
    if (current.open || current.consecutive === 0) return;
    await kv?.put(breakerKey(utcDay(now)), JSON.stringify({ consecutive: 0 }), { expirationTtl: TTL_SECONDS });
  } catch {
    // Bookkeeping.
  }
}
