// GTM-agents: text helpers for reply handling: the sender's own words, verbatim checks, signature
// stripping, deterministic wording checks, and the short preview an operator message may carry.
//
// Inbound text is untrusted (full taint). These helpers only cut, compare and match it. Nothing
// here sends it anywhere: callers that pass it to a model sanitize and fence it first, and operator
// messages carry at most operatorPreview's output.
import { redactInjection } from "../security/redact.ts";
import { normalizeAddress } from "../sending/suppression.ts";

/** The most of the sender's own text triage and drafting read. */
export const SENDER_TEXT_MAX_CHARS = 4000;
/** The longest preview an operator message carries. */
export const PREVIEW_MAX_CHARS = 80;

// Quoted-history markers. Everything from the first one onward is earlier mail, not the sender's
// new text. The attribution line ("On Mon, 2 Nov 2026 at 09:14, Avery <avery@acme.example> wrote:")
// can wrap onto a second line. Over-matching only shortens the text that is read, which is safe.
const QUOTE_MARKERS: readonly RegExp[] = [
  /^\s*On [\s\S]{0,300}?wrote:\s*$/m,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}/im,
  /^\s*From:\s.{0,200}$/m,
  /^\s*_{5,}\s*$/m,
];

/** The sender's new text: everything before the first quote marker, without ">" lines. */
export function stripQuotedReply(body: string): string {
  let cut = body.length;
  for (const marker of QUOTE_MARKERS) {
    const at = body.search(marker);
    if (at !== -1 && at < cut) cut = at;
  }
  return body
    .slice(0, cut)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

/**
 * What triage and drafting read from a body: the sender's own text, or the start of the body when
 * stripping leaves nothing, capped at SENDER_TEXT_MAX_CHARS. Empty for an empty body.
 */
export function senderText(body: string | null | undefined, max = SENDER_TEXT_MAX_CHARS): string {
  if (!body || body.trim() === "") return "";
  const own = stripQuotedReply(body);
  return (own !== "" ? own : body.trim()).slice(0, max);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** True when `quote` appears word for word in `text` (whitespace runs compare equal). */
export function isVerbatim(quote: string | null | undefined, text: string): boolean {
  if (typeof quote !== "string") return false;
  const q = collapse(quote);
  return q.length >= 3 && collapse(text).includes(q);
}

/** A model-returned quote kept only when it is verbatim in `text`, capped; otherwise null. */
export function verbatimOrNull(quote: string | null | undefined, text: string, max = 300): string | null {
  if (!isVerbatim(quote, text)) return null;
  return collapse(quote as string).slice(0, max);
}

/** Words in a text. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Wording that asks to stop receiving mail. A decline with any of it is an opt-out, never a plain
// "not a fit".
const OPT_OUT_WORDING =
  /\b(?:unsubscribe|opt(?:ing)?[\s-]?out|remove me|take me off|stop (?:e-?mailing|contacting|writing|sending)|do not (?:contact|e-?mail|email)|don't (?:contact|e-?mail|email)|no more e-?mails?)\b/i;

/** True when the text asks to stop receiving mail. */
export function hasOptOutWording(text: string): boolean {
  return OPT_OUT_WORDING.test(text);
}

// Someone asking to see the product itself, not asking for a meeting about it.
const SEE_THE_PRODUCT =
  /\b(?:send|share|show|forward|provide)\b[^.?!\n]{0,60}\b(?:examples?|samples?|demos?|walk-?through|videos?|screenshots?|recording|one-?pager)\b|\b(?:can|could) (?:i|we) see\b|\b(?:like|love) to see\b|\bdo you have (?:an? )?(?:examples?|samples?|demo|videos?)\b|\bsee (?:it|the product) in action\b/i;

/** True when the sender's own text asks to see the product. */
export function wantsToSeeProduct(text: string): boolean {
  return SEE_THE_PRODUCT.test(text);
}

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\x00-\x1f\x7f]/g;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi;

/**
 * The most an operator message may carry of inbound text: control characters and links removed,
 * injection patterns redacted, whitespace collapsed, cut to PREVIEW_MAX_CHARS. Empty when nothing
 * usable is left.
 */
export function operatorPreview(text: string | null | undefined, max = PREVIEW_MAX_CHARS): string {
  if (!text) return "";
  const cleaned = collapse(redactInjection(text.replace(CONTROL, " ").replace(URL_TEXT, "[link]")).text);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 3)).replace(/\s+\S*$/, "")}...`;
}

/** Lower case, whitespace folded: for comparing a sent reply with its draft. */
export function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const CLOSING_LINE = /^(?:best|best regards|kind regards|regards|warm regards|warmly|thanks|thank you|many thanks|cheers|all the best)[,.!]?$/i;
const NAME_LINE = /^[A-Z][\w.'&-]*(?:\s+(?:[A-Z][\w.'&-]*|[|&]))*$/;
const MAX_SIGNATURE_LINES = 4;

/**
 * The text without its signature: everything from a "-- " delimiter line, then up to four trailing
 * closing or name lines. Text that is not plainly a signature stays, so it counts as an edit.
 */
export function stripSignature(text: string): string {
  let lines = text.split(/\r?\n/);
  const delimiter = lines.findIndex((line) => /^-- ?$/.test(line));
  if (delimiter >= 0) lines = lines.slice(0, delimiter);
  let dropped = 0;
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? "").trim();
    if (last === "") {
      lines.pop();
      continue;
    }
    const nameLike = NAME_LINE.test(last) && last.split(/\s+/).length <= 5 && !/\d/.test(last);
    if (dropped >= MAX_SIGNATURE_LINES || !(CLOSING_LINE.test(last) || nameLike)) break;
    lines.pop();
    dropped++;
  }
  return lines.join("\n");
}

/**
 * True when the message the operator sent is the draft as written: equal once quoted history is
 * stripped from the sent text and case and whitespace are folded, with or without the signature.
 */
export function sentMatchesDraft(sentText: string, draftBody: string): boolean {
  const sent = stripQuotedReply(sentText);
  if (normalizeForComparison(draftBody) === "") return false;
  if (normalizeForComparison(sent) === normalizeForComparison(draftBody)) return true;
  const draft = normalizeForComparison(stripSignature(draftBody));
  return draft !== "" && normalizeForComparison(stripSignature(sent)) === draft;
}

/** "Re: <subject>" for a reply on the thread: one line, at most 150 characters. */
export function replySubject(subject: string | null | undefined): string {
  const line = (subject ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const base = /^re:/i.test(line) ? line : `Re: ${line}`.trim();
  return (base === "Re:" ? "Re: your message" : base).slice(0, 150);
}

/** The sender as an operator message shows it: the address, normalized, and nothing else. */
export function senderLabel(senderEmail: string | null | undefined): string {
  return normalizeAddress(senderEmail) ?? "(an address that does not parse)";
}
