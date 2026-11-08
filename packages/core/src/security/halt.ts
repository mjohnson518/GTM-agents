// GTM-agents: the system halt.
//
// One switch that stops everything that acts on the world: every scheduled job (the job runner
// checks it first) and every send, replies included (checkSendGates checks it first). The cold
// outreach kill switch stops cold outreach only; this stops the system.
//
// It fails closed. Only an absent key means running. Any value, a value that does not parse, a KV
// read that throws, or a missing KV binding means halted. Only the operator sets or clears it, from
// the operator channel or the CLI; no agent tool writes it.
import type { KvStore } from "../shared/kv.ts";

export const HALT_KEY = "system:halt";

export interface HaltState {
  halted: boolean;
  /** True when the state itself could not be read, rather than set by the operator. */
  unreadable?: boolean;
  reason?: string;
  since?: string;
  by?: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export async function readHalt(kv: Pick<KvStore, "get"> | undefined | null): Promise<HaltState> {
  if (!kv) return { halted: true, unreadable: true, reason: "the KV binding is missing, so the halt flag cannot be read" };
  let raw: string | null;
  try {
    raw = await kv.get(HALT_KEY);
  } catch {
    return { halted: true, unreadable: true, reason: "the halt flag could not be read; holding until it can be" };
  }
  if (raw === null) return { halted: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return { halted: true, reason: str(record.reason), since: str(record.since), by: str(record.by) };
    }
  } catch {
    // Not JSON: still a value, so still halted.
  }
  return { halted: true, reason: "the halt record is not readable JSON" };
}

/** Halt the system. For the operator path only. */
export async function setHalt(kv: KvStore, halt: { reason: string; by: string }, now: Date = new Date()): Promise<void> {
  await kv.put(HALT_KEY, JSON.stringify({ reason: halt.reason, by: halt.by, since: now.toISOString() }));
}

/** Lift the halt. For the operator path only. */
export async function clearHalt(kv: KvStore): Promise<void> {
  await kv.delete(HALT_KEY);
}
