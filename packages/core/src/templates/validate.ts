// GTM-agents: structural checks for templates. At send time every rendered draft also passes the
// full deterministic quality gate and the model reviewer; these checks catch what can be known
// before any contact is involved.
import { checkDashes, type Issue } from "../shared/frontmatter.ts";
import { parseTemplate, type ParsedTemplate } from "./parse.ts";
import { SEQUENCE_KINDS, SUBJECT_MAX, WORD_BOUNDS } from "./schema.ts";
import { VARIABLE_TOKEN, countWords, isAllowedVariable, isLineVariable, variablesIn } from "./variables.ts";

export interface TemplateValidationOptions {
  /** The company's own domain; links to it (and its subdomains) are allowed. */
  companyDomain?: string;
}

export interface TemplateValidation {
  ok: boolean;
  issues: Issue[];
  parsed: ParsedTemplate[];
}

const LEAKS: Array<[RegExp, string]> = [
  [/\{\{|\}\}/, "an unclosed or malformed {{ }} placeholder"],
  [/\{[^{}\n]*\}/, "a { } placeholder"],
  [/\[(?:INSERT|YOUR)\b/i, "an [INSERT ...] placeholder"],
  [/%s|\$\{|<%/, "a %s, ${ } or <% %> placeholder"],
  [/\b(?:TODO|TBD|lorem ipsum)\b/i, "TODO, TBD or lorem ipsum"],
];
const LINK = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi;

export function validateTemplateFile(file: string, content: string, options: TemplateValidationOptions = {}): ParsedTemplate {
  const parsed = parseTemplate(file, content);
  const issues = parsed.issues;
  checkDashes(file, content, issues);
  const meta = parsed.meta;
  const error = (line: number, message: string) => issues.push({ severity: "error", file, line, message });

  if (meta) {
    const stem = file.replace(/\.md$/, "");
    if (meta.id !== stem) error(1, `id "${meta.id}" must equal the file name (${stem})`);
    if (SEQUENCE_KINDS.includes(meta.kind) && meta.step === undefined) error(1, `${meta.kind} templates need a step`);
    if (meta.kind === "cold_intro" && meta.step !== undefined && meta.step !== 1) error(1, "a cold_intro is step 1");
  }

  // Variables.
  for (const name of variablesIn(parsed.subject)) {
    if (!isAllowedVariable(name)) error(parsed.subjectLine, `unknown variable {{${name}}} in the subject`);
    else if (isLineVariable(name)) error(parsed.subjectLine, `{{${name}}} must sit alone on a body line, not in the subject`);
    else if (name === "company_context") error(parsed.subjectLine, "{{company_context}} is fetched site text and is not allowed in a subject");
  }
  parsed.body.split("\n").forEach((line, i) => {
    const n = parsed.bodyStartLine + i;
    for (const name of variablesIn(line)) {
      if (!isAllowedVariable(name)) error(n, `unknown variable {{${name}}}`);
      else if (isLineVariable(name) && line.trim() !== `{{${name}}}`) error(n, `{{${name}}} must sit alone on its line`);
    }
  });

  // Placeholder leaks and other forbidden content, checked with the allowed variables removed.
  const stripped = (text: string) => text.replace(VARIABLE_TOKEN, "");
  for (const [text, line] of [
    [parsed.subject, parsed.subjectLine],
    ...parsed.body.split("\n").map((l, i) => [l, parsed.bodyStartLine + i] as const),
  ] as Array<readonly [string, number]>) {
    for (const [pattern, what] of LEAKS) {
      if (pattern.test(stripped(text))) error(line, `contains ${what}`);
    }
  }
  if (/unsubscribe/i.test(parsed.body)) error(parsed.bodyStartLine, "leave out the unsubscribe line and footer; the send path appends them to every email");

  // Links.
  for (const [text, line] of [[parsed.subject, parsed.subjectLine] as const, ...parsed.body.split("\n").map((l, i) => [l, parsed.bodyStartLine + i] as const)]) {
    for (const m of stripped(text).matchAll(LINK)) {
      const host = hostOf(m[0]);
      if (!options.companyDomain) {
        issues.push({ severity: "warning", file, line, message: `link ${m[0]} could not be checked without the company domain; only {{booking_url}} and your own domain are allowed` });
      } else if (!host || !(host === options.companyDomain || host.endsWith(`.${options.companyDomain}`))) {
        error(line, `link ${m[0]} is not allowed; use {{booking_url}} or a URL on ${options.companyDomain}`);
      }
    }
  }

  // Shape.
  const exclamations = (stripped(`${parsed.subject}\n${parsed.body}`).match(/!/g) ?? []).length;
  if (exclamations > 1) error(parsed.bodyStartLine, "use at most one exclamation mark");
  if (meta?.kind === "cold_intro" && !parsed.body.includes("?")) error(parsed.bodyStartLine, "a cold intro must ask at least one question");
  if (stripped(parsed.subject).length > SUBJECT_MAX) error(parsed.subjectLine, `the subject is over ${SUBJECT_MAX} characters before variables are filled in`);
  if (meta) {
    const inlineVars = [...parsed.body.matchAll(VARIABLE_TOKEN)].filter((m) => !isLineVariable(m[1] ?? "")).length;
    const words = countWords(stripped(parsed.body)) + inlineVars;
    const bounds = WORD_BOUNDS[meta.kind];
    if (words > bounds.max) error(parsed.bodyStartLine, `the body has at least ${words} words; ${meta.kind} allows ${bounds.max}`);
    else if (words < bounds.min) issues.push({ severity: "warning", file, line: parsed.bodyStartLine, message: `the body has about ${words} words before copy lines are filled in; ${meta.kind} needs at least ${bounds.min}` });
  }
  return parsed;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.startsWith("www.") ? `https://${url}` : url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Validate every template in a folder, plus the rules that span templates. */
export function validateTemplates(files: Array<{ name: string; content: string }>, options: TemplateValidationOptions = {}): TemplateValidation {
  const parsed: ParsedTemplate[] = [];
  const issues: Issue[] = [];
  for (const file of files) {
    if (/^readme\.md$/i.test(file.name)) continue;
    if (!file.name.endsWith(".md")) {
      issues.push({ severity: "error", file: file.name, line: 0, message: "unexpected file in the templates folder; templates are .md files" });
      continue;
    }
    const p = validateTemplateFile(file.name, file.content, options);
    parsed.push(p);
    issues.push(...p.issues);
  }
  const ids = new Map<string, string>();
  for (const p of parsed) {
    if (!p.meta) continue;
    const prior = ids.get(p.meta.id);
    if (prior) issues.push({ severity: "error", file: p.file, line: 1, message: `template id "${p.meta.id}" is also used by ${prior}` });
    ids.set(p.meta.id, p.file);
  }
  const targeted = (p: ParsedTemplate) => Boolean(p.meta?.segments ?? p.meta?.personas ?? p.meta?.team_sizes);
  if (parsed.some(targeted)) {
    for (const p of parsed.filter((t) => t.meta && !targeted(t) && t.meta.kind === "cold_intro")) {
      issues.push({ severity: "warning", file: p.file, line: 1, message: "other templates have targeting and this one does not, so it will be offered to every contact" });
    }
  }
  return { ok: !issues.some((i) => i.severity === "error"), issues, parsed };
}
