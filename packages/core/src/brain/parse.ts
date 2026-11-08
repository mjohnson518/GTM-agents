// GTM-agents: parse one brain file into frontmatter and typed items.
import type { z } from "zod";
import { checkDashes, parseFrontmatter, type Issue } from "../shared/frontmatter.ts";
import { isComponentId, type ComponentId } from "./components.ts";
import { COMPONENT_SCHEMAS, ITEM_ID, coerceFields, frontmatterSchema, type BrainFrontmatter } from "./schema.ts";

export interface BrainItem {
  id: string;
  line: number;
  /** Raw field strings, with the line each came from. */
  raw: Record<string, { value: string; line: number }>;
  /** The validated, typed item; undefined when the item failed validation. */
  value?: Record<string, unknown>;
}

export interface ParsedBrainFile {
  file: string;
  component: ComponentId | undefined;
  frontmatter: BrainFrontmatter | undefined;
  items: BrainItem[];
  issues: Issue[];
}

const FIELD = /^- ([a-z][a-z0-9_]*):(?:\s(.*))?$/;

export function parseBrainFile(file: string, content: string): ParsedBrainFile {
  const issues: Issue[] = [];
  const expected = file.replace(/\.md$/, "");
  const component = isComponentId(expected) ? expected : undefined;
  if (!component) issues.push({ severity: "error", file, line: 0, message: `"${file}" is not a brain component; see docs/BRAIN-SCHEMA.md for the fourteen file names` });

  checkDashes(file, content, issues);
  const doc = parseFrontmatter(file, content, issues);
  if (!doc) return { file, component, frontmatter: undefined, items: [], issues };

  const fm: Record<string, unknown> = {};
  for (const [key, { value }] of doc.fields) fm[key] = key === "version" ? Number(value) : value;
  const parsedFm = frontmatterSchema.safeParse(fm);
  let frontmatter: BrainFrontmatter | undefined;
  if (parsedFm.success) {
    frontmatter = parsedFm.data;
    if (component && frontmatter.component !== component) {
      issues.push({ severity: "error", file, line: doc.fields.get("component")?.line ?? 1, message: `frontmatter says component "${frontmatter.component}" but the file is ${file}` });
    }
  } else {
    for (const issue of parsedFm.error.issues) {
      const key = String(issue.path[0] ?? "");
      issues.push({ severity: "error", file, line: doc.fields.get(key)?.line ?? 1, message: `frontmatter ${key ? `"${key}"` : ""}: ${issue.message}`.trim() });
    }
  }

  const items = parseItems(file, doc.body, doc.bodyStartLine, issues);
  if (component) {
    for (const item of items) validateItem(file, component, item, issues);
  }
  return { file, component, frontmatter, items, issues };
}

function parseItems(file: string, body: string, startLine: number, issues: Issue[]): BrainItem[] {
  const items: BrainItem[] = [];
  const seen = new Set<string>();
  let current: BrainItem | undefined;
  body.split(/\r?\n/).forEach((line, index) => {
    const n = startLine + index;
    if (line.startsWith("## ")) {
      const id = line.slice(3).trim();
      if (!ITEM_ID.test(id)) issues.push({ severity: "error", file, line: n, message: `item id "${id}" must be kebab-case` });
      if (seen.has(id)) issues.push({ severity: "error", file, line: n, message: `item id "${id}" is used twice` });
      seen.add(id);
      current = { id, line: n, raw: {} };
      items.push(current);
      return;
    }
    if (!current || line.trim() === "") return; // notes before the first item are for humans
    const m = FIELD.exec(line);
    if (!m) {
      issues.push({ severity: "error", file, line: n, message: "inside an item, every line is a `- key: value` bullet" });
      return;
    }
    const key = m[1] as string;
    if (current.raw[key]) issues.push({ severity: "error", file, line: n, message: `field "${key}" appears twice in item "${current.id}"` });
    current.raw[key] = { value: (m[2] ?? "").trim(), line: n };
  });
  return items;
}

function validateItem(file: string, component: ComponentId, item: BrainItem, issues: Issue[]): void {
  const raw = Object.fromEntries(Object.entries(item.raw).map(([k, v]) => [k, v.value]));
  const result = (COMPONENT_SCHEMAS[component] as z.ZodType<Record<string, unknown>>).safeParse(coerceFields(component, raw));
  if (result.success) {
    item.value = result.data;
    return;
  }
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({ severity: "error", file, line: item.raw[key]?.line ?? item.line, message: `item "${item.id}": unknown field "${key}"` });
      }
      continue;
    }
    const key = String(issue.path[0] ?? "");
    const missing = issue.code === "invalid_type" && !(key in item.raw);
    issues.push({
      severity: "error",
      file,
      line: item.raw[key]?.line ?? item.line,
      message: missing ? `item "${item.id}": missing required field "${key}"` : `item "${item.id}": ${key ? `${key}: ` : ""}${issue.message}`,
    });
  }
}
