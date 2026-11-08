// GTM-agents: parse a template file: frontmatter (including the subject) and the plain-text body.
import { parseFrontmatter, splitList, type Issue } from "../shared/frontmatter.ts";
import { LIST_KEYS, NUMBER_KEYS, templateFrontmatterSchema, type TemplateFrontmatter } from "./schema.ts";

export interface ParsedTemplate {
  file: string;
  meta: TemplateFrontmatter | undefined;
  subject: string;
  body: string;
  bodyStartLine: number;
  subjectLine: number;
  issues: Issue[];
}

export function parseTemplate(file: string, content: string): ParsedTemplate {
  const issues: Issue[] = [];
  const doc = parseFrontmatter(file, content, issues);
  if (!doc) return { file, meta: undefined, subject: "", body: "", bodyStartLine: 1, subjectLine: 1, issues };

  const raw: Record<string, unknown> = {};
  for (const [key, { value }] of doc.fields) {
    raw[key] = LIST_KEYS.has(key) ? splitList(value) : NUMBER_KEYS.has(key) ? Number(value) : value;
  }
  const result = templateFrontmatterSchema.safeParse(raw);
  let meta: TemplateFrontmatter | undefined;
  if (result.success) {
    meta = result.data;
  } else {
    for (const issue of result.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) issues.push({ severity: "error", file, line: doc.fields.get(key)?.line ?? 1, message: `unknown frontmatter key "${key}"` });
        continue;
      }
      const key = String(issue.path[0] ?? "");
      const present = doc.fields.has(key);
      issues.push({
        severity: "error",
        file,
        line: doc.fields.get(key)?.line ?? 1,
        message: present ? `frontmatter "${key}": ${issue.message}` : `missing required frontmatter key "${key}"`,
      });
    }
  }
  const body = doc.body.replace(/^\n+/, "");
  const leading = doc.body.length - body.length;
  return {
    file,
    meta,
    subject: typeof raw.subject === "string" ? raw.subject : "",
    body,
    bodyStartLine: doc.bodyStartLine + (doc.body.slice(0, leading).match(/\n/g)?.length ?? 0),
    subjectLine: doc.fields.get("subject")?.line ?? 1,
    issues,
  };
}
