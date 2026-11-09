// GTM-agents: Cloudflare Access verification for the operator dashboard.
//
// Cloudflare Access sits in front of /admin and /ws and adds a signed application token to every
// request it lets through, in the Cf-Access-Jwt-Assertion header. The Worker never trusts that the
// header came from Access: it verifies the token itself, with WebCrypto only:
//   1. the token is a compact JWS whose header names RS256 and a key id;
//   2. the key is one of the team's signing keys, fetched from
//      https://<team domain>/cdn-cgi/access/certs and kept in memory for KEY_MAX_AGE_MS. An unknown
//      key id fetches the keys again (Access rotates them), at most once every KEY_REFETCH_MS, so a
//      flood of tokens with made-up key ids cannot turn into a flood of fetches. When the keys
//      cannot be fetched, keys past their age are no longer trusted;
//   3. the RS256 signature verifies over the header and payload as sent;
//   4. the issuer is https://<team domain>, the audience includes the application's AUD tag, the
//      token has not expired and is already valid (both with CLOCK_SKEW_S of leeway);
//   5. the token carries an email (service tokens do not, and are refused), and that email, compared
//      case-insensitively, is in admin.allowedEmails.
// Anything else refuses. Every failure gives a short reason for the log and nothing more: the
// response the browser sees is the same for every refusal.
import type { GtmConfig } from "../config/schema.ts";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
export const CLOCK_SKEW_S = 60;
export const KEY_REFETCH_MS = 30_000;
/** How long fetched keys are trusted before they are fetched again, so a revoked key stops working. */
export const KEY_MAX_AGE_MS = 60 * 60_000;
const MAX_TOKEN_CHARS = 8192;
const MAX_CERTS_BYTES = 64 * 1024;

export type AdminConfig = NonNullable<GtmConfig["admin"]>;

export interface AccessIdentity {
  /** The operator's email, lowercased. */
  email: string;
  /** Access's stable user id. */
  sub: string;
  /** When the token expires, in milliseconds since the epoch. */
  expiresAt: number;
}

/** `notAllowed` is set only when the token is valid and its email is not on the allowlist. */
export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string; notAllowed?: boolean };

export interface AccessVerifyOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  /** The key cache. Defaults to one shared by the isolate. */
  cache?: AccessKeyCache;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  /** When these keys were fetched. Keys older than KEY_MAX_AGE_MS are fetched again before use. */
  fetchedAt: number;
  /** When a fetch was last tried, successful or not. */
  triedAt: number;
}

/** Signing keys per team domain. One per isolate by default; tests pass their own. */
export class AccessKeyCache {
  readonly teams = new Map<string, CachedKeys>();
  readonly inflight = new Map<string, Promise<Map<string, CryptoKey> | null>>();
}

const sharedCache = new AccessKeyCache();

export const certsUrl = (teamDomain: string): string => `https://${teamDomain}/cdn-cgi/access/certs`;
export const accessIssuer = (teamDomain: string): string => `https://${teamDomain}`;

function base64UrlToBytes(part: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
  try {
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(part);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function importKeys(body: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  const list = body && typeof body === "object" && Array.isArray((body as { keys?: unknown }).keys) ? ((body as { keys: unknown[] }).keys) : [];
  for (const jwk of list.slice(0, 20)) {
    if (!jwk || typeof jwk !== "object") continue;
    const k = jwk as Record<string, unknown>;
    if (k.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    if (k.alg !== undefined && k.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keys.set(k.kid, key);
    } catch {
      // A key that does not import is skipped; a token signed with it fails as an unknown key.
    }
  }
  return keys;
}

async function fetchKeys(teamDomain: string, fetcher: typeof fetch): Promise<Map<string, CryptoKey> | null> {
  try {
    const response = await fetcher(certsUrl(teamDomain), { headers: { accept: "application/json" }, redirect: "error" });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_CERTS_BYTES) return null;
    const keys = await importKeys(JSON.parse(text) as unknown);
    return keys.size > 0 ? keys : null;
  } catch {
    return null;
  }
}

async function keyFor(teamDomain: string, kid: string, fetcher: typeof fetch, cache: AccessKeyCache, now: number): Promise<CryptoKey | null> {
  const cached = cache.teams.get(teamDomain);
  const fresh = cached !== undefined && now - cached.fetchedAt < KEY_MAX_AGE_MS;
  if (fresh) {
    const hit = cached.keys.get(kid);
    if (hit) return hit;
  }
  // An unknown key id (or keys past their age) fetches again, at most once per KEY_REFETCH_MS.
  if (cached && now - cached.triedAt < KEY_REFETCH_MS) return null;
  let pending = cache.inflight.get(teamDomain);
  if (!pending) {
    pending = fetchKeys(teamDomain, fetcher).finally(() => cache.inflight.delete(teamDomain));
    cache.inflight.set(teamDomain, pending);
  }
  const keys = await pending;
  if (keys) {
    cache.teams.set(teamDomain, { keys, fetchedAt: now, triedAt: now });
    return keys.get(kid) ?? null;
  }
  // The fetch failed. Keys still inside their age stay trusted; older ones do not (fail closed).
  cache.teams.set(teamDomain, { keys: fresh ? cached.keys : new Map<string, CryptoKey>(), fetchedAt: fresh ? cached.fetchedAt : 0, triedAt: now });
  return null;
}

/** True when `email` is on the allowlist. Compared lowercased; an empty list allows no one. */
export function isAllowedEmail(admin: Pick<AdminConfig, "allowedEmails">, email: string): boolean {
  if (typeof email !== "string" || email === "") return false;
  const wanted = email.toLowerCase();
  return admin.allowedEmails.some((allowed) => allowed.toLowerCase() === wanted);
}

/** Verify an Access application token and the allowlist. Never throws. */
export async function verifyAccessToken(token: string | null | undefined, admin: AdminConfig, options: AccessVerifyOptions = {}): Promise<AccessResult> {
  const refuse = (reason: string): AccessResult => ({ ok: false, reason });
  try {
    if (typeof token !== "string" || token === "") return refuse("no Access token");
    if (token.length > MAX_TOKEN_CHARS) return refuse("the token is too large");
    const parts = token.split(".");
    if (parts.length !== 3) return refuse("the token is not a signed JWT");
    const [rawHeader = "", rawPayload = "", rawSignature = ""] = parts;
    const header = decodeJson(rawHeader);
    if (!header) return refuse("the token header does not decode");
    if (header.alg !== "RS256") return refuse("the token is not signed with RS256");
    if (typeof header.kid !== "string" || header.kid === "" || header.kid.length > 200) return refuse("the token names no key");
    const payload = decodeJson(rawPayload);
    if (!payload) return refuse("the token payload does not decode");
    const signature = base64UrlToBytes(rawSignature);
    if (!signature || signature.length === 0) return refuse("the token signature does not decode");

    const nowMs = (options.now?.() ?? new Date()).getTime();
    const key = await keyFor(admin.accessTeamDomain, header.kid, options.fetch ?? fetch, options.cache ?? sharedCache, nowMs);
    if (!key) return refuse("the token was signed with a key this team does not publish");
    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
    if (!valid) return refuse("the token signature does not verify");

    if (payload.iss !== accessIssuer(admin.accessTeamDomain)) return refuse("the token was issued by another team");
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.some((a) => a === admin.accessAud)) return refuse("the token is for another Access application");
    const nowS = nowMs / 1000;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return refuse("the token has no expiry");
    if (payload.exp + CLOCK_SKEW_S <= nowS) return refuse("the token has expired");
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - CLOCK_SKEW_S > nowS)) return refuse("the token is not valid yet");
    if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat - CLOCK_SKEW_S > nowS)) return refuse("the token was issued in the future");
    if (typeof payload.email !== "string" || payload.email === "" || payload.email.length > 254) return refuse("the token carries no email");
    const email = payload.email.toLowerCase();
    if (!isAllowedEmail(admin, email)) return { ok: false, reason: "the email is not on admin.allowedEmails", notAllowed: true };
    const sub = typeof payload.sub === "string" ? payload.sub.slice(0, 200) : "";
    return { ok: true, identity: { email, sub, expiresAt: Math.floor(payload.exp * 1000) } };
  } catch {
    return refuse("the token could not be verified");
  }
}

/** Verify the Access token on a request. */
export function verifyAccessRequest(request: Request, admin: AdminConfig, options: AccessVerifyOptions = {}): Promise<AccessResult> {
  return verifyAccessToken(request.headers.get(ACCESS_JWT_HEADER), admin, options);
}
