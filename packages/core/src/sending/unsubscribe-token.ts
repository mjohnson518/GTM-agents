// GTM-agents: signed unsubscribe tokens and the links built from them.
//
// A token is `<b64url(address)>.<b64url(HMAC-SHA256(key, "u1:" + address))>`, with the key from the
// UNSUBSCRIBE_SIGNING_KEY secret. It names one normalized address, never expires (an unsubscribe
// link must keep working), and cannot be forged or pointed at another address without the key.
// Verification recomputes the MAC and compares in constant time (Web Crypto's HMAC verify).
//
// A missing or short key fails closed: no token can be made, so the send function refuses every
// message rather than send one without a working unsubscribe link, and the /u/ routes answer 503.
import { normalizeAddress } from "./suppression.ts";

/** At least this many characters, for example the output of `openssl rand -hex 32`. */
export const UNSUBSCRIBE_KEY_MIN_LENGTH = 32;
export const UNSUBSCRIBE_TOKEN_MAX_LENGTH = 512;

const DOMAIN_SEPARATOR = "u1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** True when the key is set and long enough to sign with. */
export function isUsableSigningKey(key: string | undefined | null): key is string {
  return typeof key === "string" && key.length >= UNSUBSCRIBE_KEY_MIN_LENGTH;
}

function hmacKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** The token for `address`. Throws when the key is unusable or the address does not normalize. */
export async function signUnsubscribeToken(address: string, key: string | undefined): Promise<string> {
  if (!isUsableSigningKey(key)) throw new Error("UNSUBSCRIBE_SIGNING_KEY is not set (or shorter than 32 characters)");
  const normalized = normalizeAddress(address);
  if (!normalized) throw new TypeError("the address cannot be parsed");
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), encoder.encode(DOMAIN_SEPARATOR + normalized));
  return `${b64url(encoder.encode(normalized))}.${b64url(new Uint8Array(mac))}`;
}

/** The address a token names, or null when it is malformed, forged or the key is unusable. */
export async function verifyUnsubscribeToken(token: string, key: string | undefined): Promise<string | null> {
  if (!isUsableSigningKey(key) || typeof token !== "string" || token.length > UNSUBSCRIBE_TOKEN_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const addressBytes = fromB64url(parts[0] ?? "");
  const mac = fromB64url(parts[1] ?? "");
  if (!addressBytes || !mac || mac.length !== 32) return null;
  let address: string;
  try {
    address = decoder.decode(addressBytes);
  } catch {
    return null;
  }
  if (normalizeAddress(address) !== address) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), mac, encoder.encode(DOMAIN_SEPARATOR + address));
    return ok ? address : null;
  } catch {
    return null;
  }
}

/**
 * The deployment's public origin from AGENT_BASE_URL, or null when it is unset or not https (plain
 * http is accepted only for localhost, for local development).
 */
export function publicOrigin(baseUrl: string | undefined | null): string | null {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** The one-click unsubscribe link for a token. */
export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin}/u/${token}`;
}
