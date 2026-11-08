// GTM-agents: render a template for one contact. Skip rather than guess: if any variable the
// template uses has no value, the draft is held and the missing variables are reported.
import { ATTRIBUTE_VARIABLE, VARIABLE_TOKEN, isLineVariable } from "./variables.ts";

export interface TemplateValues {
  [variable: string]: string | null | undefined | Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

export type RenderResult =
  | { ok: true; subject: string; body: string; perDraftReview: boolean }
  | { ok: false; missing: string[] };

function lookup(name: string, values: TemplateValues): string | undefined {
  let raw: unknown;
  if (ATTRIBUTE_VARIABLE.test(name)) {
    raw = values.attributes?.[name.slice("attributes.".length)];
  } else {
    raw = values[name];
  }
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return undefined;
  const text = String(raw).trim();
  return text === "" ? undefined : text;
}

export function renderTemplate(template: { subject: string; body: string }, values: TemplateValues): RenderResult {
  const missing: string[] = [];
  const fill = (text: string) =>
    text.replace(VARIABLE_TOKEN, (_whole, rawName: string) => {
      const name = rawName.trim();
      const value = lookup(name, values);
      if (value === undefined) {
        if (!missing.includes(name)) missing.push(name);
        return "";
      }
      return value;
    });

  const lines: string[] = [];
  for (const line of template.body.split("\n")) {
    const only = /^\s*\{\{\s*([a-z_]+)\s*\}\}\s*$/.exec(line);
    if (only && isLineVariable(only[1] ?? "")) {
      const value = lookup(only[1] ?? "", values);
      if (value !== undefined) lines.push(value);
      continue; // an empty copy line removes the whole line
    }
    lines.push(fill(line));
  }
  const subject = fill(template.subject).trim();
  if (missing.length) return { ok: false, missing };

  const body = lines
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const usesSiteText = /\{\{\s*company_context\s*\}\}/.test(`${template.subject}\n${template.body}`);
  return { ok: true, subject, body, perDraftReview: usesSiteText };
}
