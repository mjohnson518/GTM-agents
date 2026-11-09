// GTM-agents SDK: the attribution cookie (docs/EVENT-CONTRACT.md, section 3).
//
// Links the agent sends carry `?ref=<token>`. On the first request that carries a valid token, the
// host copies it into a first-party cookie (gtm_ref, 30 days, SameSite=Lax, Secure, HttpOnly); at
// sign-up it stores the cookie's value as users.signup_ref and sends it back as `ref`. The host
// checks only the token's shape: it is opaque, and the agent resolves it.

export const REF_QUERY_PARAM = "ref";
export const REF_COOKIE_NAME = "gtm_ref";
export const REF_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The shape a token must have: 1 to 64 letters, digits, dashes or underscores. */
export const REF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isRefToken(value: unknown): value is string {
  return typeof value === "string" && REF_TOKEN_PATTERN.test(value);
}

/** The token in a URL's `ref` parameter, or null when there is none or it has the wrong shape. */
export function refFromUrl(url: string | URL): string | null {
  try {
    const value = (typeof url === "string" ? new URL(url) : url).searchParams.get(REF_QUERY_PARAM);
    return isRefToken(value) ? value : null;
  } catch {
    return null;
  }
}

/** The token in a Cookie header, or null. */
export function refFromCookies(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== REF_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return isRefToken(value) ? value : null;
  }
  return null;
}

/** A Set-Cookie value for `token`. Throws on a token with the wrong shape, so nothing odd reaches a header. */
export function refCookie(token: string, options: { domain?: string } = {}): string {
  if (!isRefToken(token)) throw new TypeError("not an attribution token");
  if (options.domain !== undefined && !/^[a-z0-9.-]{1,253}$/i.test(options.domain)) throw new TypeError("not a cookie domain");
  return [`${REF_COOKIE_NAME}=${token}`, `Max-Age=${REF_COOKIE_MAX_AGE_SECONDS}`, "Path=/", ...(options.domain ? [`Domain=${options.domain}`] : []), "SameSite=Lax", "Secure", "HttpOnly"].join("; ");
}

/**
 * What middleware calls on every request: the Set-Cookie value to add when the URL carries a valid
 * token and the visitor has no token yet (the first touch wins), else null.
 */
export function refCookieToSet(url: string | URL, cookieHeader: string | null | undefined, options: { domain?: string } = {}): string | null {
  if (refFromCookies(cookieHeader)) return null;
  const token = refFromUrl(url);
  return token ? refCookie(token, options) : null;
}
