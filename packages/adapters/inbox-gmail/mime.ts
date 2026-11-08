// GTM-agents: the inbox-gmail adapter's message handling: decoding Gmail's structured payload into
// plain text and a delivery report, parsing address headers, and building the plain-text RFC 5322
// messages that drafts and sends carry.
//
// Decoding:
//   - part bodies are base64url; each text part is decoded with its own charset (TextDecoder, so
//     UTF-8, ISO-8859-1, Windows-1252 and the rest), falling back to UTF-8 for a label the runtime
//     does not know;
//   - text/plain is preferred; with none, text is derived from text/html with scripts, styles and
//     tags removed, block ends turned into line breaks and entities decoded. Attachments are never
//     read as text;
//   - message/delivery-status and text/rfc822-headers parts, and the header block of a returned
//     message/rfc822 part, become the delivery report core reads failed recipients from;
//   - encoded words (RFC 2047) in headers are decoded.
// Building: plain text only (text/plain; charset=UTF-8, base64), with no HTML part, so nothing can
// carry a tracking pixel. A header whose value holds a line break is dropped, never folded, so
// nothing passed in can start another header.
import { htmlToText } from "@gtm-agents/core/inbox";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

/** Fetches an attachment's base64url data, for text parts Gmail did not inline. */
export type AttachmentFetcher = (attachmentId: string) => Promise<string | null>;

/** The longest text kept from one message, in characters. Core keeps less. */
export const MAX_TEXT_CHARS = 200_000;
/** The longest delivery report kept, in characters. */
export const MAX_REPORT_CHARS = 32_000;
/** Text parts larger than this are not fetched when Gmail did not inline them. */
export const MAX_FETCHED_PART_BYTES = 1_000_000;
const MAX_DEPTH = 12;

export function base64UrlToBytes(data: string): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode bytes in a charset, falling back to UTF-8 for a label the runtime does not know. */
export function decodeCharset(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = (charset ?? "utf-8").trim().replace(/^"|"$/g, "").toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** A parameter of a header value such as Content-Type: the charset in `text/plain; charset="iso-8859-1"`. */
export function headerParam(value: string, param: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(value);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** The value of a header in a list, case-insensitive, or undefined. */
export function headerValue(headers: readonly GmailHeader[] | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find((h) => typeof h?.name === "string" && h.name.toLowerCase() === wanted)?.value;
}

function decodeQ(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

/** Decode RFC 2047 encoded words ("=?UTF-8?B?...?="); anything else passes through. */
export function decodeEncodedWords(value: string): string {
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = value.replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?)/gi, "$1");
  return joined.replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toLowerCase() === "b" ? Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0)) : decodeQ(text);
      return decodeCharset(bytes, charset.split("*")[0]);
    } catch {
      return whole;
    }
  });
}

export interface DecodedBody {
  text: string;
  /** Set when the message carries a delivery report. */
  deliveryReport?: string;
}

function isAttachment(part: GmailPart): boolean {
  if (typeof part.filename === "string" && part.filename.length > 0) return true;
  return /^\s*attachment\b/i.test(headerValue(part.headers, "content-disposition") ?? "");
}

async function partText(part: GmailPart, fetchAttachment: AttachmentFetcher | undefined): Promise<string | null> {
  let data = typeof part.body?.data === "string" ? part.body.data : null;
  if (data === null && typeof part.body?.attachmentId === "string" && fetchAttachment && (part.body.size ?? 0) <= MAX_FETCHED_PART_BYTES) {
    data = await fetchAttachment(part.body.attachmentId);
  }
  if (data === null) return null;
  const charset = headerParam(headerValue(part.headers, "content-type") ?? "", "charset");
  try {
    return decodeCharset(base64UrlToBytes(data), charset);
  } catch {
    return null;
  }
}

/** The header block of a returned message part, as "Name: value" lines. */
function headerBlock(headers: readonly GmailHeader[] | undefined): string {
  return (headers ?? [])
    .filter((h) => typeof h?.name === "string" && typeof h.value === "string")
    .map((h) => `${h.name}: ${h.value.replace(/[\r\n]+/g, " ")}`)
    .join("\n");
}

/** Decode a Gmail payload into plain text and, for a delivery status notification, its report. */
export async function decodePayload(payload: GmailPart | undefined, fetchAttachment?: AttachmentFetcher): Promise<DecodedBody> {
  let plain: string | null = null;
  let html: string | null = null;
  const report: string[] = [];
  const walk = async (part: GmailPart, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const type = (part.mimeType ?? "").toLowerCase();
    if (type === "message/delivery-status" || type === "text/rfc822-headers") {
      const text = await partText(part, fetchAttachment);
      if (text) report.push(text);
      return;
    }
    if (type === "message/rfc822") {
      const inner = part.parts?.[0];
      if (inner?.headers?.length) report.push(headerBlock(inner.headers));
      else {
        const text = await partText(part, fetchAttachment);
        if (text) report.push(text.split(/\r?\n\r?\n/)[0] ?? "");
      }
      // The returned message's body is not the reply's text.
      return;
    }
    if (type.startsWith("multipart/") || (part.parts && part.parts.length > 0)) {
      for (const child of part.parts ?? []) await walk(child, depth + 1);
      return;
    }
    if (isAttachment(part)) return;
    if (type === "text/plain" && plain === null) plain = await partText(part, fetchAttachment);
    else if (type === "text/html" && html === null) html = await partText(part, fetchAttachment);
    else if (type === "" && plain === null) plain = await partText(part, fetchAttachment);
  };
  if (payload) await walk(payload, 0);
  const text = (plain ?? (html !== null ? htmlToText(html) : "")).replace(/\r\n?/g, "\n").slice(0, MAX_TEXT_CHARS);
  const joined = report.join("\n\n").replace(/\r\n?/g, "\n").slice(0, MAX_REPORT_CHARS);
  return { text, ...(joined.trim() ? { deliveryReport: joined } : {}) };
}

/** Split an address list on commas outside quotes and angle brackets. */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle += 1;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if ((ch === "," || ch === ";") && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** One mailbox: `"Name" <address>`, `Name <address>` or a bare address. The address is not validated here. */
export function parseMailbox(value: string): { email: string; name?: string } {
  const decoded = decodeEncodedWords(value).trim();
  const bracketed = /<([^<>]*)>\s*$/.exec(decoded);
  if (bracketed) {
    const name = decoded.slice(0, bracketed.index).trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").trim();
    return { email: (bracketed[1] ?? "").trim(), ...(name ? { name } : {}) };
  }
  // A bare address, possibly followed by a comment: jane@acme.example (Jane Doe).
  const comment = /^([^\s()]+)\s*\(([^)]*)\)\s*$/.exec(decoded);
  if (comment) return { email: comment[1] ?? "", ...(comment[2]?.trim() ? { name: comment[2].trim() } : {}) };
  return { email: decoded };
}

/** The addresses in a To or Cc header. */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return splitAddresses(value)
    .map((m) => parseMailbox(m).email)
    .filter((e) => e.includes("@"))
    .slice(0, 100);
}

const SAFE_HEADER_NAME = /^[A-Za-z0-9-]{1,76}$/;
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const UNSAFE_VALUE = /[\r\n\x00]/;
/** Headers this builder writes itself; a caller's copy is ignored. */
const RESERVED = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "message-id", "mime-version", "content-type", "content-transfer-encoding", "date"]);

/** A header value with non-ASCII text encoded as UTF-8 encoded words. */
export function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    // Each encoded word stays under 76 characters: about 45 bytes of UTF-8 before base64.
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(w))}?=`).join("\r\n ");
}

/** `"Name" <address>`, encoded when the name is not ASCII, or the bare address. */
export function formatMailbox(address: { email: string; name?: string }): string {
  const name = address.name?.replace(/[\r\n"\\<>]/g, "").trim();
  if (!name) return address.email;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${address.email}>` : `${encodeHeaderText(name)} <${address.email}>`;
}

/** True for one plain address with nothing that could start another header or name another mailbox. */
export function isPlainAddress(value: string): boolean {
  return /^[^\s@<>,;"()\\]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(value);
}

export interface RawMessageInput {
  from?: { email: string; name?: string };
  to: string;
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  /** Extra headers (List-Unsubscribe and the like). Unsafe names or values are dropped. */
  headers?: Record<string, string>;
}

/** A message id as "<local@domain>", or null when it is not one. */
export function normalizeMessageId(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^<?([^\s<>@"]{1,200}@[^\s<>@"]{1,200})>?$/.exec(value.trim());
  return match ? `<${match[1]}>` : null;
}

/** The base64url raw message Gmail's drafts and send endpoints take. Throws TypeError on an unusable recipient. */
export function buildRawMessage(input: RawMessageInput): string {
  if (!isPlainAddress(input.to)) throw new TypeError("the recipient is not one plain address");
  const lines: string[] = [];
  if (input.from) {
    if (!isPlainAddress(input.from.email)) throw new TypeError("the sender is not one plain address");
    lines.push(`From: ${formatMailbox(input.from)}`);
  }
  lines.push(`To: ${input.to}`);
  const cc = (input.cc ?? []).filter(isPlainAddress);
  if (cc.length > 0) lines.push(`Cc: ${cc.join(", ")}`);
  if (input.replyTo && isPlainAddress(input.replyTo)) lines.push(`Reply-To: ${input.replyTo}`);
  lines.push(`Subject: ${encodeHeaderText(input.subject.replace(/[\r\n]+/g, " ").trim())}`);
  const parent = normalizeMessageId(input.inReplyTo);
  const references = [...new Set((input.references ?? []).map(normalizeMessageId).filter((id): id is string => id !== null))];
  if (parent && !references.includes(parent)) references.push(parent);
  if (parent) lines.push(`In-Reply-To: ${parent}`);
  if (references.length > 0) lines.push(`References: ${references.slice(-20).join(" ")}`);
  const ownId = normalizeMessageId(input.messageId);
  if (ownId) lines.push(`Message-ID: ${ownId}`);
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!SAFE_HEADER_NAME.test(name) || RESERVED.has(name.toLowerCase()) || /^(in-reply-to|references)$/i.test(name)) continue;
    if (typeof value !== "string" || UNSAFE_VALUE.test(value)) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "");
  const body = bytesToBase64(new TextEncoder().encode(input.text.replace(/\r?\n/g, "\r\n")));
  for (let i = 0; i < body.length; i += 76) lines.push(body.slice(i, i + 76));
  return bytesToBase64Url(new TextEncoder().encode(lines.join("\r\n")));
}
