// GTM-agents: the note_save and notes_read tools: notes the hub agent keeps across sessions and /clean.
//
// note_save is taint none, gate full (security/tool-classes.ts): a session that has read raw untrusted
// text (a web page) cannot save a note. A session that has read only third-party records or extracted
// values may, and the note keeps that taint (agents/notes.ts): it is never loaded into a turn on its
// own, only read on purpose. notes_read is taint metadata, gate never, like the other reads of records
// a tainted session may write, and reports the highest taint of the notes it returns, so the
// dispatcher raises the session at least to metadata, higher for a note saved at structured, and
// fences the text. A turn saves at most NOTES_PER_TURN notes, and tainted notes have their own cap.
// Skip rather than guess: a note that is empty or too long is refused, never cut, and a full store is
// refused rather than having an old note replaced.
import type { ToolHandler } from "../runtime/dispatcher.ts";
import { NOTES_MAX, NOTES_PER_TURN, NOTES_READ_MAX, NOTES_TAINTED_MAX, NOTE_MAX_CHARS, insertNote, newNoteId, noteLine, readNotes } from "../agents/notes.ts";
import { maxTaintLevel, type TaintLevel } from "../security/taint.ts";

export const noteSaveDefinition = {
  name: "note_save",
  description:
    `Save a short note that later turns and sessions see, after /clean too: a lasting fact or a preference, at most ${NOTE_MAX_CHARS} characters. ` +
    "Save one when the operator asks you to remember something or states a lasting preference. Never save secrets. Refused once the session has read a web page.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: `The note, at most ${NOTE_MAX_CHARS} characters, written so it makes sense on its own later.` } },
    required: ["text"],
    additionalProperties: false,
  },
} as const;

export const notesReadDefinition = {
  name: "notes_read",
  description:
    `Read saved notes by id, at most ${NOTES_READ_MAX} at a time: the ones listed as not shown at the start of the operator's message. ` +
    "Reading a note raises this session's taint to at least metadata, so read one only when the operator names it or asks for what it holds.",
  inputSchema: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: NOTES_READ_MAX, description: "Note ids, such as note_0123456789abcdef." } },
    required: ["ids"],
    additionalProperties: false,
  },
} as const;

export interface NoteToolDeps {
  db: D1Database;
  /** The session that saves, and the turn, recorded with each note for tracing. */
  sessionKey: string;
  turnId: string;
  newId?: () => string;
  now?: () => Date;
}

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function cleanNote(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(INVISIBLE, "").trim();
}

export function createNoteSaveHandler(deps: NoteToolDeps): ToolHandler {
  let saves = 0;
  return async (input, ctx) => {
    if (saves >= NOTES_PER_TURN) throw new Error(`a turn saves at most ${NOTES_PER_TURN} notes`);
    const raw = input.text;
    if (typeof raw !== "string") throw new Error("text is required");
    const text = cleanNote(raw);
    if (text.length === 0 || text.length > NOTE_MAX_CHARS) throw new Error(`text must be 1 to ${NOTE_MAX_CHARS} characters`);
    const id = (deps.newId ?? newNoteId)();
    // ctx.taint is the session's taint as this call started, including anything read earlier in the
    // same turn: the taint the note keeps.
    const saved = await insertNote(deps.db, { id, text, taint: ctx.taint, savedBy: deps.sessionKey, turnId: deps.turnId }, deps.now?.() ?? new Date());
    if (saved === "full") throw new Error(`${NOTES_MAX} notes are saved already; the operator can list them with /notes and forget one with /notes forget <id>`);
    if (saved === "tainted_full") throw new Error(`${NOTES_TAINTED_MAX} notes saved after reading third-party text are kept already; the operator can forget one with /notes forget <id>`);
    saves += 1;
    return ctx.taint === "none"
      ? `Note ${id} saved. Later turns see it at the start of the operator's message while it fits the notes shown each turn; /notes lists every note.`
      : `Note ${id} saved. This session had read third-party text, so the note keeps its taint (${ctx.taint}): later turns see only its id, and read it with notes_read.`;
  };
}

export function createNotesReadHandler(deps: Pick<NoteToolDeps, "db">): ToolHandler {
  return async (input) => {
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > NOTES_READ_MAX || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) {
      throw new Error(`ids must be 1 to ${NOTES_READ_MAX} note ids`);
    }
    const wanted = [...new Set(ids as string[])];
    const notes = await readNotes(deps.db, wanted);
    const found = new Set(notes.map((n) => n.id));
    const missing = wanted.filter((id) => !found.has(id));
    const taint: TaintLevel = maxTaintLevel("none", ...notes.map((n) => n.taint));
    const lines = [...notes.map(noteLine), ...missing.map((id) => `${id}: no note by that id`)];
    return { text: lines.join("\n"), taint };
  };
}
