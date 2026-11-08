// GTM-agents: Google OAuth for adapters: an access token from a refresh token, with no SDK.
//
//   const auth = createGoogleAuth(ctx, { refreshTokenName: "GMAIL_REFRESH_TOKEN" });
//   const token = await auth.accessToken();
//
// It runs the OAuth 2.0 refresh-token grant against Google's token endpoint through the adapter
// context's injected fetch, and keeps the access token until EXPIRY_MARGIN_SECONDS before Google
// says it expires. Tokens are cached in memory per credential set (keyed by a hash, never by the
// secrets themselves), so adapter instances in the same Worker isolate share one token, and
// concurrent callers share one refresh (a caller whose shared refresh fails refreshes itself). invalidate() drops a token the API rejected, so the next
// call refreshes.
//
// Failures are typed AdapterErrors and never carry a secret or Google's free text:
//   - a missing secret is "auth", not retryable, naming the secret to set;
//   - 400 and 401 (invalid_grant: the refresh token was revoked or expired; invalid_client) are
//     "auth", not retryable, with Google's short error code;
//   - 429 is "rate_limited" and 5xx "unavailable", both retryable;
//   - a time-out or dropped connection is "timeout", retryable;
//   - an answer without an access token is "unknown", retryable.
// Secrets: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the OAuth client), plus one refresh token per
// adapter (GMAIL_REFRESH_TOKEN for the mailbox), each overridable.
import { AdapterError, type AdapterContext } from "@gtm-agents/core/ports";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CLIENT_ID_NAME = "GOOGLE_CLIENT_ID";
export const CLIENT_SECRET_NAME = "GOOGLE_CLIENT_SECRET";
/** A token is refreshed this long before Google says it expires. */
export const EXPIRY_MARGIN_SECONDS = 120;

export interface GoogleAuthOptions {
  /** The refresh token's secret name, for example GMAIL_REFRESH_TOKEN. */
  refreshTokenName: string;
  clientIdName?: string;
  clientSecretName?: string;
  /** Defaults to Google's token endpoint. */
  tokenUrl?: string;
}

export interface GoogleAuth {
  /** A valid access token, refreshed when needed. Throws AdapterError. */
  accessToken(): Promise<string>;
  /** Forget the cached token (the API answered 401 with it). */
  invalidate(): void;
}

interface CachedToken {
  token: string;
  /** Epoch milliseconds after which the token is not used. */
  usableUntil: number;
}

const cache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<CachedToken>>();

/** Forget every cached token. For tests, and after rotating credentials. */
export function clearGoogleTokenCache(): void {
  cache.clear();
  inFlight.clear();
}

async function cacheKey(clientId: string, refreshToken: string, tokenUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${tokenUrl}\n${clientId}\n${refreshToken}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Google's short error code from a token response, when it is a plain snake_case token. */
async function errorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "";
  } catch {
    return "";
  }
}

function secretOrThrow(ctx: AdapterContext, name: string): string {
  const value = ctx.optionalSecret(name);
  if (!value) throw new AdapterError(`missing secret ${name}; set it with wrangler secret put ${name}`, "auth", false);
  return value;
}

export function createGoogleAuth(ctx: AdapterContext, options: GoogleAuthOptions): GoogleAuth {
  const tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
  let key: string | null = null;

  async function refresh(clientId: string, clientSecret: string, refreshToken: string): Promise<CachedToken> {
    let response: Response;
    try {
      response = await ctx.fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
      });
    } catch (error) {
      throw new AdapterError("the Google token request failed before an answer arrived", "timeout", true, { cause: error });
    }
    if (!response.ok) {
      const code = await errorCode(response);
      const detail = `Google token refresh failed with HTTP ${response.status}${code ? ` (${code})` : ""}`;
      if (response.status === 400 || response.status === 401 || response.status === 403) throw new AdapterError(`${detail}; check the OAuth client and refresh token`, "auth", false);
      if (response.status === 429) throw new AdapterError(detail, "rate_limited", true);
      if (response.status >= 500) throw new AdapterError(detail, "unavailable", true);
      throw new AdapterError(detail, "unknown", false);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AdapterError("the Google token response was not JSON", "unknown", true);
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const token = typeof record.access_token === "string" && record.access_token.length > 0 ? record.access_token : null;
    if (!token) throw new AdapterError("the Google token response held no access token", "unknown", true);
    const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) && record.expires_in > 0 ? record.expires_in : 3600;
    const lifetime = Math.max(0, expiresIn - EXPIRY_MARGIN_SECONDS);
    return { token, usableUntil: ctx.now().getTime() + lifetime * 1000 };
  }

  return {
    async accessToken() {
      const clientId = secretOrThrow(ctx, options.clientIdName ?? CLIENT_ID_NAME);
      const clientSecret = secretOrThrow(ctx, options.clientSecretName ?? CLIENT_SECRET_NAME);
      const refreshToken = secretOrThrow(ctx, options.refreshTokenName);
      key = await cacheKey(clientId, refreshToken, tokenUrl);
      const cached = cache.get(key);
      if (cached && cached.usableUntil > ctx.now().getTime()) return cached.token;
      const pending = inFlight.get(key);
      if (pending) {
        try {
          return (await pending).token;
        } catch {
          // The refresh belonged to another request, which may have ended and taken its fetch with
          // it: refresh here instead.
        }
      }
      const request = refresh(clientId, clientSecret, refreshToken);
      inFlight.set(key, request);
      try {
        const fresh = await request;
        cache.set(key, fresh);
        return fresh.token;
      } finally {
        inFlight.delete(key);
      }
    },
    invalidate() {
      if (key) cache.delete(key);
    },
  };
}
