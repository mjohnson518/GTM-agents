// GTM-agents: operator notes: note_save's checks and the store's cap, what a turn is shown of the
// saved notes (clean ones under a byte budget, the rest by id), notes_read's input checks, /notes,
// which turns are offered the note tools, and a turn that goes on when the notes cannot be read.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runHubTurn, type HubAgentDeps } from "../src/agents/hub.ts";
import { NOTES_LISTED_MAX, NOTES_MAX, NOTES_PER_TURN, NOTES_PROMPT_MAX_BYTES, NOTES_TAINTED_MAX, forgetAllNotes, insertNote, listNotes, newNoteId, notesPrefix, type Note } from "../src/agents/notes.ts";
import { isNotesEnabled } from "../src/operator/access.ts";
import { sessionKeyFor } from "../src/agents/sessions.ts";
import { memoryKv, scriptedModel } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { findFlag } from "../src/flags/registry.ts";
import { runCommand } from "../src/operator/commands.ts";
import type { TaintLevel } from "../src/security/taint.ts";
import { createNoteSaveHandler, createNotesReadHandler } from "../src/tools/notes.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig({ ...acmeConfig, models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } } });
const saver = () => createNoteSaveHandler({ db: env.DB, sessionKey: "chat:1", turnId: "turn_test" });
const save = (input: Record<string, unknown>, ctx: { taint: TaintLevel }) => saver()(input, ctx);
const read = createNotesReadHandler({ db: env.DB });
const textOf = (r: Awaited<ReturnType<typeof read>>) => (typeof r === "string" ? r : r.text);

async function seed(text: string, taint: TaintLevel = "none", at = new Date()): Promise<string> {
  const id = newNoteId();
  expect(await insertNote(env.DB, { id, text, taint, savedBy: "chat:1", turnId: null }, at)).toBe("saved");
  return id;
}

const note = (over: Partial<Note>): Note => ({ id: newNoteId(), text: "A note.", taint: "none", savedBy: "chat:1", turnId: null, createdAt: "2026-11-14T12:00:00.000Z", ...over });

beforeEach(async () => {
  await forgetAllNotes(env.DB);
});

describe("note_save", () => {
  it("is behind operator:notes_enabled, registered and off by default, and off when the flag cannot be read", async () => {
    expect(findFlag("operator:notes_enabled")).toMatchObject({ kind: "boolean", default: "false" });
    expect(await isNotesEnabled({ get: () => Promise.reject(new Error("kv unavailable")) })).toBe(false);
  });

  it(`saves at most ${NOTES_PER_TURN} notes a turn, and keeps tainted notes to ${NOTES_TAINTED_MAX}`, async () => {
    const turn = saver();
    for (let i = 0; i < NOTES_PER_TURN; i += 1) await turn({ text: `fact ${i}` }, { taint: "none" });
    await expect(turn({ text: "one more" }, { taint: "none" })).rejects.toThrow(/at most 3 notes/);
    for (let i = 0; i < NOTES_TAINTED_MAX; i += 1) await seed(`record fact ${i}`, "metadata");
    await expect(save({ text: "another record fact" }, { taint: "metadata" })).rejects.toThrow(/10 notes saved after reading third-party text/);
    // Clean notes still have room.
    await expect(save({ text: "a clean fact" }, { taint: "none" })).resolves.toContain("saved");
  });

  it("saves the cleaned text with the taint the call ran at", async () => {
    const text = await save({ text: `  Prefers calls${String.fromCharCode(0x200b)} on Tuesdays.${String.fromCharCode(7)}  ` }, { taint: "structured" });
    expect(text).toContain("keeps its taint (structured)");
    expect(await listNotes(env.DB)).toMatchObject([{ text: "Prefers calls on Tuesdays.", taint: "structured", savedBy: "chat:1", turnId: "turn_test" }]);
  });

  it("refuses an empty or overlong note, and a full store", async () => {
    await expect(save({ text: "  " }, { taint: "none" })).rejects.toThrow(/1 to 500/);
    await expect(save({ text: "x".repeat(501) }, { taint: "none" })).rejects.toThrow(/1 to 500/);
    await expect(save({}, { taint: "none" })).rejects.toThrow(/text is required/);
    for (let i = 0; i < NOTES_MAX; i += 1) await seed(`note ${i}`);
    await expect(save({ text: "one more" }, { taint: "none" })).rejects.toThrow(/50 notes are saved already/);
  });
});

describe("what a turn is shown", () => {
  it("shows clean notes as trusted text and lists the rest by id, date and taint only", () => {
    const clean = note({ id: "note_clean", text: "Line one\nline two." });
    const tainted = note({ id: "note_taint", text: "Sam is the champion.", taint: "metadata" });
    const prefix = notesPrefix([clean, tainted]) ?? "";
    expect(prefix).toContain("- note_clean (2026-11-14, operator chat): Line one line two.");
    expect(notesPrefix([note({ id: "note_dash", savedBy: "chat:dashboard:ops@acme.example" })])).toContain("(2026-11-14, dashboard)");
    expect(prefix).not.toContain('trust="untrusted"');
    expect(prefix).toContain("not shown: note_taint (2026-11-14, metadata taint)");
    expect(prefix).not.toContain("champion");
    expect(notesPrefix([])).toBeNull();
  });

  it("keeps the shown text within its byte budget and caps the list of the rest", () => {
    const big = Array.from({ length: 60 }, (_, i) => note({ id: `note_${String(i).padStart(3, "0")}`, text: "x".repeat(400) }));
    const prefix = notesPrefix(big) ?? "";
    const shownLines = prefix.split("\n").filter((l) => l.startsWith("- note_"));
    expect(shownLines.join("\n").length).toBeLessThanOrEqual(NOTES_PROMPT_MAX_BYTES);
    expect(prefix).toContain("did not fit");
    expect(prefix).toContain(`and ${60 - shownLines.length - NOTES_LISTED_MAX} more`);
  });
});

describe("notes_read", () => {
  it("returns the notes asked for, says which ids match nothing, and reports the highest taint", async () => {
    const a = await seed("Clean fact.");
    const b = await seed("Record fact.", "metadata");
    const result = await read({ ids: [a, b, "note_missing", a] }, { taint: "none" });
    expect(typeof result === "string" ? "none" : result.taint).toBe("metadata");
    expect(textOf(result)).toContain("Clean fact.");
    expect(textOf(result)).toContain("Record fact.");
    expect(textOf(result)).toContain("note_missing: no note by that id");
    expect(textOf(result).match(/Clean fact\./g)).toHaveLength(1);
  });

  it("refuses an empty, oversized or malformed list", async () => {
    await expect(read({ ids: [] }, { taint: "none" })).rejects.toThrow(/1 to 5 note ids/);
    await expect(read({ ids: ["a", "b", "c", "d", "e", "f"] }, { taint: "none" })).rejects.toThrow(/1 to 5 note ids/);
    await expect(read({ ids: [7] }, { taint: "none" })).rejects.toThrow(/1 to 5 note ids/);
  });
});

describe("/notes", () => {
  const command = (args: string, flags: Record<string, string> = { "operator:notes_enabled": "true" }) => {
    const kv = memoryKv(flags);
    return runCommand({ db: env.DB, agentName: "Avery", strategistModel: undefined, flags: { get: (k) => kv.get(k) } }, { name: "notes", args }, { sessionKey: "chat:1", chatId: "1" });
  };

  it("lists the notes newest first with the taint each keeps, and says when notes are off", async () => {
    const older = await seed("Older fact.", "none", new Date("2026-11-01T09:00:00.000Z"));
    const newer = await seed("Newer fact.", "metadata", new Date("2026-11-10T09:00:00.000Z"));
    const text = await command("");
    expect(text).toContain("Saved notes, newest first (2 of 50):");
    expect(text.indexOf(newer)).toBeLessThan(text.indexOf(older));
    expect(text).toContain(`${newer}  2026-11-10 09:00 UTC, operator chat, saved after reading third-party text (metadata): Newer fact.`);
    expect(await command("", {})).toContain("Notes are off for this deployment");
  });

  it("forgets one note or all of them", async () => {
    const a = await seed("First.");
    await seed("Second.");
    expect(await command(`forget ${a}`)).toBe(`Forgot note ${a}.`);
    expect(await command(`forget ${a}`)).toContain(`No note ${a}`);
    expect(await command("forget all")).toBe("Forgot 1 note.");
    expect(await command("")).toBe("No notes are saved.");
    expect(await command("delete")).toContain("/notes forget <id>");
  });
});

describe("which turns get notes", () => {
  const deps = (model: HubAgentDeps["model"], extra: Partial<HubAgentDeps> = {}): HubAgentDeps => {
    const kv = memoryKv();
    return { db: env.DB, kv, flags: { get: (k) => kv.get(k) }, config, model, brain: () => Promise.resolve(null), ...extra };
  };

  it("offers the note tools and their rules, and loads the notes, only when the caller passes notes", async () => {
    await seed("The operator prefers drafts under 80 words.");
    const without = scriptedModel([{ text: "ok" }]);
    await runHubTurn(deps(without), { sessionKey: sessionKeyFor("n1"), chatId: "n1", text: "hello" });
    expect(without.requests[0]?.tools?.map((t) => t.name)).toEqual(["web_fetch", "contacts_search", "drafts_create"]);
    expect(JSON.stringify(without.requests[0]?.messages)).not.toContain("80 words");

    const withNotes = scriptedModel([{ text: "ok" }]);
    await runHubTurn(deps(withNotes, { notes: true }), { sessionKey: sessionKeyFor("n2"), chatId: "n2", text: "hello" });
    expect(withNotes.requests[0]?.tools?.map((t) => t.name)).toEqual(["web_fetch", "contacts_search", "drafts_create", "note_save", "notes_read"]);
    expect(withNotes.requests[0]?.system).toContain("note_save keeps a short note");
    expect(JSON.stringify(withNotes.requests[0]?.messages.at(-1))).toContain("80 words");
  });

  it("runs the turn without the notes when they cannot be read", async () => {
    await seed("Never shown in this turn.");
    const failing = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM operator_notes")) throw new Error("notes unavailable");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const model = scriptedModel([{ text: "ok" }]);
    const result = await runHubTurn(deps(model, { db: failing, notes: true }), { sessionKey: sessionKeyFor("n3"), chatId: "n3", text: "hello" });
    expect(result.stop).toBe("end");
    const shown = JSON.stringify(model.requests[0]?.messages.at(-1));
    expect(shown).not.toContain("Never shown");
    expect(shown).toContain("the saved notes could not be read this turn");
  });
});
