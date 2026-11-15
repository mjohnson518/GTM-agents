// GTM-agents: operator chat sessions: their taint and their history (migration 0014).
//
// The session's taint is a gate input, so reading it fails closed: a session that cannot be read is
// not run. Writing follows two rules:
//   - taint only rises. raiseSessionTaint writes the new level only over levels it is at least as
//     high as (computed with maxTaintLevel), so a slow turn can never lower a level a faster turn
//     raised;
//   - a turn writes nothing into a session that was cleared after the turn loaded it: its taint
//     and history belong to the conversation that /clean ended.
// The reply joins the history only after its taint is recorded. A reply can quote what the turn
// read, and history without its taint would carry that text into turns that believe they are clean.
// clearSession is the only way taint goes down: the operator's /clean, which deletes the history
// and resets the taint in one batch.
//
// Core can also write a line of its own into a session's history: a decision line, when the
// operator approves or rejects a draft a turn created (agents/decisions.ts). It is stored on the
// operator's side and marked as the system's (systemMessageContent). Lines written since the last
// reply are not a message waiting for an answer: loadSession hands them to the next turn (pending),
// which shows them in front of the operator's message, and later turns see them joined to it.
import { TAINT_LEVELS, maxTaintLevel, toTaintLevel, type TaintLevel } from "../security/taint.ts";

/** How many stored messages a turn loads as history. */
export const HISTORY_LIMIT = 40;
/**
 * How many lines core wrote (decision lines) a turn loads at most, beyond HISTORY_LIMIT: they never
 * count against the conversation's own window. Older ones are counted and named, never silently lost.
 */
export const SYSTEM_LINES_LIMIT = 20;
/** A stored message core wrote, in SQL: on the operator's side, marked as the system's. */
export const SYSTEM_ROW_SQL = "(role = 'user' AND json_extract(content, '$.from') IS 'system')";
/** The longest stored message, in characters. Longer text is cut at the end. */
export const STORED_MESSAGE_MAX_CHARS = 8000;

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionState {
  sessionKey: string;
  chatId: string;
  taint: TaintLevel;
  /** When the session was last cleared, or null. Turns pass it back so a clean session stays clean. */
  clearedAt: string | null;
  history: HistoryMessage[];
  /** Messages the operator and the agent wrote in this session (not core's lines), which may be more than a turn loads. */
  messageCount: number;
  /** Lines core wrote since the last reply (decision lines), oldest first, for the next turn to show. */
  pending: string[];
}

/** The session key for a chat. One session per chat. */
export function sessionKeyFor(chatId: string): string {
  return `chat:${chatId}`;
}

function iso(now: Date): string {
  return now.toISOString();
}

/** Make sure a session row exists. Throws on a database error. */
export async function ensureSession(db: D1Database, sessionKey: string, chatId: string, now: Date = new Date()): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO chat_sessions (session_key, chat_id, taint, created_at, updated_at) VALUES (?1, ?2, 'none', ?3, ?3)")
    .bind(sessionKey, chatId, iso(now))
    .run();
}

/** What the `from` field of a stored message says when core wrote it. */
const FROM_SYSTEM = "system";

/** The stored content of a line core writes into a session's history. */
export function systemMessageContent(text: string): string {
  return JSON.stringify({ text: clip(text), from: FROM_SYSTEM });
}

function decodeRow(content: string): { text: string; system: boolean } | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
      return { text: (parsed as { text: string }).text, system: (parsed as { from?: unknown }).from === FROM_SYSTEM };
    }
  } catch {
    // A row that does not decode is skipped rather than guessed at.
  }
  return null;
}

/** True when a stored message's content is a line core wrote, not the operator's or the agent's. */
export function isSystemMessage(content: string): boolean {
  return decodeRow(content)?.system === true;
}

/**
 * Turn stored rows into a history that starts with the operator and alternates roles. Consecutive
 * messages from the same side are joined, and a leading assistant message is dropped.
 */
export function shapeHistory(rows: HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const row of rows) {
    if (row.text.trim() === "") continue;
    if (out.length === 0 && row.role !== "user") continue;
    const last = out.at(-1);
    if (last && last.role === row.role) last.text = `${last.text}\n\n${row.text}`;
    else out.push({ role: row.role, text: row.text });
  }
  if (out.at(-1)?.role === "user") out.pop();
  return out;
}

/**
 * Load a session, creating it when it is new. Throws when the database cannot be read: the caller
 * must not run a turn without knowing the session's taint.
 */
export async function loadSession(db: D1Database, sessionKey: string, chatId: string, now: Date = new Date()): Promise<SessionState> {
  await ensureSession(db, sessionKey, chatId, now);
  // One batch is one transaction: the taint and the history are read from the same state, so a
  // turn finishing in between cannot hand this turn its tainted reply under the old, lower taint.
  const [sessionRows, historyRows, countRows] = await db.batch([
    db.prepare("SELECT session_key, chat_id, taint, cleared_at FROM chat_sessions WHERE session_key = ?1").bind(sessionKey),
    // The last HISTORY_LIMIT messages the operator and the agent wrote, and at most
    // SYSTEM_LINES_LIMIT lines core wrote since the oldest of them, so decisions never crowd out the
    // conversation.
    db
      .prepare(
        `WITH said AS (SELECT id FROM chat_messages WHERE session_key = ?1 AND NOT ${SYSTEM_ROW_SQL} ORDER BY id DESC LIMIT ?2),
              lines AS (SELECT id FROM chat_messages WHERE session_key = ?1 AND ${SYSTEM_ROW_SQL} AND id > COALESCE((SELECT MIN(id) FROM said), 0) ORDER BY id DESC LIMIT ?3)
         SELECT role, content FROM chat_messages WHERE id IN (SELECT id FROM said UNION ALL SELECT id FROM lines) ORDER BY id ASC`,
      )
      .bind(sessionKey, HISTORY_LIMIT, SYSTEM_LINES_LIMIT),
    // Messages the operator and the agent wrote, and the lines written since the last of them.
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM chat_messages WHERE session_key = ?1 AND NOT ${SYSTEM_ROW_SQL}) AS n,
                (SELECT COUNT(*) FROM chat_messages WHERE session_key = ?1 AND ${SYSTEM_ROW_SQL}
                   AND id > COALESCE((SELECT MAX(id) FROM chat_messages WHERE session_key = ?1 AND NOT ${SYSTEM_ROW_SQL}), 0)) AS waiting`,
      )
      .bind(sessionKey),
  ]);
  const row = (sessionRows?.results as Array<{ session_key: string; chat_id: string; taint: string; cleared_at: string | null }> | undefined)?.[0];
  if (!row) throw new Error("the chat session could not be read");
  const results = (historyRows?.results ?? []) as Array<{ role: string; content: string }>;
  const count = (countRows?.results as Array<{ n: number; waiting: number }> | undefined)?.[0];
  const rows: Array<HistoryMessage & { system: boolean }> = [];
  for (const r of results) {
    const decoded = decodeRow(r.content);
    if (decoded !== null && (r.role === "user" || r.role === "assistant")) rows.push({ role: r.role, text: decoded.text, system: decoded.system && r.role === "user" });
  }
  // Lines core wrote after the last reply go to this turn, not into a history that would drop them.
  let cut = rows.length;
  while (cut > 0 && rows[cut - 1]?.system === true) cut -= 1;
  const pending = rows.slice(cut).map((r) => r.text);
  const unshown = Number(count?.waiting ?? 0) - pending.length;
  if (unshown > 0) pending.unshift(`[Decision from the system: ${unshown} earlier ${unshown === 1 ? "decision" : "decisions"} on drafts ${unshown === 1 ? "is" : "are"} not shown here. Do not say a draft is still waiting unless the operator confirms it.]`);
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    // A stored value that is not a known level reads as full, so corruption only makes things stricter.
    taint: toTaintLevel(row.taint),
    clearedAt: row.cleared_at,
    history: shapeHistory(rows.slice(0, cut).map(({ role, text }) => ({ role, text }))),
    messageCount: Number(count?.n ?? 0),
    pending,
  };
}

/** The levels a session may be moved up from when raising to `level`: every level at or below it. */
function levelsAtOrBelow(level: TaintLevel): TaintLevel[] {
  return TAINT_LEVELS.filter((l) => maxTaintLevel(l, level) === level);
}

/**
 * Raise a session's taint to at least `level`, unless the session was cleared after `clearedAt`.
 * Returns true when the session holds at least `level` afterwards (written now or already higher),
 * false when it was cleared in the meantime. Throws on a database error.
 */
export async function raiseSessionTaint(db: D1Database, sessionKey: string, level: TaintLevel, clearedAt: string | null, now: Date = new Date()): Promise<boolean> {
  const target = toTaintLevel(level);
  const below = levelsAtOrBelow(target);
  const placeholders = below.map((_, i) => `?${i + 5}`).join(", ");
  await db
    .prepare(`UPDATE chat_sessions SET taint = ?1, updated_at = ?2 WHERE session_key = ?3 AND cleared_at IS ?4 AND taint IN (${placeholders})`)
    .bind(target, iso(now), sessionKey, clearedAt, ...below)
    .run();
  const row = await db.prepare("SELECT taint, cleared_at FROM chat_sessions WHERE session_key = ?1").bind(sessionKey).first<{ taint: string; cleared_at: string | null }>();
  if (!row || row.cleared_at !== clearedAt) return false;
  return maxTaintLevel(toTaintLevel(row.taint), target) === toTaintLevel(row.taint);
}

function clip(text: string): string {
  return text.length > STORED_MESSAGE_MAX_CHARS ? `${text.slice(0, STORED_MESSAGE_MAX_CHARS)}\n[cut]` : text;
}

/**
 * Append a turn's operator message and reply, unless the session was cleared after `clearedAt`.
 * Returns false when nothing was written. Throws on a database error.
 */
export async function appendTurn(
  db: D1Database,
  args: { sessionKey: string; clearedAt: string | null; turnId: string; user: string; assistant: string },
  now: Date = new Date(),
): Promise<boolean> {
  const at = iso(now);
  const guard = "EXISTS (SELECT 1 FROM chat_sessions WHERE session_key = ?1 AND cleared_at IS ?2)";
  const results = await db.batch([
    db
      .prepare(`INSERT INTO chat_messages (session_key, role, content, turn_id, created_at) SELECT ?1, 'user', ?3, ?4, ?5 WHERE ${guard}`)
      .bind(args.sessionKey, args.clearedAt, JSON.stringify({ text: clip(args.user) }), args.turnId, at),
    db
      .prepare(`INSERT INTO chat_messages (session_key, role, content, turn_id, created_at) SELECT ?1, 'assistant', ?3, ?4, ?5 WHERE ${guard}`)
      .bind(args.sessionKey, args.clearedAt, JSON.stringify({ text: clip(args.assistant) }), args.turnId, at),
  ]);
  return results.every((r) => (r.meta.changes ?? 0) > 0);
}

/** /clean: delete the history and reset the taint together, in one batch. Throws on a database error. */
export async function clearSession(db: D1Database, sessionKey: string, chatId: string, now: Date = new Date()): Promise<void> {
  const at = iso(now);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO chat_sessions (session_key, chat_id, taint, created_at, updated_at) VALUES (?1, ?2, 'none', ?3, ?3)").bind(sessionKey, chatId, at),
    db.prepare("DELETE FROM chat_messages WHERE session_key = ?1").bind(sessionKey),
    db.prepare("UPDATE chat_sessions SET taint = 'none', cleared_at = ?2, updated_at = ?2 WHERE session_key = ?1").bind(sessionKey, at),
  ]);
}
