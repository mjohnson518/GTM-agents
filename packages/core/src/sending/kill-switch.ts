// GTM-agents: the cold outreach kill switch.
//
// A pause stops cold outreach: the cold batch and sequence follow-ups to people who have not
// replied. Replies and lifecycle mail keep flowing (the system halt stops those). Each pause is a
// KV record {reason, source, since}, kept under one of two keys:
//   - outreach:cold-pause:critical, lifted only by an explicit operator call (liftCritical: true);
//   - outreach:cold-pause, a warning-level pause that automation (such as a bounce monitor after
//     clean days) may set and lift.
// Automation may add a critical pause when none stands, but never overwrites, lowers or lifts one,
// so a stale or racing read in an automated path can never weaken a critical pause.
//
// It fails closed: a record that cannot be read, a KV error or a missing binding counts as a
// critical pause.
import type { KvStore } from "../shared/kv.ts";

export const COLD_PAUSE_KEY = "outreach:cold-pause";
export const COLD_PAUSE_CRITICAL_KEY = "outreach:cold-pause:critical";

export type PauseSeverity = "warning" | "critical";

export interface ColdPauseState {
  paused: boolean;
  reason?: string;
  source?: string;
  since?: string;
  severity?: PauseSeverity;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function parseRecord(raw: string): { reason?: string; source?: string; since?: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;
    return { reason: str(r.reason), source: str(r.source), since: str(r.since) };
  } catch {
    return null;
  }
}

export async function readColdPause(kv: Pick<KvStore, "get"> | undefined | null): Promise<ColdPauseState> {
  const failClosed = (reason: string): ColdPauseState => ({ paused: true, reason, source: "fail-closed", severity: "critical" });
  if (!kv) return failClosed("the KV binding is missing, so the kill switch cannot be read");
  let critical: string | null;
  let warning: string | null;
  try {
    [critical, warning] = await Promise.all([kv.get(COLD_PAUSE_CRITICAL_KEY), kv.get(COLD_PAUSE_KEY)]);
  } catch {
    return failClosed("the kill switch could not be read; cold outreach is held until it can be");
  }
  if (critical !== null) {
    const record = parseRecord(critical);
    return record ? { paused: true, ...record, severity: "critical" } : failClosed("the critical pause record is not readable JSON");
  }
  if (warning !== null) {
    const record = parseRecord(warning);
    return record ? { paused: true, ...record, severity: "warning" } : failClosed("the pause record is not readable JSON");
  }
  return { paused: false };
}

/** Pause cold outreach. A critical pause goes under its own key; a warning never touches it. */
export async function pauseColdOutreach(
  kv: KvStore,
  pause: { reason: string; source: string; severity?: PauseSeverity },
  now: Date = new Date(),
): Promise<ColdPauseState> {
  const severity: PauseSeverity = pause.severity === "warning" ? "warning" : "critical";
  const record = { reason: pause.reason, source: pause.source, since: now.toISOString() };
  await kv.put(severity === "critical" ? COLD_PAUSE_CRITICAL_KEY : COLD_PAUSE_KEY, JSON.stringify(record));
  return readColdPause(kv);
}

export type ResumeResult = { ok: true; previous: ColdPauseState } | { ok: false; previous: ColdPauseState; refused: string };

/**
 * Lift a pause. Without liftCritical only the warning-level pause is lifted, and the call is
 * refused while a critical pause (or an unreadable state) remains. With liftCritical, the operator
 * path lifts both.
 */
export async function resumeColdOutreach(kv: KvStore, options: { liftCritical?: boolean } = {}): Promise<ResumeResult> {
  const previous = await readColdPause(kv);
  if (!previous.paused) return { ok: true, previous };
  if (options.liftCritical === true) {
    await kv.delete(COLD_PAUSE_CRITICAL_KEY);
    await kv.delete(COLD_PAUSE_KEY);
    return { ok: true, previous };
  }
  if (previous.severity !== "warning") return { ok: false, previous, refused: "a critical pause is lifted only by the operator" };
  await kv.delete(COLD_PAUSE_KEY);
  return { ok: true, previous };
}
