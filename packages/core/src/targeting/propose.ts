// GTM-agents: what the Product and ICP page shows as served, checks, and proposes (docs/TARGETING.md).
//
// The page never writes the brain. It renders the operator's items as one component file
// (renderBrainFile: the served version plus one, today's date, the served owner), validates the whole
// brain with that file in place of the served one, and stores an ordinary brain proposal made by the
// operator (proposedBy operator:<email>), against the SHA-256 of the file served now. Approving it is
// the same proposals.approve every brain proposal goes through: the digest the person was shown, a
// compare-and-set, a component that changed since it was proposed refused as stale, and applyBrainEdit,
// which validates again and re-locks. A proposal made by the operator is not autonomy evidence and
// never applies on its own. Two more guards: a component listed in the lock whose served bytes do not
// match it cannot be proposed over (what it holds is unknown), and an ICP proposal that leaves out a
// hard stop the brain serves now is refused unless the operator confirmed removing that one.
//
// Suggested search queries and personas take another route, proposeAdditions: the server builds the
// file from every served item, unchanged and in order, followed by the picked items, so a proposal
// from the page can add to keyword-portfolio or personas but never drop or change what is served.
import { budgetFor, taskComponents, tasksReading, type BrainTask, type ComponentId } from "../brain/components.ts";
import { componentCost, renderComponent, sliceOverhead } from "../brain/assemble.ts";
import { brainVersion, sha256Hex } from "../brain/lock.ts";
import { parseBrainFile } from "../brain/parse.ts";
import { validateBrain } from "../brain/validate.ts";
import { fileMeta, itemsOf, readServedBrain, renderBrainFile, type BrainItemInput, type BrainKv } from "../learning/brain-edit.ts";
import { createLearningProposal, type LearningProposal } from "../learning/proposals.ts";
import type { TargetingComponent } from "./draft.ts";
import { phraseKey, type SuggestComponent } from "./suggest.ts";

/** The components the Product and ICP page proposes: its own two, and the two suggestions add to. */
export type EditableComponent = TargetingComponent | SuggestComponent;

/** The most items one proposal may add. */
export const ADDITIONS_MAX = 12;

export interface ServedComponent {
  /** The served file, or null when the component is not served. */
  content: string | null;
  sha256: string | null;
  version: number;
  updated: string | null;
  owner: string | null;
  items: BrainItemInput[];
}

export interface ServedTargeting {
  brainVersion: string;
  product: ServedComponent;
  icp: ServedComponent;
  personas: ServedComponent;
  "keyword-portfolio": ServedComponent;
}

async function served(content: string | null, component: EditableComponent): Promise<ServedComponent> {
  if (content === null) return { content: null, sha256: null, version: 0, updated: null, owner: null, items: [] };
  const meta = fileMeta(content, component);
  const fm = parseBrainFile(`${component}.md`, content).frontmatter as { updated?: string } | undefined;
  return { content, sha256: await sha256Hex(content), version: meta.version, updated: typeof fm?.updated === "string" ? fm.updated : null, owner: meta.owner, items: itemsOf(content, component) };
}

/** What is served now for `product`, `icp`, `personas` and `keyword-portfolio`. Throws when the brain cannot be read. */
export async function servedTargeting(kv: BrainKv): Promise<ServedTargeting> {
  const brain = await readServedBrain(kv);
  return {
    brainVersion: brainVersion(brain.lock),
    product: await served(brain.files.get("product.md") ?? null, "product"),
    icp: await served(brain.files.get("icp.md") ?? null, "icp"),
    personas: await served(brain.files.get("personas.md") ?? null, "personas"),
    "keyword-portfolio": await served(brain.files.get("keyword-portfolio.md") ?? null, "keyword-portfolio"),
  };
}

export interface CheckedFile {
  component: EditableComponent;
  /** Ids of served ICP hard stops (never items) the new file leaves out. */
  removedHardStops: string[];
  content: string;
  sha256: string;
  /** What the proposal is made against: the served file now, or null when there is none. */
  baseSha256: string | null;
  previousContent: string | null;
  /** The component's bytes in each task that reads it, against the room left once the served components ahead of it are in. */
  budgets: Array<{ task: BrainTask; bytes: number; room: number }>;
  issues: Array<{ severity: "error" | "warning"; message: string }>;
}

/** Render the items as the component's next file and check it with the rest of the served brain. Throws when the brain cannot be read. */
export async function checkTargetingFile(kv: BrainKv, component: EditableComponent, items: readonly BrainItemInput[], now: Date): Promise<CheckedFile> {
  const brain = await readServedBrain(kv);
  const name = `${component}.md`;
  const previous = brain.files.get(name) ?? null;
  const unverified = previous === null && brain.lock?.files[name] !== undefined;
  const meta = fileMeta(previous, component);
  const content = renderBrainFile({ component, version: meta.version + 1, updated: now.toISOString().slice(0, 10), owner: meta.owner, items });
  const files = [...brain.files.entries()].filter(([n]) => n !== name).map(([n, c]) => ({ name: n, content: c }));
  files.push({ name, content });
  const validation = await validateBrain(files);
  const issues: CheckedFile["issues"] = validation.issues
    .filter((i) => i.file === name || i.severity === "error")
    .filter((i) => !(i.file === "brain.lock.json"))
    .map((i) => ({ severity: i.severity === "error" ? "error" : "warning", message: i.file === name ? i.message : `${i.file}: ${i.message}` }));
  if (items.length === 0) issues.push({ severity: "error", message: `add at least one ${component} item` });
  if (unverified) issues.push({ severity: "error", message: `the served ${component} does not match the brain's lock, so what it holds cannot be shown or kept; upload the brain again or wait a minute` });
  const removedHardStops =
    component === "icp" && previous !== null
      ? itemsOf(previous, "icp")
          .filter((i) => i.fields.kind === "never" && !items.some((n) => n.id === i.id && n.fields.kind === "never"))
          .map((i) => i.id)
      : [];
  if (removedHardStops.length > 0) issues.push({ severity: "warning", message: `this removes the hard stop(s) ${removedHardStops.join(", ")}; sourcing stops excluding them once it is approved` });
  if (/[\u2013\u2014]/.test(content)) issues.push({ severity: "error", message: "the brain holds no em dashes or en dashes; use a comma, a colon or a period" });
  const parsed = parseBrainFile(name, content);
  const cost = componentCost(renderComponent(component, meta.version + 1, parsed.items));
  // Room is what the task leaves once the served components ahead of this one are in, as assembleSlice adds them.
  const costOf = (c: ComponentId): number => {
    const file = brain.files.get(`${c}.md`);
    if (!file) return 0;
    const p = parseBrainFile(`${c}.md`, file);
    return componentCost(renderComponent(c, (p.frontmatter as { version?: number } | undefined)?.version ?? 1, p.items));
  };
  const budgets = tasksReading(component).map((task) => {
    const order = taskComponents(task);
    const ahead = order.slice(0, order.indexOf(component)).reduce((n, c) => n + costOf(c), 0);
    return { task, bytes: cost, room: budgetFor(task, component) - sliceOverhead(task) - ahead };
  });
  for (const b of budgets) if (b.bytes > b.room) issues.push({ severity: "warning", message: `at ${b.bytes} bytes it does not fit the ${b.task} slice beside what is served there (${b.room} bytes left), so that task will leave it out; shorten it` });
  return { component, removedHardStops, content, sha256: await sha256Hex(content), baseSha256: previous === null ? null : await sha256Hex(previous), previousContent: previous, budgets, issues };
}

export type ProposeResult = { ok: true; proposal: LearningProposal; created: boolean; file: CheckedFile } | { ok: false; problems: string[]; file?: CheckedFile };

const PAGE_RATIONALE = "Written on the Product and ICP page. Approve only if every item is true of your product and your best customers.";
const SUGGESTED_RATIONALE = "Suggested by the model from your approved product and ICP, then picked and edited on the Product and ICP page. Every item already served is kept. Approve only if every added item is right for your market.";

/** Store a checked file as a brain proposal, or the reasons it cannot be. */
async function storeProposal(deps: { db: D1Database; now: Date }, file: CheckedFile, errors: string[], actor: string, rationale: string): Promise<ProposeResult> {
  if (errors.length > 0) return { ok: false, problems: errors, file };
  const created = await createLearningProposal(
    deps.db,
    {
      kind: "brain",
      payload: { component: file.component, baseSha256: file.baseSha256, content: file.content, previousContent: file.previousContent },
      rationale,
      proposedBy: actor,
    },
    deps.now,
  );
  if (!created.ok) return { ok: false, problems: created.problems, file };
  return { ok: true, proposal: created.proposal, created: created.created, file };
}

/** Store the operator's file as a brain proposal for a person to approve. Throws when the brain or the database cannot be read. */
export async function proposeTargeting(
  deps: { db: D1Database; kv: BrainKv; now: Date },
  component: TargetingComponent,
  items: readonly BrainItemInput[],
  actor: string,
  /** Served hard stops the operator confirmed removing. Any other one left out refuses the proposal. */
  confirmRemoved: readonly string[] = [],
): Promise<ProposeResult> {
  const file = await checkTargetingFile(deps.kv, component, items, deps.now);
  const errors = file.issues.filter((i) => i.severity === "error").map((i) => i.message);
  const unconfirmed = file.removedHardStops.filter((id) => !confirmRemoved.includes(id));
  if (unconfirmed.length > 0) errors.push(`this removes the hard stop(s) ${unconfirmed.join(", ")}, which the brain serves now; keep them, or confirm removing them`);
  return storeProposal(deps, file, errors, actor, PAGE_RATIONALE);
}

/**
 * Render every served item of the component, unchanged and in order, followed by the additions, as
 * its next file, and check it with the rest of the brain. Additions that collide with a served id,
 * repeat one another, or are none at all are errors. Throws when the brain cannot be read.
 */
export async function checkAdditions(kv: BrainKv, component: SuggestComponent, additions: readonly BrainItemInput[], now: Date): Promise<CheckedFile> {
  const brain = await readServedBrain(kv);
  const name = `${component}.md`;
  const previous = brain.files.get(name) ?? null;
  const served = previous ? itemsOf(previous, component) : [];
  const file = await checkTargetingFile(kv, component, [...served, ...additions], now);
  const issues = [...file.issues];
  // The file is built from the first read; its base digest from the second. If they differ, the
  // proposal would drop whatever changed in between, so refuse it.
  if ((previous === null ? null : await sha256Hex(previous)) !== file.baseSha256) issues.push({ severity: "error", message: `the served ${component} changed while it was being checked; check again` });
  if (additions.length === 0) issues.push({ severity: "error", message: `add at least one ${component} item` });
  if (additions.length > ADDITIONS_MAX) issues.push({ severity: "error", message: `add at most ${ADDITIONS_MAX} items at a time` });
  const servedIds = new Set(served.map((i) => i.id));
  const seen = new Set<string>();
  for (const item of additions) {
    if (servedIds.has(item.id)) issues.push({ severity: "error", message: `the brain already serves an item with the id ${item.id}` });
    else if (seen.has(item.id)) issues.push({ severity: "error", message: `the id ${item.id} is added twice` });
    seen.add(item.id);
  }
  // Warn, not refuse, when an addition repeats what is served in other words: the diff shows it too.
  const servedQueries = new Map(served.map((i) => [phraseKey(i.fields.query ?? ""), i.id]));
  const servedTitles = new Map(served.flatMap((i) => (i.fields.titles ?? "").split(",").map((t) => [phraseKey(t), i.id] as const)).filter(([k]) => k !== ""));
  for (const item of additions) {
    const same = component === "keyword-portfolio" ? servedQueries.get(phraseKey(item.fields.query ?? "")) : undefined;
    if (same) issues.push({ severity: "warning", message: `${item.id} repeats the served query ${same}` });
    const overlap = component === "personas" ? (item.fields.titles ?? "").split(",").map((t) => servedTitles.get(phraseKey(t))).find((x) => x !== undefined) : undefined;
    if (overlap) issues.push({ severity: "warning", message: `${item.id} repeats a title the served persona ${overlap} already has` });
  }
  return { ...file, issues };
}

/** Store the served items plus the additions as a brain proposal for a person to approve. Throws when the brain or the database cannot be read. */
export async function proposeAdditions(deps: { db: D1Database; kv: BrainKv; now: Date }, component: SuggestComponent, additions: readonly BrainItemInput[], actor: string): Promise<ProposeResult> {
  const file = await checkAdditions(deps.kv, component, additions, deps.now);
  return storeProposal(deps, file, file.issues.filter((i) => i.severity === "error").map((i) => i.message), actor, SUGGESTED_RATIONALE);
}
