// GTM-agents: operator pages from the delivery code: the circuit breaker, bounces and complaints,
// the bounce monitor, the deferred queue and liveness.
//
// Each page is claimed in the effects ledger under an event id that names its scope (usually one
// UTC day), so a rerun or a retry never pages twice. If sending fails or takes longer than the
// operator channel's time-out, the claim is released so a later run can try again. Pages are
// bookkeeping: they never throw and never change the outcome of the work that raised them.
import { claimPage, notifyWithin, releasePage } from "../runtime/job-runner.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { KvStore } from "../shared/kv.ts";

export interface PageInput {
  db: D1Database;
  kv: KvStore | undefined | null;
  operator: OperatorChannel | undefined;
  /** The scope of the claim, such as `delivery:breaker:2026-11-04`. */
  eventId: string;
  effect: string;
  text: string;
}

/** Send one page at most once per (eventId, effect). True when it was sent now. Never throws. */
export async function pageOnce(input: PageInput): Promise<boolean> {
  if (!input.operator) return false;
  const kv = input.kv ?? undefined;
  try {
    if (!(await claimPage(input.db, kv, input.eventId, input.effect))) return false;
    if (await notifyWithin(input.operator, input.text)) return true;
    await releasePage(input.db, kv, input.eventId, input.effect);
    return false;
  } catch {
    return false;
  }
}

/** The UTC calendar day of `now`, as YYYY-MM-DD. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** Midnight UTC after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
