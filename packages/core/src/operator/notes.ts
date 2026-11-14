// GTM-agents: /notes, the operator's view of the notes the hub agent saved (agents/notes.ts): list
// them with the taint each keeps, and forget one or all. It works in the operator chat and the
// dashboard alike, because notes belong to the deployment, and whatever operator:notes_enabled says,
// so the operator can always see and delete what is kept. Forgetting deletes the row.
import { NOTES_MAX, forgetAllNotes, forgetNote, listNotes, noteLine } from "../agents/notes.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { isNotesEnabled } from "./access.ts";

export const NOTES_HELP_LINE = "/notes  the notes the agent saved; /notes forget <id> or /notes forget all";

/** /notes, /notes forget <id> and /notes forget all. Throws on a database error; the caller reports it. */
export async function runNotesCommand(deps: { db: D1Database; flags?: FlagReader }, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const notes = await listNotes(deps.db);
    const on = deps.flags ? await isNotesEnabled(deps.flags) : true;
    const state = on ? [] : ["Notes are off for this deployment (operator:notes_enabled), so the agent neither reads nor saves them."];
    if (notes.length === 0) return [...state, "No notes are saved."].join("\n");
    return [...state, `Saved notes, newest first (${notes.length} of ${NOTES_MAX}):`, ...notes.map(noteLine), "Forget one with /notes forget <id>, or all with /notes forget all."].join("\n");
  }
  if (words[0]?.toLowerCase() === "forget" && words.length === 2) {
    const target = words[1] ?? "";
    if (target.toLowerCase() === "all") {
      const n = await forgetAllNotes(deps.db);
      return n === 0 ? "No notes were saved." : `Forgot ${n} note${n === 1 ? "" : "s"}.`;
    }
    return (await forgetNote(deps.db, target)) ? `Forgot note ${target}.` : `No note ${target.slice(0, 40)}. Send /notes for the list.`;
  }
  return "Send /notes for the saved notes, /notes forget <id> to forget one, or /notes forget all.";
}
