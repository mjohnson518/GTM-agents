// GTM-agents: URL validation (server-side request forgery) and egress checks.
//
// validateUrl decides whether a URL may be fetched at all, at any taint:
//   - http and https only, at most 2,048 characters, no credentials in the URL;
//   - no localhost, single-label names or internal suffixes (.local, .internal, .home.arpa ...);
//   - no private, loopback, link-local, carrier-grade NAT, benchmark, documentation, multicast or
//     reserved IPv4 ranges;
//   - IPv6 literals only from global unicast space (2000::/3), and not the documentation, Teredo or
//     6to4 ranges, which covers loopback, unique local (fc00::/7), link-local (fe80::/10),
//     multicast (ff00::/8) and IPv4-mapped forms.
// The URL parser normalizes decimal, octal and hexadecimal IPv4 spellings to dotted form first, so
// those spellings are checked as the address they name. A hostname that resolves to a private
// address is outside what a URL check can see. Fetch handlers request the normalized URL that
// validateUrl returns, never the raw input, and validate every redirect hop.
//
// The egress checks apply at full taint, when the session holds raw untrusted text and an injected
// instruction may try to carry data out through a request:
//   - tools with egress "url" may not request a URL carrying an email address, an encoded blob, a
//     query string over 120 characters, a hostname label over 40 characters or more than 6 labels;
//   - tools with egress "query" or "url" may not send any input string carrying an email address
//     or an encoded blob.
// These are speed bumps. The control is that full taint refuses every send, write and spend.

export const URL_MAX_LENGTH = 2048;
export const QUERY_MAX_LENGTH = 120;
export const HOST_LABEL_MAX_LENGTH = 40;
export const HOST_LABELS_MAX = 6;

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const INTERNAL_SUFFIXES = ["localhost", "local", "internal", "localdomain", "home.arpa", "lan", "corp", "home", "intranet"];

// [network, prefix length]
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function ipv4ToNumber(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inIpv4Range(address: number, network: string, prefix: number): boolean {
  const base = ipv4ToNumber(network) ?? 0;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(base / size);
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function parseIpv6(text: string): number[] | null {
  let host = text;
  const tail: number[] = [];
  const lastColon = host.lastIndexOf(":");
  if (lastColon < 0) return null;
  const last = host.slice(lastColon + 1);
  if (last.includes(".")) {
    // An embedded IPv4 address supplies the last two groups.
    const n = ipv4ToNumber(last);
    if (n === null) return null;
    tail.push(Math.floor(n / 65536), n % 65536);
    host = host.slice(0, lastColon + 1);
    if (!host.endsWith("::")) host = host.slice(0, -1);
  }
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? 8 - known : 0).fill("0"), ...rest];
  const values: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    values.push(Number.parseInt(g, 16));
  }
  return [...values, ...tail];
}

function ipv6Allowed(groups: readonly number[]): boolean {
  const [a = 0, b = 0] = groups;
  if (a < 0x2000 || a > 0x3fff) return false; // outside global unicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2001 && b === 0x0000) return false; // Teredo
  if (a === 0x2002) return false; // 6to4
  if (a === 0x3fff && b <= 0x0fff) return false; // documentation
  return true;
}

/** Whether `url` may be fetched. Returns the parsed, normalized URL on success. */
export function validateUrl(url: string): UrlCheck {
  if (typeof url !== "string" || url.trim().length === 0) return { ok: false, reason: "a URL is required" };
  if (url.length > URL_MAX_LENGTH) return { ok: false, reason: `the URL is longer than ${URL_MAX_LENGTH} characters` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "the URL does not parse" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `the ${parsed.protocol.replace(/:$/, "")} scheme is not allowed` };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "URLs with credentials are not allowed" };

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) return { ok: false, reason: "the URL has no host" };

  if (host.startsWith("[")) {
    const groups = host.endsWith("]") ? parseIpv6(host.slice(1, -1)) : null;
    if (!groups || !ipv6Allowed(groups)) return { ok: false, reason: `${host} is not a public address` };
    return { ok: true, url: parsed.toString() };
  }

  const v4 = ipv4ToNumber(host);
  if (v4 !== null) {
    if (BLOCKED_IPV4.some(([net, prefix]) => inIpv4Range(v4, net, prefix))) {
      return { ok: false, reason: `${host} is not a public address` };
    }
    return { ok: true, url: parsed.toString() };
  }

  if (!host.includes(".")) return { ok: false, reason: `${host} is a single-label (internal) hostname` };
  if (INTERNAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return { ok: false, reason: `${host} is an internal hostname` };
  }
  return { ok: true, url: parsed.toString() };
}

const EMAIL_LIKE = /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/i;
// 64 or more characters of base64, base64url or hex with no separators (not even a slash): an
// encoded blob, not a slug or a path.
const ENCODED_BLOB = /[A-Za-z0-9+=_]{64,}/;

function decodeSafely(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Why a string looks like it carries data out (an email address or encoded blob), or null. */
export function carriedDataReason(text: string): string | null {
  const decoded = decodeSafely(text);
  if (EMAIL_LIKE.test(decoded) || EMAIL_LIKE.test(text)) return "an email address";
  if (ENCODED_BLOB.test(decoded)) return "an encoded blob";
  return null;
}

/** Why `url` looks like it carries data out through its host, path, query or fragment, or null. */
export function urlExfiltrationReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const labels = parsed.hostname.replace(/\.+$/, "").split(".");
  if (labels.length > HOST_LABELS_MAX) return `a hostname with ${labels.length} labels (at most ${HOST_LABELS_MAX})`;
  if (labels.some((l) => l.length > HOST_LABEL_MAX_LENGTH)) {
    return `a hostname label over ${HOST_LABEL_MAX_LENGTH} characters`;
  }
  const query = parsed.search.replace(/^\?/, "");
  if (query.length > QUERY_MAX_LENGTH) return `a query string of ${query.length} characters (at most ${QUERY_MAX_LENGTH})`;
  const carried = carriedDataReason(`${parsed.pathname}?${query}${parsed.hash}`);
  return carried ? `${carried} in the URL` : null;
}

const MAX_DEPTH = 6;
const MAX_STRINGS = 2000;

/**
 * Every string inside `input`, searched through arrays and objects. Returns null when the input
 * is nested deeper than six levels or holds more than 2,000 strings, which callers treat as a
 * refusal rather than a partial scan.
 */
export function collectStrings(input: unknown): string[] | null {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      out.push(value);
      return out.length <= MAX_STRINGS;
    }
    if (value === null || typeof value !== "object") return true;
    if (depth >= MAX_DEPTH) return false;
    const children = Array.isArray(value) ? (value as unknown[]) : Object.values(value);
    return children.every((child) => walk(child, depth + 1));
  };
  return walk(input, 0) ? out : null;
}

// Schemes a fetch implementation might act on. Strings are parsed exactly as fetch parses them
// (leading control characters stripped, tabs removed, backslashes and missing slashes repaired),
// so "http:/host", "HTTP:host" and "ht\ttp://host" are all found.
const FETCHABLE = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);

function parseFetchable(text: string): URL | null {
  try {
    const url = new URL(text);
    return FETCHABLE.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** The strings in `input` that parse as URLs a fetch could act on, or null when the input cannot be scanned. */
export function findUrls(input: unknown): string[] | null {
  const strings = collectStrings(input);
  return strings ? strings.filter((s) => parseFetchable(s) !== null) : null;
}

export type EgressCheck = { ok: true } | { ok: false; reason: string };

/** At full taint: whether a tool with this egress may be called with `input`. */
export function checkEgress(egress: "url" | "query", input: unknown): EgressCheck {
  const strings = collectStrings(input);
  if (!strings) return { ok: false, reason: "the input is too large or too deeply nested to check" };
  for (const s of strings) {
    const url = egress === "url" ? parseFetchable(s) : null;
    if (url) {
      const reason = urlExfiltrationReason(url.href);
      if (reason) return { ok: false, reason: `the URL carries ${reason}` };
    }
    const carried = carriedDataReason(s);
    if (carried) return { ok: false, reason: `the ${egress === "url" ? "input" : "query"} carries ${carried}` };
  }
  return { ok: true };
}
