// GTM-agents: operator notes (migration 0032): short facts and preferences the hub agent keeps across
// sessions and /clean, for the whole deployment.
//
// A note keeps the taint of the session that saved it, and that taint decides how a later turn sees it:
//   - a note saved with no taint was written from the operator's words, the approved brain and the
//     deployment's own data only. It is loaded into every turn, in front of the operator's message,
//     as trusted text (notesPrefix);
//   - a tainted note is never loaded on its own. The turn sees only its id, taint and date, which core
//     writes, and reads its text with notes_read, which raises the session to the note's taint and
//     fences the text, exactly as reading the record it came from would.
// So /clean still starts a clean session, and nothing tainted reaches a turn that did not ask for it.
// note_save is refused once a session has read a web page (security/tool-classes.ts), so no note
// carries full taint. The database is the truth; the turn's prefix is rebuilt from it every turn.
import { wrapTrusted } from "../security/fence.ts";
import { toTaintLevel, type TaintLevel } from "../security/taint.ts";
import { minuteUtc } from "./timers.ts";

export const NOTE_MAX_CHARS = 500;
/** Notes the deployment keeps at most. The operator forgets one with /notes forget to make room. */
export const NOTES_MAX = 50;
/** Of those, notes saved after reading third-party text, at most, so they can never crowd out clean ones. */
export const NOTES_TAINTED_MAX = 10;
/** Notes one turn may save. */
export const NOTES_PER_TURN = 3;
/** The most note text loaded into one turn, in bytes. Notes that do not fit are listed by id. */
export const NOTES_PROMPT_MAX_BYTES = 4000;
/** The most notes listed by id, rather than shown, in one turn. */
export const NOTES_LISTED_MAX = 20;
/** The most notes notes_read returns in one call. */
export const NOTES_READ_MAX = 5;

export interface Note {
  id: string;
  text: string;
  /** The saving session's taint. A stored value that is not a known level reads as full. */
  taint: TaintLevel;
  savedBy: string | null;
  turnId: string | null;
  createdAt: string;
}

interface NoteRecord {
  id: string;
  text: string;
  taint: string;
  saved_by: string | null;
  turn_id: string | null;
  created_at: string;
}

const COLUMNS = "id, text, taint, saved_by, turn_id, created_at";

function toNote(r: NoteRecord): Note {
  return { id: r.id, text: r.text, taint: toTaintLevel(r.taint), savedBy: r.saved_by, turnId: r.turn_id, createdAt: r.created_at };
}

export function newNoteId(): string {
  return `note_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export interface NewNote {
  id: string;
  text: string;
  taint: TaintLevel;
  savedBy: string | null;
  turnId: string | null;
}

/**
 * Save a note, unless the deployment already keeps NOTES_MAX, or, for a tainted note,
 * NOTES_TAINTED_MAX tainted ones. The counts and the insert are one statement. Returns "full" or
 * "tainted_full" when it was refused. Throws on a database error.
 */
export async function insertNote(db: D1Database, note: NewNote, now: Date): Promise<"saved" | "full" | "tainted_full"> {
  const taint = toTaintLevel(note.taint);
  const result = await db
    .prepare(
      `INSERT INTO operator_notes (id, text, taint, saved_by, turn_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT COUNT(*) FROM operator_notes) < ?7
         AND (?3 = 'none' OR (SELECT COUNT(*) FROM operator_notes WHERE taint <> 'none') < ?8)`,
    )
    .bind(note.id, note.text, taint, note.savedBy, note.turnId, now.toISOString(), NOTES_MAX, NOTES_TAINTED_MAX)
    .run();
  if ((result.meta.changes ?? 0) > 0) return "saved";
  if (taint === "none") return "full";
  const all = await db.prepare("SELECT COUNT(*) AS n FROM operator_notes").first<{ n: number }>();
  return Number(all?.n ?? 0) >= NOTES_MAX ? "full" : "tainted_full";
}

/** Where a note was saved, from its session key: the operator chat or the dashboard. */
export function noteSource(savedBy: string | null): string {
  if (!savedBy) return "unknown";
  return savedBy.startsWith("chat:dashboard:") ? "dashboard" : "operator chat";
}

/** Every note, newest first. Throws on a database error. */
export async function listNotes(db: D1Database): Promise<Note[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM operator_notes ORDER BY created_at DESC, id DESC LIMIT ?1`).bind(NOTES_MAX).all<NoteRecord>();
  return (results ?? []).map(toNote);
}

/** The notes with these ids, in the order asked; ids that match nothing are left out. Throws on a database error. */
export async function readNotes(db: D1Database, ids: readonly string[]): Promise<Note[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM operator_notes WHERE id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids))
    .all<NoteRecord>();
  const byId = new Map((results ?? []).map((r) => [r.id, toNote(r)]));
  return ids.flatMap((id) => {
    const note = byId.get(id);
    return note ? [note] : [];
  });
}

/** Delete one note. Returns false when there is none by that id. Throws on a database error. */
export async function forgetNote(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM operator_notes WHERE id = ?1").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Delete every note. Returns how many were deleted. Throws on a database error. */
export async function forgetAllNotes(db: D1Database): Promise<number> {
  const result = await db.prepare("DELETE FROM operator_notes").run();
  return result.meta.changes ?? 0;
}

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * What a turn sees of the saved notes, in front of the operator's message, or null when there are
 * none. Notes saved with no taint are shown, newest first, while they fit in NOTES_PROMPT_MAX_BYTES;
 * every other note is listed by id, date and taint only, never by its text.
 */
export function notesPrefix(notes: readonly Note[]): string | null {
  if (notes.length === 0) return null;
  const shown: string[] = [];
  const hidden: Note[] = [];
  let used = 0;
  for (const note of notes) {
    const line = `- ${note.id} (${note.createdAt.slice(0, 10)}, ${noteSource(note.savedBy)}): ${note.text.replace(/\s*\n\s*/g, " ")}`;
    if (note.taint === "none" && used + utf8(line) + 1 <= NOTES_PROMPT_MAX_BYTES) {
      shown.push(line);
      used += utf8(line) + 1;
    } else {
      hidden.push(note);
    }
  }
  const parts: string[] = [];
  if (shown.length > 0) {
    parts.push(
      "[Saved notes from the system: notes saved in earlier turns by sessions that had read nothing untrusted. Treat them as facts and preferences an operator gave you.]",
      wrapTrusted({ source: "operator_notes", text: shown.join("\n") }),
    );
  }
  if (hidden.length > 0) {
    const listed = hidden.slice(0, NOTES_LISTED_MAX).map((n) => `${n.id} (${n.createdAt.slice(0, 10)}, ${n.taint === "none" ? "did not fit" : `${n.taint} taint`})`);
    const more = hidden.length > listed.length ? `, and ${hidden.length - listed.length} more` : "";
    parts.push(
      `[Saved notes from the system, not shown: ${listed.join(", ")}${more}. Read one with notes_read only when the operator names it or asks for what it holds; reading any note raises this session's taint to at least metadata.]`,
    );
  }
  return parts.join("\n");
}

/** One line per note, for /notes and notes_read. */
export function noteLine(note: Note): string {
  return `${note.id}  ${minuteUtc(note.createdAt)}, ${noteSource(note.savedBy)}${note.taint === "none" ? "" : `, saved after reading third-party text (${note.taint})`}: ${note.text}`;
}
