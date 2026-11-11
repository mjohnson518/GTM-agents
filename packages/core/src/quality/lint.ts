// GTM-agents: the content lint every outbound message passes, inside the send function and inside
// the quality gate.
//
// It is pure and needs no network. Text is normalized (NFKC) before checking. Findings are:
//   - blocks: the message is never sent (hidden characters, an empty subject or body, a placeholder
//     left unfilled, a link shortener, HTML, a house-rule character such as an em or en dash);
//   - warnings: a person should look (spam phrases, a shouting or over-punctuated subject, more
//     than one exclamation mark, a body over 200 words, and CLICHE: the stock phrases machine-written
//     copy leans on, such as hoping the message finds them well or a nudge with nothing new in it).
// CLICHE is always reported here; the quality gate maps it to a hold only while
// quality:cliche_lint_enabled is on, and every other reader of warnings ignores it with the flag off.
// The quality gate adds the checks that need context (recipient, links, claims, length by kind).

export interface LintFinding {
  code: string;
  detail: string;
}

export interface LintResult {
  blocks: LintFinding[];
  warnings: LintFinding[];
}

const char = (...codes: number[]) => String.fromCharCode(...codes);

// Zero-width and direction characters, the BOM, soft hyphen, and other invisible formatting.
const HIDDEN = new RegExp(`[${char(0x00ad)}${char(0x200b)}-${char(0x200f)}${char(0x202a)}-${char(0x202e)}${char(0x2060)}-${char(0x2064)}${char(0x2066)}-${char(0x2069)}${char(0xfeff)}]`);
const HOUSE_RULE = new RegExp(`[${char(0x2013)}${char(0x2014)}]`);
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const PLACEHOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\{\{[^}]*\}\}/, "an unfilled {{variable}}"],
  [/\{[a-z_][a-z0-9_]*\}/i, "an unfilled {variable}"],
  [/\[(?:INSERT|YOUR|NAME|COMPANY|FIRST[ _]NAME)[^\]]*\]/i, "a bracketed placeholder"],
  [/<%=?|%>/, "template tags"],
  [/\{%|%\}/, "template tags"],
  [/\$\{[^}]*\}/, "a template literal"],
  [/%s\b|%d\b/, "a printf placeholder"],
  [/\b(?:TODO|TBD|lorem ipsum)\b/i, "a draft marker"],
];

const SHORTENERS = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc)\//i;
const HTML = /<\s*\/?\s*(?:a|p|br|div|span|img|table|html|body|b|i|strong|em|font)\b[^>]*>/i;

const SPAM_PHRASES = [
  /\bact now\b/i,
  /\blimited time\b/i,
  /\b100% free\b/i,
  /\bguaranteed\b/i,
  /\brisk[- ]free\b/i,
  /\bno obligation\b/i,
  /\bclick here\b/i,
  /\bbuy now\b/i,
  /\bspecial promotion\b/i,
  /\bwinner\b/i,
];

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Stock phrases of machine-written outreach, whole words, case-insensitive. Each one is a hold, not a
 * block: a person may decide the phrase is fine where it stands.
 */
const CLICHE_PATTERNS: readonly RegExp[] = [
  // The "hope this finds you well" opener, in its common shapes.
  /\b(?:hope|trust)\s+(?:this|that|my|the|you)\b[^.!?\n]{0,30}?\bfinds you\b/i,
  /\bhope you(?:['\u2019]re| are)\s+(?:well|doing well)\b/i,
  /\bsynerg(?:y|ies)\b/i,
  /\bleverag(?:e|es|ed|ing)\b/i,
  /\bunlock(?:s|ing)?\b/i,
  /\bgame[- ]chang(?:er|ers|ing)\b/i,
  /\bcutting[- ]edge\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\belevate your\b/i,
  // "As a VP of Engineering at Globex, you ...": flattery built from the contact's record.
  /\bas an? [^,.\n]{2,60}? at [^,.\n]{2,60},\s*you\b/i,
];

/** A nudge that carries nothing new. Flagged only when it is the whole message. */
const NUDGE = /\b(?:circling back|just checking in|bumping this|following up)\b/i;
const NUDGE_MAX_WORDS = 15;
const GREETING_LINE = /^(?:hi|hello|hey|dear)\b[^\n]{0,40}$/i;
const SIGNOFF_LINE = /^(?:thanks|thank you|best|cheers|regards|best regards|kind regards|warmly|talk soon)[,.!]?$/i;
const NAME_LINE = /^[\p{L}][\p{L}' .-]{0,40}$/u;

function nudgeOnly(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length > 0 && GREETING_LINE.test(lines[0] ?? "")) lines.shift();
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? "";
    if (NUDGE.test(last) || !(SIGNOFF_LINE.test(last) || (NAME_LINE.test(last) && words(last) <= 3))) break;
    lines.pop();
  }
  const rest = lines.join(" ");
  return NUDGE.test(rest) && words(rest) <= NUDGE_MAX_WORDS;
}

const QUICK_QUESTION = /\bquick question\b/gi;

/** The cliches in a message, as CLICHE warnings. Text is already normalized. */
function cliches(subject: string, body: string): LintFinding[] {
  const all = `${subject}\n${body}`;
  const found: LintFinding[] = [];
  for (const pattern of CLICHE_PATTERNS) {
    const hit = pattern.exec(all);
    if (hit) found.push({ code: "CLICHE", detail: hit[0] });
  }
  if (nudgeOnly(body)) found.push({ code: "CLICHE", detail: "a nudge with nothing new in it" });
  for (const hit of all.matchAll(QUICK_QUESTION)) {
    const after = all.slice((hit.index ?? 0) + hit[0].length, (hit.index ?? 0) + hit[0].length + 200);
    if (!after.includes("?")) {
      found.push({ code: "CLICHE", detail: `"${hit[0]}" with no question after it` });
      break;
    }
  }
  return found;
}

export function lintOutbound(content: { subject: string; body: string }): LintResult {
  const subject = (content.subject ?? "").normalize("NFKC");
  const body = (content.body ?? "").normalize("NFKC");
  const blocks: LintFinding[] = [];
  const warnings: LintFinding[] = [];
  const all = `${subject}\n${body}`;

  if (subject.trim().length === 0) blocks.push({ code: "EMPTY_SUBJECT", detail: "the subject is empty" });
  if (body.trim().length === 0) blocks.push({ code: "EMPTY_BODY", detail: "the body is empty" });
  if (HIDDEN.test(all) || CONTROL.test(all)) blocks.push({ code: "HIDDEN_CHARACTER", detail: "invisible or control characters" });
  if (HOUSE_RULE.test(all)) blocks.push({ code: "HOUSE_RULE_CHARACTER", detail: "an em or en dash" });
  for (const [pattern, what] of PLACEHOLDERS) {
    if (pattern.test(all)) blocks.push({ code: "PLACEHOLDER_LEAK", detail: what });
  }
  if (SHORTENERS.test(all)) blocks.push({ code: "URL_SHORTENER", detail: "a link shortener" });
  if (HTML.test(all)) blocks.push({ code: "HTML", detail: "HTML markup; outbound mail is plain text" });

  for (const pattern of SPAM_PHRASES) {
    const hit = pattern.exec(all);
    if (hit) warnings.push({ code: "SPAM_PHRASE", detail: hit[0] });
  }
  const letters = subject.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) warnings.push({ code: "SUBJECT_CAPS", detail: "the subject is mostly capitals" });
  if (/[!?]{2,}/.test(subject)) warnings.push({ code: "SUBJECT_PUNCTUATION", detail: "the subject is over-punctuated" });
  if ((all.match(/!/g) ?? []).length > 1) warnings.push({ code: "EXCLAMATIONS", detail: "more than one exclamation mark" });
  if (words(body) > 200) warnings.push({ code: "BODY_TOO_LONG", detail: `${words(body)} words` });
  warnings.push(...cliches(subject, body));

  return { blocks, warnings };
}
