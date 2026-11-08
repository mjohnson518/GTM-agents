// GTM-agents: plain text from an HTML body, for messages that carry no text/plain part.
//
// InboxProvider adapters prefer text/plain; when a message has only HTML, they derive text with
// htmlToText so every adapter gives core the same kind of body: scripts, styles, comments and the
// head removed, block ends turned into line breaks, every other tag dropped, entities decoded and
// whitespace tidied. The result is still untrusted text.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : " ";
}

/** Plain text from HTML. */
export function htmlToText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return "";
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, entity: string) => {
      if (/^#x/i.test(entity)) return codePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return codePoint(parseInt(entity.slice(1), 10));
      return ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
