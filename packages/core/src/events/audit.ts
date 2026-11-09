// GTM-agents: the audit log writer for the event spine, the lifecycle and the bridges.
//
// An audit row is bookkeeping: it is written fire-and-forget and a failure is dropped, never
// allowed to fail the path that wrote it. Details hold ids, counts, enum values and short error
// text only: never an address, a name, a payload or anything a person wrote.

const MAX_DETAIL_CHARS = 2000;

export async function writeAudit(db: D1Database, entry: { agentId: string; action: string; details?: Record<string, unknown>; now?: Date }): Promise<void> {
  try {
    let details = entry.details ? JSON.stringify(entry.details) : null;
    if (details && details.length > MAX_DETAIL_CHARS) details = JSON.stringify({ truncated: true });
    await db
      .prepare("INSERT INTO audit_log (agent_id, action, details, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(entry.agentId.slice(0, 60), entry.action.slice(0, 80), details, (entry.now ?? new Date()).toISOString())
      .run();
  } catch {
    // Bookkeeping fails open.
  }
}
