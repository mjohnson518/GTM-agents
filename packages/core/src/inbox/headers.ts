// GTM-agents: the inbound headers structural triage reads, and how they are normalized.
//
// An InboxProvider hands core a small, fixed set of headers (INBOUND_HEADER_NAMES) with lowercase
// keys, so every adapter gives triage the same view: whether a responder sent the message
// (auto-submitted, x-autoreply, precedence), whether it is list or bulk mail (list-id,
// list-unsubscribe), whether it is a delivery report (content-type, x-failed-recipients), and how it
// threads (message-id, in-reply-to, references). Values are unfolded onto one line, stripped of
// control characters and capped, because every header is untrusted text from outside.

/** The headers an adapter passes on, lowercase. Anything else is left out. */
export const INBOUND_HEADER_NAMES = [
  "message-id",
  "in-reply-to",
  "references",
  "reply-to",
  "return-path",
  "auto-submitted",
  "precedence",
  "list-id",
  "list-unsubscribe",
  "x-autoreply",
  "x-autorespond",
  "x-auto-response-suppress",
  "x-failed-recipients",
  "content-type",
  // What the receiving mailbox found when it checked the sender (SPF, DKIM, DMARC). Only the first
  // occurrence is kept: the one the receiving server prepended. Automatic replies read it.
  "authentication-results",
] as const;

export type InboundHeaderName = (typeof INBOUND_HEADER_NAMES)[number];

/** The longest header value kept, in characters. */
export const MAX_HEADER_CHARS = 4000;
/** The most message ids read from one References header (the newest are kept). */
export const MAX_REFERENCES = 50;

const WANTED: ReadonlySet<string> = new Set(INBOUND_HEADER_NAMES);

/** One header value on one line: folding and control characters removed, whitespace collapsed, capped. */
export function cleanHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_HEADER_CHARS);
}

/**
 * The triage headers from any list of (name, value) pairs: names lowercased, the first occurrence
 * of each kept, values cleaned, empty values dropped.
 */
export function pickInboundHeaders(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") continue;
    const name = rawName.trim().toLowerCase();
    if (!WANTED.has(name) || Object.hasOwn(out, name)) continue;
    if (name === "authentication-results") {
      // Read as proof of who sent the message, so it is kept only whole and only as plain ASCII:
      // anything else (a Unicode space or full-width punctuation that cleaning or normalizing could
      // turn into a delimiter, or a value too long to keep whole) drops it, and the sender counts
      // as unauthenticated. The first occurrence is still the one that decides.
      const unfolded = rawValue.replace(/\r?\n(?=[ \t])/g, "");
      const whole = unfolded.replace(/[ \t]+/g, " ").trim();
      out[name] = /^[\x20-\x7e]+$/.test(whole) && whole.length < MAX_HEADER_CHARS ? whole : "";
      continue;
    }
    const value = cleanHeaderValue(rawValue);
    if (value) out[name] = value;
  }
  // An Authentication-Results that was dropped above still claims its slot, so a later one never takes it.
  if (out["authentication-results"] === "") delete out["authentication-results"];
  return out;
}

const MESSAGE_ID = /<([^<>\s@"]{1,200}@[^<>\s@"]{1,200})>/g;
const BARE_MESSAGE_ID = /^([^<>\s@"]{1,200}@[^<>\s@"]{1,200})$/;

/**
 * The message ids in a Message-ID, In-Reply-To or References value, each as "<local@domain>", in
 * order and without duplicates. A bare id with no angle brackets is accepted when it is the whole
 * value. At most MAX_REFERENCES are returned, the last ones (the most recent in a References chain).
 */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  const text = value.slice(0, MAX_HEADER_CHARS * 4);
  const found: string[] = [];
  for (const match of text.matchAll(MESSAGE_ID)) found.push(`<${match[1] ?? ""}>`);
  if (found.length === 0) {
    const bare = BARE_MESSAGE_ID.exec(text.trim());
    if (bare) found.push(`<${bare[1] ?? ""}>`);
  }
  return [...new Set(found)].slice(-MAX_REFERENCES);
}

/** A message id for comparison: lowercase, without angle brackets. */
export function messageIdKey(id: string): string {
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}

/** The domain after the last "@" of a message id, lowercase, or null. */
export function messageIdDomain(id: string): string | null {
  const key = messageIdKey(id);
  const at = key.lastIndexOf("@");
  return at > 0 && at < key.length - 1 ? key.slice(at + 1) : null;
}
