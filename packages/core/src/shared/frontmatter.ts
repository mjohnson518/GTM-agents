// GTM-agents: the strict, flat frontmatter shared by brain files and templates.
//
//   ---
//   key: value
//   other_key: another value
//   ---
//   body...
//
// One `key: value` per line, keys in snake_case, no nesting, no inline comments, no duplicates.

export interface Issue {
  severity: "error" | "warning";
  file: string;
  /** 1-based; 0 when the issue concerns the whole file. */
  line: number;
  message: string;
}

export interface FieldValue {
  value: string;
  line: number;
}

export interface FrontmatterDocument {
  fields: Map<string, FieldValue>;
  body: string;
  /** 1-based line number of the first body line. */
  bodyStartLine: number;
}

const KEY = /^[a-z][a-z0-9_]*$/;

export function parseFrontmatter(file: string, text: string, issues: Issue[]): FrontmatterDocument | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    issues.push({ severity: "error", file, line: 1, message: "the file must start with a --- frontmatter block" });
    return null;
  }
  const fields = new Map<string, FieldValue>();
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "---") break;
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon).trim();
    if (colon === -1 || !KEY.test(key)) {
      issues.push({ severity: "error", file, line: i + 1, message: "frontmatter lines look like `key: value`, with a snake_case key" });
      continue;
    }
    if (fields.has(key)) {
      issues.push({ severity: "error", file, line: i + 1, message: `duplicate frontmatter key "${key}"` });
      continue;
    }
    fields.set(key, { value: line.slice(colon + 1).trim(), line: i + 1 });
  }
  if (i >= lines.length) {
    issues.push({ severity: "error", file, line: 1, message: "the frontmatter block is not closed with ---" });
    return null;
  }
  return { fields, body: lines.slice(i + 1).join("\n"), bodyStartLine: i + 2 };
}

/** Split a comma-separated list value. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

const DASHES = /[\u2013\u2014]/;

/** Report em and en dashes, which the house style forbids everywhere. */
export function checkDashes(file: string, text: string, issues: Issue[]): void {
  text.split(/\r?\n/).forEach((line, i) => {
    if (DASHES.test(line)) issues.push({ severity: "error", file, line: i + 1, message: "em and en dashes are not allowed; use a comma, period, colon or parentheses" });
  });
}
