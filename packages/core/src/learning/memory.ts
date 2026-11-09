// GTM-agents: long-term memory text the self-improvement loops write: the agent review's corrective
// guidance and the retrospective's notes.
//
// Writing memory is bookkeeping: it never throws and never fails the loop that wrote it. Text is
// sanitized (capped, control characters removed, injection patterns redacted, links defanged,
// addresses replaced) before it is stored, in the memories table and the memory_fts index together.
// Memory is guidance for prompts the operator's own agent reads; no prospect-facing writer reads it.
// It is model output written after reading fenced outside text, so a prompt that reads it carries it
// in the user turn, fenced as data, never in a system prompt.
import { defang } from "./text.ts";

export const MEMORY_KINDS = ["agent_review_guidance", "strategy_learning"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** The longest memory text kept. */
export const MEMORY_MAX_CHARS = 600;

export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  importance?: number;
  source: string;
  runId?: string;
  now: Date;
}

/** Store one memory. Returns its id, or null when it was empty or could not be written. Never throws. */
export async function storeMemory(db: D1Database, input: MemoryInput): Promise<string | null> {
  try {
    const text = defang(input.text, MEMORY_MAX_CHARS);
    if (!text) return null;
    const importance = Math.min(1, Math.max(0, Number.isFinite(input.importance) ? (input.importance as number) : 0.5));
    const id = `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db.batch([
      db
        .prepare("INSERT INTO memories (id, kind, text, importance, source, run_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(id, input.kind, text, importance, input.source.slice(0, 64), input.runId ?? null, input.now.toISOString()),
      db.prepare("INSERT INTO memory_fts (memory_id, kind, text) VALUES (?1, ?2, ?3)").bind(id, input.kind, text),
    ]);
    return id;
  } catch {
    return null;
  }
}

/** The newest memories of a kind, newest first. Empty on a read error. */
export async function recentMemories(db: D1Database, kind: MemoryKind, limit = 10): Promise<Array<{ id: string; text: string; createdAt: string }>> {
  try {
    const { results } = await db
      .prepare("SELECT id, text, created_at FROM memories WHERE kind = ?1 ORDER BY created_at DESC LIMIT ?2")
      .bind(kind, Math.max(1, Math.min(50, Math.floor(limit))))
      .all<{ id: string; text: string; created_at: string }>();
    return results.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));
  } catch {
    return [];
  }
}
