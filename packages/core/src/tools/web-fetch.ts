// GTM-agents: the web_fetch tool: read one public web page as text.
//
// Its class (security/tool-classes.ts) is full taint, gate never, egress url: any session may read
// a page, and the session is fully tainted afterwards, which refuses every write that follows. The
// dispatcher has already validated the URL in the input; this handler repeats what a URL check
// cannot do from the input alone:
//   - it requests only the normalized URL that validateUrl returns, never the raw string, and
//     refuses anything that is not a full http(s) URL instead of adding a scheme to it;
//   - it follows redirects by hand (redirect: "manual"), validating every hop, up to five;
//   - it reads at most MAX_BYTES of the body and accepts only text/html and text/plain;
//   - it reduces HTML to text with a small, predictable converter. The dispatcher then caps,
//     redacts and fences the result.
// A hostname that resolves to a private address is beyond what any URL check can see; the Workers
// runtime does not route fetches to private networks, and the egress checks keep data from being
// carried out in the URL itself.
import { validateUrl } from "../security/url-validator.ts";
import type { ToolHandler } from "../runtime/dispatcher.ts";

export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_MAX_BYTES = 512 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
const ACCEPTED_TYPES = ["text/html", "text/plain"];

export interface WebFetchOptions {
  fetch?: typeof fetch;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** Sent as the User-Agent header. */
  userAgent?: string;
}

export const webFetchDefinition = {
  name: "web_fetch",
  description:
    "Fetch one public web page and return its text. Use a full URL starting with https:// or http://. After this runs, the session has read untrusted text, and tools that create or change records are refused until the operator sends /clean.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "The full URL of the page, including https://" } },
    required: ["url"],
    additionalProperties: false,
  },
} as const;

/** Read a body stream up to `max` bytes. Returns the bytes and whether more were left unread. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), cut: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      size += room;
      cut = true;
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  if (cut) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, cut };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "...", copy: "(c)", reg: "(R)", trade: "(TM)",
  mdash: "-", ndash: "-", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: "*", middot: "*",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to readable text: drop scripts, styles and comments, turn block boundaries into line breaks,
 * strip the remaining tags, decode entities and collapse whitespace. It is deliberately simple; the
 * output is data for the model, fenced by the dispatcher, not markup to render.
 */
/**
 * Remove every span from `open` to the next `close` (case-insensitive), in one linear pass. An
 * unclosed span drops the rest of the text. Lazy regexes would be quadratic on hostile pages.
 */
function stripSpans(text: string, open: string, close: string): string {
  const lower = text.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start < 0) return out + text.slice(from);
    out += `${text.slice(from, start)} `;
    const end = lower.indexOf(close, start + open.length);
    if (end < 0) return out;
    from = end + close.length;
  }
}

const DROPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "head", "iframe", "object"];

export function htmlToText(html: string): { title: string; text: string } {
  const lowerHtml = html.toLowerCase();
  const titleStart = lowerHtml.indexOf("<title");
  const titleOpen = titleStart >= 0 ? lowerHtml.indexOf(">", titleStart) : -1;
  const titleEnd = titleOpen >= 0 ? lowerHtml.indexOf("</title", titleOpen) : -1;
  const title = titleEnd > titleOpen ? decodeEntities(html.slice(titleOpen + 1, Math.min(titleEnd, titleOpen + 1 + 1000))).replace(/\s+/g, " ").trim() : "";
  let stripped = stripSpans(html, "<!--", "-->");
  for (const tag of DROPPED_ELEMENTS) stripped = stripSpans(stripped, `<${tag}`, `</${tag}`);
  const text = stripped
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt|dl|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const lines = decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v\r\u00a0]+/g, " ").trim())
    .filter((l) => l.length > 0);
  return { title, text: lines.join("\n") };
}

function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Validate a URL for fetching: a full http(s) URL that passes validateUrl. Returns the normalized URL. */
export function fetchableUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("url must be a string");
  const trimmed = raw.trim();
  // A string without a scheme is refused, never repaired: "169.254.169.254/latest" must not become
  // an http request because the dispatcher only checks strings that already parse as URLs.
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("url must be a full URL starting with https:// or http://");
  const check = validateUrl(trimmed);
  if (!check.ok) throw new Error(`the URL was refused: ${check.reason}`);
  return check.url;
}

export function createWebFetchHandler(options: WebFetchOptions = {}): ToolHandler {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const maxRedirects = options.maxRedirects ?? WEB_FETCH_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? WEB_FETCH_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  return async (input, ctx) => {
    let url = fetchableUrl(input.url);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      response = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "text/html, text/plain;q=0.9", ...(options.userAgent ? { "user-agent": options.userAgent } : {}) },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`the page answered HTTP ${response.status} without a Location header`);
      if (hop === maxRedirects) throw new Error(`the page redirected more than ${maxRedirects} times`);
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new Error("the page redirected to a location that does not parse");
      }
      const check = validateUrl(next);
      if (!check.ok) throw new Error(`the page redirected to a refused address: ${check.reason}`);
      url = check.url;
      response = null;
    }
    if (!response) throw new Error("the page could not be fetched");
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`the page answered HTTP ${response.status}`);
    }
    const type = mediaType(response.headers.get("content-type"));
    if (!ACCEPTED_TYPES.includes(type)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`the page is ${type || "of an unknown type"}; only text/html and text/plain are read`);
    }
    const { bytes, cut } = await readCapped(response.body, maxBytes);
    const raw = new TextDecoder("utf-8").decode(bytes);
    const page = type === "text/html" ? htmlToText(raw) : { title: "", text: raw.trim() };
    const header = [`Page: ${url}`, ...(page.title ? [`Title: ${page.title}`] : []), ...(cut ? [`(only the first ${Math.round(maxBytes / 1024)} KB were read)`] : [])];
    return `${header.join("\n")}\n\n${page.text || "[the page has no readable text]"}`;
  };
}
