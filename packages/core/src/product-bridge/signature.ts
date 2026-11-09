// GTM-agents: the product bridge's signatures (docs/EVENT-CONTRACT.md).
//
//   - Push (host to agent): X-Signature is `sha256=<hex HMAC-SHA256(PRODUCT_WEBHOOK_SECRET, raw body)>`
//     over the exact bytes received, compared in constant time.
//   - Pull (agent to host): each read carries X-Timestamp (unix seconds) and X-Signature over
//     METHOD + "\n" + PATH + "\n" + SORTED_QUERY + "\n" + TIMESTAMP, where SORTED_QUERY is the query
//     string with keys sorted bytewise and values percent-encoded as sent.
// The published test vectors check both against the SDK (tests/contract/sdk-vectors.test.ts).
import { constantTimeEqual } from "../http/auth.ts";

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when `header` is the push signature of `body` under `secret`. An empty secret never verifies. */
export async function pushSignatureValid(body: string, header: string | null | undefined, secret: string | undefined): Promise<boolean> {
  if (typeof secret !== "string" || secret.length === 0) return false;
  const provided = (header ?? "").trim().toLowerCase();
  if (!provided.startsWith("sha256=")) return false;
  return constantTimeEqual(provided, `sha256=${await hmacHex(secret, body)}`);
}

function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** The read's canonical string for a URL as it will be requested. */
export function readCanonicalString(method: string, url: URL, timestamp: number): string {
  const key = (pair: string) => (pair.includes("=") ? pair.slice(0, pair.indexOf("=")) : pair);
  const query = url.search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair, index) => ({ pair, index }))
    .sort((a, b) => compareBytes(key(a.pair), key(b.pair)) || a.index - b.index)
    .map((p) => p.pair)
    .join("&");
  return [method.toUpperCase(), url.pathname, query, String(timestamp)].join("\n");
}

/** The X-Timestamp and X-Signature headers for a signed read. */
export async function readSignatureHeaders(input: { secret: string; method: string; url: URL; timestamp: number }): Promise<Record<string, string>> {
  if (input.secret.length === 0) throw new TypeError("a signed read needs PRODUCT_READ_SECRET");
  return { "X-Timestamp": String(input.timestamp), "X-Signature": `sha256=${await hmacHex(input.secret, readCanonicalString(input.method, input.url, input.timestamp))}` };
}
