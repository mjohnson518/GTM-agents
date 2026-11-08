// GTM-agents: what happens to a tool's output before the model sees it.
//
// sanitizeToolOutput, in order:
//   1. caps the output at TOOL_OUTPUT_MAX_CHARS, keeping head and tail, so what is scanned is
//      exactly what is shown;
//   2. redacts injection patterns, keeping every other character. Untrusted output also has
//      registered tool names redacted; trusted output (a repository file, a health report) may
//      legitimately name tools and keeps them;
//   3. wraps the result: a quarantine fence when the output is untrusted (the caller passes the
//      call's effective taint, which includes taint a handler reported) or when anything was
//      redacted, the plain wrapper otherwise.
// Untrusted output always goes into the user turn this way, never into a system prompt.
//
// Separate helpers clean error messages (no secrets, URLs or addresses reach the model or a log)
// and text bound for memory.
import { fenceUntrusted, wrapTrusted } from "./fence.ts";
import { redactInjection } from "./redact.ts";
import type { TaintLevel } from "./taint.ts";
import { capText } from "./truncate.ts";

export const TOOL_OUTPUT_MAX_CHARS = 30_000;
export const MEMORY_TEXT_MAX_CHARS = 5_000;
export const ERROR_MESSAGE_MAX_CHARS = 300;

export interface SanitizeOptions {
  /** The tool's name, as called. */
  tool: string;
  /** The taint this output carries: the tool's class taint, raised by anything the handler reported. */
  taint: TaintLevel;
  /** The registry's tool-name pattern, so tool names inside untrusted text are redacted. */
  toolNamePattern?: RegExp | null;
}

export interface SanitizedOutput {
  /** The wrapped text that goes to the model. */
  text: string;
  /** How many patterns were redacted. */
  redactions: number;
  truncated: boolean;
  /** True when the text is inside a quarantine fence. */
  fenced: boolean;
}

export function sanitizeToolOutput(output: string, { tool, taint, toolNamePattern }: SanitizeOptions): SanitizedOutput {
  const untrusted = taint !== "none";
  const capped = capText(output.length > 0 ? output : "[no output]", TOOL_OUTPUT_MAX_CHARS);
  const redacted = redactInjection(capped.text, untrusted ? toolNamePattern : null);
  const fenced = untrusted || redacted.count > 0;
  const notes = redacted.count > 0 ? [`[Security note: ${redacted.count} injection pattern(s) were redacted from this content.]`] : [];
  const text = fenced ? fenceUntrusted({ source: tool, text: redacted.text, notes }) : wrapTrusted({ source: tool, text: redacted.text });
  return { text, redactions: redacted.count, truncated: capped.truncated, fenced };
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
// An authorization scheme and everything up to the next delimiter.
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)\s+[^\s"',;]+/gi;
const KNOWN_TOKENS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk|xox[abprs]|gh[pousr]|glpat)[-_][A-Za-z0-9_-]{6,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JSON Web Token
];
// A secret-named key (possibly prefixed, such as client_secret or aws_secret_access_key, possibly
// quoted as in JSON) followed by its value.
const ASSIGNED_SECRET =
  /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|key|token|secret|password|passwd|pwd|authorization|signature|sig|credentials?|cookie)["']?\s*[=:]\s*["']?)(?!\[redacted\])[^\s&"',;}]+/gi;
// C0 control characters other than tab, line feed and carriage return, plus DEL.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * An error message fit to show the model or write to a log: one line, with no authorization
 * credentials, known token formats, secret-named values, URLs (which can carry tokens) or email
 * addresses, at most 300 characters.
 */
export function sanitizeErrorMessage(error: unknown): string {
  let raw: string;
  try {
    raw = error instanceof Error ? String(error.message) : typeof error === "string" ? error : "";
  } catch {
    raw = "";
  }
  if (raw.trim().length === 0) return "internal error";
  let cleaned = raw.replace(CONTROL, " ").replace(/\s+/g, " ");
  cleaned = cleaned.replace(URL_IN_TEXT, "[url]").replace(AUTH_SCHEME, "$1 [redacted]");
  for (const pattern of KNOWN_TOKENS) cleaned = cleaned.replace(pattern, "[redacted]");
  cleaned = cleaned.replace(ASSIGNED_SECRET, "$1[redacted]").replace(EMAIL, "[email]").trim();
  return capText(cleaned, ERROR_MESSAGE_MAX_CHARS).text;
}

/** Text bound for memory: capped, control characters removed, injection patterns redacted. */
export function sanitizeMemoryText(text: string, toolNamePattern?: RegExp | null): string {
  if (!text) return "";
  const capped = capText(text, MEMORY_TEXT_MAX_CHARS).text.replace(CONTROL, "");
  return redactInjection(capped, toolNamePattern).text;
}
