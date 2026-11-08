// GTM-agents: the variables a template may use. Anything a template uses that has no value for a
// contact holds the draft for that contact; nothing ever falls back to "Hi there".

export const INLINE_VARIABLES = [
  "first_name",
  "last_name",
  "title",
  "account_name",
  "angle_opener",
  "angle_age",
  "persona_hint",
  "proven_insight",
  "original_subject",
  "booking_url",
  "sender_name",
  "company_context",
] as const;

/** Variables that must sit alone on a line; an empty value removes the whole line. */
export const LINE_VARIABLES = ["segment_line", "team_size_line", "persona_line"] as const;

export const ATTRIBUTE_VARIABLE = /^attributes\.[a-z0-9_]+$/;

/** Matches `{{ name }}` tokens. */
export const VARIABLE_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

const inline: ReadonlySet<string> = new Set(INLINE_VARIABLES);
const lineVars: ReadonlySet<string> = new Set(LINE_VARIABLES);

export function isLineVariable(name: string): boolean {
  return lineVars.has(name);
}

export function isAllowedVariable(name: string): boolean {
  return inline.has(name) || lineVars.has(name) || ATTRIBUTE_VARIABLE.test(name);
}

/** Variable names used in a piece of text, in order of first appearance. */
export function variablesIn(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(VARIABLE_TOKEN)) {
    const name = m[1] ?? "";
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}
