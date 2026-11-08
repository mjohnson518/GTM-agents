// GTM-agents: cleaning third-party text before it is stored.
//
// Everything a discovery source, people provider or finder returns is third-party text: names,
// titles, page titles, snippets and URLs. Before any of it reaches the database it is cleaned here:
//   - control characters are removed and whitespace collapsed, so a value is one line;
//   - it is capped (head and tail kept), so a provider cannot fill a row;
//   - injection patterns are redacted, keeping every other character.
// Stored provider text is still untrusted. A prompt that reads it later puts it inside the fence
// (security/fence.ts), never in a system prompt.
import { redactInjection } from "../security/redact.ts";
import { capText } from "../security/truncate.ts";

/** Caps for each kind of provider text, in characters. */
export const PROVIDER_TEXT_CAPS = Object.freeze({
  name: 80,
  title: 120,
  accountName: 120,
  resultTitle: 200,
  snippet: 500,
  reason: 160,
  ref: 200,
});

// C0 and C1 control characters, DEL, and the zero-width and bidirectional controls that can hide
// text from a reader.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Provider text fit to store: one line, capped, injection patterns redacted; null when empty. */
export function cleanProviderText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const oneLine = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  // The cap's notice of what was dropped has line breaks of its own; fold them back into one line.
  const capped = capText(oneLine, maxChars).text.replace(/\s+/g, " ");
  const redacted = redactInjection(capped).text.trim();
  return redacted.length > 0 ? redacted : null;
}

/** An http or https URL without credentials, at most 2,048 characters, or null. */
export function cleanProviderUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href.length <= 2048 ? url.href : null;
}
