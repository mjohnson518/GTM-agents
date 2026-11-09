// GTM-agents: brain edits from the self-improvement loops: rendering a component file, the mutation
// constraints a proposed file meets, and applying an approved one, which re-locks the brain.
//
// A brain edit is applied only from an approved proposal (or, for the components loops may edit on
// their own, at brain_edit level 2 or above). Applying it:
//   1. reads the served brain from KV: the lock, and every file whose bytes still match their lock
//      entry (a file that drifted from its lock is not served today and is left out of the new
//      lock, so applying never starts serving bytes nobody approved);
//   2. refuses when the component's current bytes are not the ones the proposal was made against;
//   3. validates the whole brain with the new file (validateBrain: schema, references, no URLs
//      outside url fields, no prices outside commercial);
//   4. computes the new lock over the approved files (computeLock) and writes the file first and
//      the lock last, as `gtm brain upload` does, so a half-finished write is never served.
// `commercial` is never edited here: prices and offers belong to a person.
import { brainFileKey, BRAIN_LOCK_KEY } from "../brain/load.ts";
import { brainVersion, computeLock, parseLock, serializeLock, sha256Hex, type BrainLock } from "../brain/lock.ts";
import { parseBrainFile } from "../brain/parse.ts";
import { validateBrain } from "../brain/validate.ts";
import { isComponentId, type ComponentId } from "../brain/components.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import { figuresIn } from "../autonomy/scorers.ts";
import type { KvStore } from "../shared/kv.ts";
import { detectInjection } from "../security/redact.ts";
import { hasLink } from "./text.ts";

/** Components a loop may never propose an edit to. */
export const NEVER_PROPOSED_COMPONENTS: readonly ComponentId[] = Object.freeze(["commercial"]);
/** Components a loop may edit on its own at brain_edit level 2 or above. Everything else waits for a person. */
export const SELF_EDITABLE_COMPONENTS: readonly ComponentId[] = Object.freeze(["message-pillars", "voice"]);
/** The most items one loop edit may add, remove or change. */
export const MAX_CHANGED_ITEMS = 3;

export type BrainKv = Pick<KvStore, "get" | "put">;

export interface BrainItemInput {
  id: string;
  fields: Record<string, string>;
}

const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_KEY = /^[a-z][a-z_]{0,31}$/;
const TITLES: Partial<Record<ComponentId, string>> = { "message-pillars": "Message pillars", voice: "Voice", "market-profile": "Market profile", icp: "ICP", "keyword-portfolio": "Keyword portfolio" };

/** A component file in the brain's format. Field values are single lines. */
export function renderBrainFile(args: { component: ComponentId; version: number; updated: string; owner?: string | null; items: readonly BrainItemInput[] }): string {
  const title = TITLES[args.component] ?? args.component.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const lines = ["---", `component: ${args.component}`, "status: approved", `version: ${args.version}`, `updated: ${args.updated}`];
  if (args.owner) lines.push(`owner: ${args.owner.replace(/\s+/g, " ").trim()}`);
  lines.push("---", "", `# ${title}`);
  for (const item of args.items) {
    lines.push("", `## ${item.id}`);
    for (const [key, value] of Object.entries(item.fields)) lines.push(`- ${key}: ${value.replace(/\s+/g, " ").trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The items of a component file as plain fields. */
export function itemsOf(content: string, component: ComponentId): BrainItemInput[] {
  const parsed = parseBrainFile(`${component}.md`, content);
  return parsed.items.map((item) => ({ id: item.id, fields: Object.fromEntries(Object.entries(item.raw).map(([k, v]) => [k, v.value])) }));
}

/** A file's frontmatter version and owner, or defaults when it has none. */
export function fileMeta(content: string | null, component: ComponentId): { version: number; owner: string | null } {
  if (!content) return { version: 0, owner: null };
  const parsed = parseBrainFile(`${component}.md`, content);
  const fm = parsed.frontmatter as { version?: number; owner?: string } | undefined;
  return { version: typeof fm?.version === "number" ? fm.version : 0, owner: typeof fm?.owner === "string" ? fm.owner : null };
}

export interface ServedBrain {
  lock: BrainLock | null;
  /** File name to bytes, only for files whose bytes match their lock entry. */
  files: Map<string, string>;
}

/** The brain as served: the lock and every file that still matches it. Throws on a KV read error. */
export async function readServedBrain(kv: Pick<KvStore, "get">): Promise<ServedBrain> {
  const lock = parseLock(await kv.get(BRAIN_LOCK_KEY));
  const files = new Map<string, string>();
  if (!lock) return { lock, files };
  for (const [name, expected] of Object.entries(lock.files)) {
    const component = name.replace(/\.md$/, "");
    if (!isComponentId(component)) continue;
    const content = await kv.get(brainFileKey(component));
    if (content !== null && (await sha256Hex(content)) === expected) files.set(name, content);
  }
  return { lock, files };
}

/**
 * What is wrong with a loop's edit of a component, compared with the current file: a component no
 * loop may touch, malformed ids or fields, more than MAX_CHANGED_ITEMS items changed, a link, an em
 * or en dash, or a figure the current brain does not hold. Empty means it may be proposed.
 */
export function editProblems(args: { component: ComponentId; before: readonly BrainItemInput[]; after: readonly BrainItemInput[]; knownText: string }): string[] {
  const problems: string[] = [];
  if (NEVER_PROPOSED_COMPONENTS.includes(args.component)) problems.push(`${args.component} is never edited by a loop`);
  if (args.after.length === 0) problems.push("the edit leaves the component empty");
  const ids = new Set<string>();
  for (const item of args.after) {
    if (!ITEM_ID.test(item.id)) problems.push(`item id "${item.id.slice(0, 40)}" is malformed`);
    if (ids.has(item.id)) problems.push(`item id "${item.id}" appears twice`);
    ids.add(item.id);
    for (const [key, value] of Object.entries(item.fields)) {
      if (!FIELD_KEY.test(key)) problems.push(`field "${key.slice(0, 40)}" is malformed`);
      if (typeof value !== "string" || value.trim() === "" || value.length > 400) problems.push(`field ${item.id}.${key} must be 1 to 400 characters`);
      else {
        if (hasLink(value)) problems.push(`field ${item.id}.${key} holds a link`);
        if (/[\u2013\u2014]/.test(value)) problems.push(`field ${item.id}.${key} holds an em or en dash`);
        if (detectInjection(value) > 0) problems.push(`field ${item.id}.${key} reads like an instruction to the model`);
      }
    }
  }
  const key = (i: BrainItemInput) => JSON.stringify(Object.entries(i.fields).sort(([a], [b]) => (a < b ? -1 : 1)));
  const before = new Map(args.before.map((i) => [i.id, key(i)]));
  const after = new Map(args.after.map((i) => [i.id, key(i)]));
  let changed = 0;
  for (const [id, k] of after) if (before.get(id) !== k) changed++;
  for (const id of before.keys()) if (!after.has(id)) changed++;
  if (changed === 0) problems.push("the edit changes nothing");
  if (changed > MAX_CHANGED_ITEMS) problems.push(`the edit changes ${changed} items; at most ${MAX_CHANGED_ITEMS}`);
  const known = new Set(figuresIn(args.knownText));
  const invented = [...new Set(args.after.flatMap((i) => Object.values(i.fields).flatMap((v) => figuresIn(v))))].filter((f) => !known.has(f));
  if (invented.length > 0) problems.push(`it states figures the brain does not hold: ${invented.slice(0, 5).join(", ")}`);
  return [...new Set(problems)];
}

export type BrainEditResult = { ok: true; version: string; previousContent: string | null } | { ok: false; stale: boolean; reason: string };

export interface BrainEditDeps {
  db: D1Database;
  kv: BrainKv | undefined;
  now: Date;
}

/** Apply one component file and re-lock the brain, only if the component still holds `baseSha256`. */
export async function applyBrainEdit(deps: BrainEditDeps, edit: { component: ComponentId; baseSha256: string | null; content: string }): Promise<BrainEditResult> {
  if (!deps.kv) return { ok: false, stale: false, reason: "the brain's KV namespace is not bound" };
  if (NEVER_PROPOSED_COMPONENTS.includes(edit.component)) return { ok: false, stale: false, reason: `${edit.component} is never edited by a loop` };
  let served: ServedBrain;
  try {
    served = await readServedBrain(deps.kv);
  } catch {
    return { ok: false, stale: false, reason: "the brain could not be read" };
  }
  const name = `${edit.component}.md`;
  const current = served.files.get(name) ?? null;
  const currentSha = current === null ? null : await sha256Hex(current);
  if (currentSha !== edit.baseSha256) return { ok: false, stale: true, reason: `${edit.component} changed since this was proposed` };
  // Serialize brain writes made against the same lock, for an hour at most.
  const hour = deps.now.toISOString().slice(0, 13);
  const claimKey = `brain_relock:${served.lock?.hash ?? "unlocked"}:${hour}`;
  try {
    if (!(await claimEffect(deps.db, claimKey, "learning_brain_relock"))) return { ok: false, stale: true, reason: "another brain change was applied against this version; review again" };
  } catch {
    return { ok: false, stale: false, reason: "the brain change could not be claimed" };
  }
  try {
    const files = [...served.files.entries()].filter(([n]) => n !== name).map(([n, content]) => ({ name: n, content }));
    files.push({ name, content: edit.content });
    const validation = await validateBrain(files);
    const errors = validation.issues.filter((i) => i.severity === "error");
    if (errors.length > 0 || !validation.ok) {
      await releaseEffect(deps.db, claimKey, "learning_brain_relock");
      return { ok: false, stale: false, reason: `the brain would not validate: ${errors.slice(0, 3).map((e) => e.message).join("; ") || "invalid"}` };
    }
    if (!validation.approved.some((f) => f.name === name)) {
      await releaseEffect(deps.db, claimKey, "learning_brain_relock");
      return { ok: false, stale: false, reason: `${edit.component} is not marked approved` };
    }
    const lock = await computeLock(validation.approved);
    await deps.kv.put(brainFileKey(edit.component), edit.content);
    await deps.kv.put(BRAIN_LOCK_KEY, serializeLock(lock));
    return { ok: true, version: brainVersion(lock), previousContent: current };
  } catch {
    await releaseEffect(deps.db, claimKey, "learning_brain_relock");
    return { ok: false, stale: false, reason: "the brain could not be written" };
  }
}
