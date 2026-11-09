// GTM-agents: text helpers the self-improvement loops share: defanging examples, splitting
// sentences, a line diff for brain edits, and the mutation constraints every proposed snippet meets.
// Pure.
import { lintOutbound } from "../quality/lint.ts";
import { detectInjection } from "../security/redact.ts";
import { sanitizeMemoryText } from "../security/sanitize.ts";

const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const BARE_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|dev|app|example|xyz|info|biz)\b/gi;
const EMAIL = /\b[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}\b/gi;
const DASHES = /[\u2013\u2014]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * An example kept as data: links broken so nothing can follow them ("hxxps://acme[.]example"),
 * addresses replaced, control characters removed, injection patterns redacted, and capped.
 */
export function defang(text: string, max = 240): string {
  let out = text.replace(CONTROL, "").replace(EMAIL, "[email]");
  out = out.replace(URL_LIKE, (url) => url.replace(/^http/i, "hxxp").replace(/\./g, "[.]"));
  out = out.replace(BARE_HOST, (host) => host.replace(/\./g, "[.]"));
  out = sanitizeMemoryText(out.replace(/\s+/g, " ").trim());
  return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out;
}

/** The text's sentences, in order. A blank line or a line break also ends one. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A sentence folded for comparison: lower case, punctuation and runs of space removed. */
export function foldSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const wordsIn = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** True when the text holds a link or a bare host name. */
export function hasLink(text: string): boolean {
  URL_LIKE.lastIndex = 0;
  BARE_HOST.lastIndex = 0;
  const found = URL_LIKE.test(text) || BARE_HOST.test(text);
  URL_LIKE.lastIndex = 0;
  BARE_HOST.lastIndex = 0;
  return found;
}

/**
 * A line diff of two texts: unchanged lines start with two spaces, removed lines with "- ", added
 * lines with "+ ". Longest common subsequence, so the smallest set of changes is shown.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] = a[i] === b[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i] ?? ""}`);
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push(`- ${a[i] ?? ""}`);
      i++;
    } else {
      out.push(`+ ${b[j] ?? ""}`);
      j++;
    }
  }
  while (i < a.length) out.push(`- ${a[i++] ?? ""}`);
  while (j < b.length) out.push(`+ ${b[j++] ?? ""}`);
  return out.join("\n");
}

export const SNIPPET_MAX_CHARS = 400;

/**
 * The mutation constraints on text a loop proposes (a learnings snippet, an objection answer, a
 * playbook field): one to SNIPPET_MAX_CHARS characters, no link or bare host, no address, no em or
 * en dash, no control character, no injection pattern, and nothing the content lint blocks. Returns
 * what is wrong; empty means it may be proposed.
 */
export function snippetProblems(text: string, max = SNIPPET_MAX_CHARS): string[] {
  const problems: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) problems.push("it is empty");
  if (trimmed.length > max) problems.push(`it is over ${max} characters`);
  if (hasLink(trimmed)) problems.push("it holds a link or a host name");
  EMAIL.lastIndex = 0;
  if (EMAIL.test(trimmed)) problems.push("it holds an email address");
  EMAIL.lastIndex = 0;
  if (DASHES.test(trimmed)) problems.push("it holds an em or en dash");
  CONTROL.lastIndex = 0;
  if (CONTROL.test(trimmed)) problems.push("it holds a control character");
  CONTROL.lastIndex = 0;
  if (detectInjection(trimmed) > 0) problems.push("it reads like an instruction to the model");
  const lint = lintOutbound({ subject: "snippet", body: trimmed || "x" });
  for (const block of lint.blocks) problems.push(`the content lint blocks it (${block.code})`);
  return [...new Set(problems)];
}
