// GTM-agents: decision lines: what the operator decided about a draft, written into the chat session
// whose turn created it (migration 0034, docs/OPERATOR.md#decisions-in-the-session).
//
// A draft a hub turn creates waits for the operator's approval, and the decision is made outside any
// turn: a button in the operator chat, or the dashboard. Without this, the session never learns it,
// and the next turn still believes the draft is waiting. With operator:decision_lines_enabled on:
//   1. when a turn creates drafts and its taint is recorded, the hub records each draft's origin: the
//      session, the turn, and the session's cleared_at as the turn loaded it (recordDraftOrigins). A
//      draft the operator already decided while the turn was still running gets its line then;
//   2. when the operator approves or rejects one of those drafts, core appends one line to that
//      session's history (noteDraftDecision): the draft's id, kind and recipient, the decision and
//      the time. No model call is made. The draft's own row stays the truth; the line reports it;
//   3. the next turn in that session sees the line in front of the operator's message, and later
//      turns see it in the history where it happened (agents/sessions.ts).
// The line carries no taint. Core writes it from the draft row, and it names only what that same
// session produced, after the session's taint covered it. It is written only while the session's
// cleared_at still equals the recorded one, checked in the same statement, so a session /clean ended
// never receives a line about the conversation it no longer has. A draft no turn created (a reply to
// inbound mail, a meeting follow-up) has no origin and never writes a line: its recipient came from
// third-party text the session never read.
// Both writes are bookkeeping: a failure is logged and dropped, and never fails the turn or the
// approval. The flag is read before each write; off, or unreadable, nothing is recorded or written.
import type { FlagReader } from "../jobs/registry.ts";
import { isFlagOn } from "../jobs/loop.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { normalizeAddress } from "../sending/suppression.ts";
import { systemMessageContent } from "./sessions.ts";
import { minuteUtc } from "./timers.ts";

export const DECISION_LINES_FLAG = "operator:decision_lines_enabled";

export type DraftDecisionKind = "approved" | "rejected";

/** The draft columns a line is written from. */
export interface DecidedDraft {
  id: string;
  kind: string;
  recipient_email: string | null;
}

/** True only when the flag reads as on. A missing reader, an unset flag or a read error means off. */
export async function isDecisionLinesEnabled(flags: FlagReader | undefined): Promise<boolean> {
  if (!flags) return false;
  try {
    return isFlagOn(await flags.get(DECISION_LINES_FLAG));
  } catch {
    return false;
  }
}

/** The line core writes. The recipient is shown only when it is one plain address. */
export function decisionLine(decision: DraftDecisionKind, draft: DecidedDraft, at: Date): string {
  const to = normalizeAddress(draft.recipient_email);
  const what = `draft ${draft.id} (${draft.kind}${to ? ` to ${to}` : ""})`;
  const after = decision === "approved" ? "Approving does not send it." : "It will not be sent.";
  return `[Decision from the system: at ${minuteUtc(at.toISOString())} the operator ${decision} ${what}. ${after}]`;
}

/**
 * Record that these drafts came from this turn of this session, in one statement: only drafts that
 * still exist and were created since the turn started (so a handler cannot bind an older draft to
 * this session). A draft the operator already decided while the turn ran gets its line now.
 * Throws on a database error.
 */
export async function recordDraftOrigins(
  db: D1Database,
  origin: { sessionKey: string; clearedAt: string | null; turnId: string; draftIds: readonly string[]; since: Date },
  now: Date,
): Promise<void> {
  if (origin.draftIds.length === 0) return;
  const ids = JSON.stringify([...new Set(origin.draftIds)]);
  await db
    .prepare(
      `INSERT OR IGNORE INTO chat_draft_origins (draft_id, session_key, session_cleared_at, turn_id, created_at)
       SELECT d.id, ?2, ?3, ?4, ?5 FROM drafts d WHERE d.id IN (SELECT value FROM json_each(?1)) AND d.created_at >= ?6`,
    )
    .bind(ids, origin.sessionKey, origin.clearedAt, origin.turnId, now.toISOString(), origin.since.toISOString())
    .run();
  // A tap or the dashboard can decide a draft before its turn ends; that decision found no origin.
  const { results } = await db
    .prepare(
      `SELECT d.id, d.kind, d.recipient_email, d.status, d.updated_at FROM drafts d JOIN chat_draft_origins o ON o.draft_id = d.id
        WHERE d.id IN (SELECT value FROM json_each(?1)) AND o.turn_id = ?2 AND d.status IN ('approved', 'rejected')`,
    )
    .bind(ids, origin.turnId)
    .all<DecidedDraft & { status: DraftDecisionKind; updated_at: string }>();
  for (const d of results) {
    const at = Date.parse(d.updated_at);
    await writeDecisionLine(db, d, d.status, Number.isNaN(at) ? now : new Date(at));
  }
}

/**
 * Append the decision line to the session that created the draft, unless that session was cleared
 * since. Returns true when a line was written: false when the draft has no origin or its session was
 * cleared. Throws on a database error.
 */
export async function writeDecisionLine(db: D1Database, draft: DecidedDraft, decision: DraftDecisionKind, at: Date): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO chat_messages (session_key, role, content, turn_id, created_at)
       SELECT o.session_key, 'user', ?2, NULL, ?3 FROM chat_draft_origins o JOIN chat_sessions s ON s.session_key = o.session_key
        WHERE o.draft_id = ?1 AND s.cleared_at IS o.session_cleared_at`,
    )
    .bind(draft.id, systemMessageContent(decisionLine(decision, draft, at)), at.toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** The approval path's call: bookkeeping, so it never throws and never changes the decision. */
export async function noteDraftDecision(
  deps: { db: D1Database; flags?: FlagReader; logger?: { warn(msg: string, data?: Record<string, unknown>): void } },
  draft: DecidedDraft,
  decision: DraftDecisionKind,
  at: Date,
): Promise<void> {
  try {
    if (!(await isDecisionLinesEnabled(deps.flags))) return;
    await writeDecisionLine(deps.db, draft, decision, at);
  } catch (error) {
    const data = { draftId: draft.id, error: sanitizeErrorMessage(error) };
    const msg = "the decision line could not be written to the chat session";
    if (deps.logger) deps.logger.warn(msg, data);
    else console.warn(JSON.stringify({ level: "warn", scope: "decisions", msg, ...data }));
  }
}
