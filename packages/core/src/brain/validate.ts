// GTM-agents: validate a whole brain directory: every file against its schema, the rules that
// span files (references, URLs, prices), the per-task byte budgets, and the lock file.
import type { Issue } from "../shared/frontmatter.ts";
import { componentCost, renderComponent, sliceOverhead } from "./assemble.ts";
import { COMPONENT_IDS, LOCK_FILE, TASK_SPECS, tasksReading, type ComponentId } from "./components.ts";
import { sha256Hex, type BrainLock } from "./lock.ts";
import { parseBrainFile, type ParsedBrainFile } from "./parse.ts";
import { PRICE_COMPONENT, REFERENCES, URL_FIELDS } from "./schema.ts";

export interface BrainFileInput {
  name: string;
  content: string;
}

export interface BrainValidation {
  ok: boolean;
  issues: Issue[];
  parsed: ParsedBrainFile[];
  /** Approved files with no errors: the files a lock would cover. */
  approved: BrainFileInput[];
}

export interface ValidateOptions {
  /** The parsed lock file; null when there is none. Omit to skip lock checks (when writing a lock). */
  lock?: BrainLock | null;
}

const URL_PATTERN = /\bhttps?:\/\/|\bwww\./i;
const PRICE_PATTERN = /[$\u20ac\u00a3\u00a5]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b/i;

export async function validateBrain(files: BrainFileInput[], options: ValidateOptions = {}): Promise<BrainValidation> {
  const issues: Issue[] = [];
  const parsed: ParsedBrainFile[] = [];

  for (const file of files) {
    if (/^readme\.md$/i.test(file.name) || file.name === LOCK_FILE) continue;
    if (!file.name.endsWith(".md")) {
      issues.push({ severity: "error", file: file.name, line: 0, message: "unexpected file in the brain folder; brain components are .md files" });
      continue;
    }
    const result = parseBrainFile(file.name, file.content);
    parsed.push(result);
    issues.push(...result.issues);
  }

  const byComponent = new Map<ComponentId, ParsedBrainFile>();
  for (const p of parsed) if (p.component) byComponent.set(p.component, p);

  for (const component of COMPONENT_IDS) {
    if (!byComponent.has(component)) {
      issues.push({ severity: "warning", file: `${component}.md`, line: 0, message: "component is missing; tasks that read it will be told it is unknown" });
    }
  }

  for (const p of parsed) {
    if (!p.component || !p.frontmatter) continue;
    if (p.frontmatter.status === "draft") issues.push({ severity: "warning", file: p.file, line: 0, message: "status is draft, so this component is never served" });
    checkItemRules(p, byComponent, issues);
  }

  const hasErrors = (file: string) => issues.some((i) => i.severity === "error" && i.file === file);
  checkBudgets(
    parsed.filter((p) => p.component && p.frontmatter?.status === "approved" && !hasErrors(p.file)),
    issues,
  );
  const approvedParsed = parsed.filter((p) => p.component && p.frontmatter?.status === "approved" && !hasErrors(p.file));

  const approved = approvedParsed.map((p) => files.find((f) => f.name === p.file) as BrainFileInput);
  if (options.lock !== undefined) await checkLock(options.lock, approved, issues);

  return { ok: !issues.some((i) => i.severity === "error"), issues, parsed, approved };
}

function checkItemRules(p: ParsedBrainFile, byComponent: Map<ComponentId, ParsedBrainFile>, issues: Issue[]): void {
  issues.push(...contentRuleIssues(p));
  const component = p.component as ComponentId;
  const refs = REFERENCES[component] ?? {};
  for (const item of p.items) {
    const value = item.value;
    if (!value) continue;
    for (const [field, target] of Object.entries(refs)) {
      const ids = value[field];
      if (!Array.isArray(ids)) continue;
      const targetItems = new Set((byComponent.get(target)?.items ?? []).map((i) => i.id));
      for (const id of ids as string[]) {
        if (!targetItems.has(id)) {
          issues.push({ severity: "error", file: p.file, line: item.raw[field]?.line ?? item.line, message: `item "${item.id}": ${field} refers to "${id}", which is not an item in ${target}.md` });
        }
      }
    }
  }
}

/**
 * The rules that need only the file itself: URLs only in url fields, prices only in commercial,
 * ICP never items, and currencies on prices. The runtime loader re-applies them, so a file that
 * breaks them is never served even if it was locked without validation.
 */
export function contentRuleIssues(p: ParsedBrainFile): Issue[] {
  const issues: Issue[] = [];
  if (!p.component) return issues;
  const component = p.component;
  const urlFields = URL_FIELDS[component] ?? [];

  for (const item of p.items) {
    const value = item.value;
    if (!value) continue;
    for (const [key, raw] of Object.entries(item.raw)) {
      if (!urlFields.includes(key) && URL_PATTERN.test(raw.value)) {
        issues.push({ severity: "error", file: p.file, line: raw.line, message: `item "${item.id}": URLs are only allowed in the url field of facts and commercial` });
      }
      if (component !== PRICE_COMPONENT && PRICE_PATTERN.test(raw.value)) {
        issues.push({ severity: "error", file: p.file, line: raw.line, message: `item "${item.id}": prices belong in commercial.md only` });
      }
    }
    if (component === "icp") {
      const scoped = ["domains", "accounts", "titles"].filter((k) => k in value);
      if (value.kind === "never" && scoped.length === 0) {
        issues.push({ severity: "error", file: p.file, line: item.line, message: `item "${item.id}": a never item needs domains, accounts or titles` });
      }
      if (value.kind !== "never" && scoped.length > 0) {
        issues.push({ severity: "error", file: p.file, line: item.line, message: `item "${item.id}": domains, accounts and titles are only allowed on never items` });
      }
    }
    if (component === "commercial" && value.price !== undefined && value.currency === undefined) {
      issues.push({ severity: "error", file: p.file, line: item.raw.price?.line ?? item.line, message: `item "${item.id}": price needs a currency` });
    }
  }
  return issues;
}

function checkBudgets(approved: ParsedBrainFile[], issues: Issue[]): void {
  for (const p of approved) {
    const component = p.component as ComponentId;
    const block = renderComponent(component, p.frontmatter?.version ?? 1, p.items);
    const cost = componentCost(block);
    const tasks = tasksReading(component);
    const fitting = tasks.filter((t) => sliceOverhead(t) + cost <= TASK_SPECS[t].budgetBytes);
    if (fitting.length === 0) {
      issues.push({ severity: "error", file: p.file, line: 0, message: `component is ${cost} bytes and fits no task that reads it (${tasks.join(", ")}); shorten it` });
    } else if (fitting.length < tasks.length) {
      const dropped = tasks.filter((t) => !fitting.includes(t));
      issues.push({ severity: "warning", file: p.file, line: 0, message: `component is ${cost} bytes; these tasks will drop it for size: ${dropped.join(", ")}` });
    }
  }
}

async function checkLock(lock: BrainLock | null, approved: BrainFileInput[], issues: Issue[]): Promise<void> {
  if (lock === null) {
    issues.push({ severity: "warning", file: LOCK_FILE, line: 0, message: "no lock file; nothing is served until you run `gtm brain validate --write-lock`" });
    return;
  }
  const approvedNames = new Set(approved.map((f) => f.name));
  for (const file of approved) {
    const expected = lock.files[file.name];
    if (!expected) {
      issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: `${file.name} is approved but not locked; run \`gtm brain validate --write-lock\`` });
    } else if (expected !== (await sha256Hex(file.content))) {
      issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: `${file.name} changed since it was locked; review it, then run \`gtm brain validate --write-lock\`` });
    }
  }
  for (const name of Object.keys(lock.files)) {
    if (!approvedNames.has(name)) issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: `the lock lists ${name}, which is missing, a draft or invalid` });
  }
  const entries = Object.entries(lock.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if ((await sha256Hex(entries.map(([n, h]) => `${n} ${h}\n`).join(""))) !== lock.hash) {
    issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: "the lock hash does not match its entries; regenerate it with --write-lock" });
  }
}
