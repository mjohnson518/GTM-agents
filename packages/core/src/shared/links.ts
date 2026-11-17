// GTM-agents: the outbound definition of a link in text. A link is a full URL, a www. link, or a bare
// host that a mail client could turn into a link ("evil.example/offer"): any run of labels ending in
// a top-level label of 2 to 24 letters, with an optional path, that is not part of an address or of
// a longer URL. The outbound quality gate and the automatic-reply rules use it, and the
// self-improvement checks (learning/text.ts) catch everything it catches and more. Only functions
// are exported, so no caller can share a global pattern's state with another. Pure.

const LINK_PATTERN = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
const BARE_HOST_PATTERN = /(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()"']*)?(?![\w@-])/gi;

/** A link without the punctuation a sentence leaves after it. */
export const cleanLink = (url: string): string => url.replace(/[.,;:!?)\]]+$/, "");

/** The full URLs and www. links in a text, as written (trailing punctuation included). Pure. */
export function urlLinksIn(text: string): string[] {
  return text.match(LINK_PATTERN) ?? [];
}

/** The bare hosts in a text outside its full URLs, as written. Pure. */
export function bareHostsIn(text: string): string[] {
  return text.replace(LINK_PATTERN, " ").match(BARE_HOST_PATTERN) ?? [];
}

/** Every link in a text: full URLs, www. links, and bare hosts a mail client could turn into links. Pure. */
export function linksIn(text: string): string[] {
  return [...urlLinksIn(text).map(cleanLink), ...bareHostsIn(text).map(cleanLink)];
}

/** True when the text holds a link or a bare host. Pure. */
export function containsLink(text: string): boolean {
  return linksIn(text).length > 0;
}
