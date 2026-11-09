// GTM-agents SDK: the hashing and HMAC primitives the event contract uses, on WebCrypto only, so
// they run unchanged in Node 20 and later, Bun, Deno, Workers and other edge runtimes.

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Lowercase hex HMAC-SHA256 of `message` under `secret`, both UTF-8. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * The hash `user.deleted` carries instead of an address: SHA-256 of the address lowercased and
 * trimmed. `Ada@Acme.example ` and `ada@acme.example` hash the same.
 */
export function emailSha256(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

/**
 * Compare two strings without revealing where they differ or how long the expected one is: both
 * are hashed to 32 bytes and every byte is folded into one accumulator. An empty expected value
 * never matches.
 */
export async function timingSafeEqual(provided: string, expected: string): Promise<boolean> {
  if (typeof provided !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(provided)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
