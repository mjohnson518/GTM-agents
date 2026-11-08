// GTM-agents: injection detection and redaction for untrusted text.
//
// Detection runs on a normalized view of the text, so the usual disguises do not hide an
// instruction. The view drops zero-width and bidirectional control characters, decodes HTML
// numeric entities and a few named ones, folds compatibility forms (fullwidth and mathematical
// letters), strips accents, maps a table of Cyrillic and Greek lookalikes to Latin, decodes Unicode
// tag characters (invisible ASCII), and collapses whitespace.
//
// Redaction maps each match back to the original text and replaces exactly that span with
// [REDACTED]. Every character outside a match is kept as it was: the normalized view is only used
// to find matches and is never returned.
//
// The patterns are a speed bump, not the control. The control is the action gate: once a session
// has read untrusted text, the tools that could act on an injected instruction are refused. The
// list leaves out phrasings that ordinary sales replies use ("forward this to", "cc:"), because
// redacting those would hide real buying signals from the reader.

export const REDACTED = "[REDACTED]";

const INJECTION_PATTERNS: readonly RegExp[] = [
  // Attempts to replace the instructions.
  /\bSYSTEM\s*(?:PROMPT|OVERRIDE|INSTRUCTIONS?|MESSAGE)\b/i,
  /\b(?:IGNORE|DISREGARD)\s+(?:ALL\s+)?(?:THE\s+|YOUR\s+)?(?:PREVIOUS|PRIOR|ABOVE|EARLIER|ORIGINAL)\s+(?:INSTRUCTIONS?|RULES?|PROMPTS?|DIRECTIONS?)\b/i,
  /\bFORGET\s+(?:ALL\s+)?(?:THE\s+)?(?:PREVIOUS|PRIOR|YOUR)\s+(?:INSTRUCTIONS?|RULES?|TRAINING)\b/i,
  /\bDO\s+NOT\s+FOLLOW\s+(?:YOUR|THE)\s+(?:PREVIOUS|ORIGINAL)\b/i,
  /\bOVERRIDE\s*:/i,
  /\bJAILBREAK\b/i,
  /\bDAN\s+MODE\b/i,
  // Role changes.
  /\bYOU\s+ARE\s+NOW\b/i,
  /\bNEW\s+INSTRUCTIONS?\s*:/i,
  /\bACT\s+AS\s+(?:IF\s+)?YOU\s+ARE\b/i,
  /\bFROM\s+NOW\s+ON[\s,]+YOU\b/i,
  /\bYOUR\s+NEW\s+(?:ROLE|TASK|INSTRUCTIONS?|PURPOSE)\b/i,
  /\b(?:SWITCH\s+TO|ENTER|ENABLE|ACTIVATE)\s+(?:THE\s+)?(?:DEVELOPER|DEBUG|GOD|ADMIN|ROOT|SUDO|UNRESTRICTED|UNFILTERED|JAILBREAK)\s+MODE\b/i,
  /\bYOU\s+MUST\s+(?:NOW|ALWAYS|IMMEDIATELY)\b/i,
  /\bPRETEND\s+(?:YOU|TO\s+BE)\b/i,
  /\bROLE\s*PLAY\s+AS\b/i,
  /\bIMAGINE\s+YOU\s+ARE\b/i,
  // Chat-template and role markers.
  /<\|?\s*(?:im_start|im_end|endoftext|system)\s*\|?>/i,
  /\[\/?INST\]/i,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
  // Bulk data movement.
  /\bSEND\s+(?:ALL|THE)\s+(?:DATA|INFO|INFORMATION|CONTACTS?|PIPELINE|LISTS?|DETAILS?)\s+(?:TO|VIA)\b/i,
  /\bEXPORT\s+(?:ALL|THE)\s+.{0,30}\s+(?:TO|AND\s+SEND)\b/i,
  /\bUPDATED?\s+GUIDELINES?\s*:/i,
  /\bFOLLOW\s+THESE\s+(?:UPDATED|NEW|REVISED)\b/i,
  // Probing the system's boundaries.
  /\bWHAT\s+(?:IS|ARE)\s+YOUR\s+(?:SYSTEM\s+)?(?:PROMPT|INSTRUCTIONS?|RULES?)\b/i,
  /\bREVEAL\s+(?:YOUR|THE)\s+(?:SYSTEM|ORIGINAL|FULL)\b/i,
  /\bSHOW\s+ME\s+(?:YOUR|THE)\s+(?:SYSTEM|ORIGINAL|FULL)\s*(?:PROMPT|INSTRUCTIONS?)\b/i,
  /\bLIST\s+(?:ALL\s+)?(?:YOUR|AVAILABLE)\s+TOOLS?\b/i,
  /\bWHAT\s+TOOLS?\s+(?:DO\s+YOU|CAN\s+YOU|ARE)\b/i,
  // Memory poisoning.
  /\bSTORE\s+(?:THIS|THE\s+FOLLOWING)\s+(?:IN|AS)\s+(?:YOUR\s+)?MEMORY\b/i,
  /\bADD\s+(?:THIS\s+)?TO\s+(?:YOUR\s+)?MEMORY\b/i,
  /\bUPDATE\s+(?:YOUR\s+)?MEMORY\b/i,
];

// Characters that render as nothing (or only change direction) and so can hide inside a word.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian selectors and vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner, direction marks
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidirectional isolates
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0x1d173, 0x1d17a], // musical formatting controls
  [0xe0000, 0xe001f], // tag controls
  [0xe007f, 0xe007f], // cancel tag
  [0xe0100, 0xe01ef], // variation selectors supplement
];

// Unicode tag characters U+E0020 to U+E007E mirror printable ASCII and are invisible.
const TAG_FIRST = 0xe0020;
const TAG_LAST = 0xe007e;
const TAG_OFFSET = 0xe0000;

// Cyrillic and Greek letters that look like Latin ones. Used for detection only.
const LOOKALIKES: ReadonlyMap<number, string> = new Map([
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"], [0x0443, "y"],
  [0x0445, "x"], [0x0455, "s"], [0x0456, "i"], [0x0458, "j"], [0x04bb, "h"], [0x04cf, "l"],
  [0x0501, "d"], [0x051b, "q"], [0x051d, "w"], [0x0261, "g"], [0x0131, "i"], [0x0237, "j"],
  [0x0405, "S"], [0x0406, "I"], [0x0408, "J"], [0x0410, "A"], [0x0412, "B"], [0x0415, "E"],
  [0x041a, "K"], [0x041c, "M"], [0x041d, "H"], [0x041e, "O"], [0x0420, "P"], [0x0421, "C"],
  [0x0422, "T"], [0x0423, "Y"], [0x0425, "X"],
  [0x03b1, "a"], [0x03b3, "y"], [0x03b5, "e"], [0x03b9, "i"], [0x03ba, "k"], [0x03bd, "v"],
  [0x03bf, "o"], [0x03c1, "p"], [0x03c4, "t"], [0x03c5, "u"], [0x03c7, "x"],
  [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"], [0x0399, "I"],
  [0x039a, "K"], [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03a1, "P"], [0x03a4, "T"],
  [0x03a5, "Y"], [0x03a7, "X"],
]);

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["shy", ""], ["zwj", ""], ["zwnj", ""], ["lrm", ""], ["rlm", ""],
]);

const ENTITY = /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,15});)/y;
const COMBINING_MARK = /\p{M}/u;
const WHITESPACE = /\s/;

function isInvisible(cp: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

function foldCodePoint(cp: number): string {
  if (isInvisible(cp)) return "";
  if (cp >= TAG_FIRST && cp <= TAG_LAST) return String.fromCharCode(cp - TAG_OFFSET);
  const ch = String.fromCodePoint(cp);
  if (WHITESPACE.test(ch)) return " ";
  let out = "";
  for (const part of ch.normalize("NFKD")) {
    if (COMBINING_MARK.test(part)) continue;
    out += LOOKALIKES.get(part.codePointAt(0) ?? 0) ?? part;
  }
  return out;
}

function decodeEntity(match: RegExpExecArray): string | null {
  const [, dec, hex, name] = match;
  if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? null;
  const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
  if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return foldCodePoint(cp);
}

/** The normalized view of `text`, with the original span behind every unit of it. */
interface NormalizedView {
  text: string;
  starts: number[];
  ends: number[];
}

function normalizedView(text: string): NormalizedView {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lastWasSpace = false;
  const emit = (folded: string, start: number, end: number) => {
    for (const char of folded) {
      const space = WHITESPACE.test(char);
      if (space && lastWasSpace) continue;
      const piece = space ? " " : char;
      for (let k = 0; k < piece.length; k++) {
        starts.push(start);
        ends.push(end);
      }
      parts.push(piece);
      lastWasSpace = space;
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x26) {
      ENTITY.lastIndex = i;
      const match = ENTITY.exec(text);
      const decoded = match ? decodeEntity(match) : null;
      if (match && decoded !== null) {
        emit(decoded, i, i + match[0].length);
        i += match[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    emit(foldCodePoint(cp), i, i + width);
    i += width;
  }
  return { text: parts.join(""), starts, ends };
}

/** The normalized text that detection runs on. Exported for tests and diagnostics. */
export function normalizeForDetection(text: string): string {
  return normalizedView(text).text;
}

function globalClone(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/** Spans of `text` (start inclusive, end exclusive, in UTF-16 units) whose normalized form matches, merged. */
function matchSpans(text: string, patterns: readonly RegExp[]): { spans: Array<[number, number]>; count: number } {
  const view = normalizedView(text);
  const raw: Array<[number, number]> = [];
  for (const pattern of patterns) {
    for (const m of view.text.matchAll(globalClone(pattern))) {
      if (m[0].length === 0) continue;
      const start = view.starts[m.index];
      const end = view.ends[m.index + m[0].length - 1];
      if (start !== undefined && end !== undefined) raw.push([start, end]);
    }
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const spans: Array<[number, number]> = [];
  for (const span of raw) {
    const last = spans.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else spans.push([span[0], span[1]]);
  }
  return { spans, count: raw.length };
}

function replaceSpans(text: string, spans: ReadonlyArray<readonly [number, number]>, replacement: string): string {
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * Replace every span of `text` whose normalized form matches `pattern`, keeping all other
 * characters exactly. Used to remove disguised spellings of a marker, such as the fence's tag name.
 */
export function replaceNormalized(text: string, pattern: RegExp, replacement: string): string {
  const { spans } = matchSpans(text, [pattern]);
  return spans.length === 0 ? text : replaceSpans(text, spans, replacement);
}

const patternsWith = (toolNamePattern: RegExp | null | undefined) => (toolNamePattern ? [...INJECTION_PATTERNS, toolNamePattern] : INJECTION_PATTERNS);

/** How many injection patterns (and registered tool names) appear in `text`. */
export function detectInjection(text: string, toolNamePattern?: RegExp | null): number {
  return matchSpans(text, patternsWith(toolNamePattern)).count;
}

/** Replace every matched span with [REDACTED], keeping all other characters exactly. */
export function redactInjection(text: string, toolNamePattern?: RegExp | null): { text: string; count: number } {
  const { spans, count } = matchSpans(text, patternsWith(toolNamePattern));
  return spans.length === 0 ? { text, count: 0 } : { text: replaceSpans(text, spans, REDACTED), count };
}
