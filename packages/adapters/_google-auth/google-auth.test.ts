// GTM-agents: tests for the shared Google OAuth helper, against recorded, synthetic token responses.
// The client, tokens and secrets are invented; nothing reaches the network.
import { beforeEach, describe, expect, it } from "vitest";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { EXPIRY_MARGIN_SECONDS, GOOGLE_TOKEN_URL, clearGoogleTokenCache, createGoogleAuth } from "./index.ts";

const SECRETS = { GOOGLE_CLIENT_ID: "acme-test-client.apps.example", GOOGLE_CLIENT_SECRET: "s".repeat(24), GMAIL_REFRESH_TOKEN: "r".repeat(40) };
const T0 = new Date("2026-11-04T12:00:00.000Z");

function setup(routes: RecordedRoute[], secrets: Record<string, string> = SECRETS) {
  const recorded = recordedFetch(routes);
  let now = T0;
  const ctx = { ...testContext({ secrets, fetch: recorded.fetch }), now: () => now };
  return { auth: createGoogleAuth(ctx, { refreshTokenName: "GMAIL_REFRESH_TOKEN" }), calls: recorded.calls, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

let issued = 0;
const tokenRoute: RecordedRoute = { method: "POST", url: GOOGLE_TOKEN_URL, respond: () => json({ access_token: `token-${(issued += 1)}`, expires_in: 3600 }) };

async function failure(promise: Promise<unknown>): Promise<{ code: unknown; retryable: unknown; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown; message?: string };
    return { code: e.code, retryable: e.retryable, message: e.message ?? "" };
  }
  throw new Error("expected a failure");
}

beforeEach(() => clearGoogleTokenCache());

describe("Google OAuth", () => {
  it("runs the refresh-token grant with the client credentials", async () => {
    const { auth, calls } = setup([tokenRoute]);
    expect(await auth.accessToken()).toMatch(/^token-/);
    const form = new URLSearchParams(await calls[0]?.clone().text());
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", client_id: SECRETS.GOOGLE_CLIENT_ID, client_secret: SECRETS.GOOGLE_CLIENT_SECRET, refresh_token: SECRETS.GMAIL_REFRESH_TOKEN });
    expect(calls[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("caches the token until shortly before it expires, then refreshes", async () => {
    const { auth, calls, advance } = setup([tokenRoute]);
    const first = await auth.accessToken();
    advance((3600 - EXPIRY_MARGIN_SECONDS - 1) * 1000);
    expect(await auth.accessToken()).toBe(first);
    expect(calls).toHaveLength(1);
    advance(2000);
    expect(await auth.accessToken()).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("shares one refresh between concurrent callers, and refreshes again after invalidate", async () => {
    const { auth, calls } = setup([tokenRoute]);
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
    auth.invalidate();
    expect(await auth.accessToken()).not.toBe(a);
    expect(calls).toHaveLength(2);
  });

  it("names the missing secret, without a request", async () => {
    const { auth, calls } = setup([tokenRoute], { GOOGLE_CLIENT_ID: SECRETS.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: SECRETS.GOOGLE_CLIENT_SECRET });
    const result = await failure(auth.accessToken());
    expect(result).toMatchObject({ code: "auth", retryable: false });
    expect(result.message).toContain("GMAIL_REFRESH_TOKEN");
    expect(calls).toHaveLength(0);
  });

  it("maps token failures to typed codes, keeping only Google's short error code", async () => {
    const cases: Array<[Response, string, boolean]> = [
      [json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }), "auth", false],
      [json({ error: "invalid_client" }, { status: 401 }), "auth", false],
      [json({ error: "rate_limit" }, { status: 429 }), "rate_limited", true],
      [json({ error: "backend_error" }, { status: 503 }), "unavailable", true],
      [json({ token_type: "Bearer" }), "unknown", true],
    ];
    for (const [response, code, retryable] of cases) {
      clearGoogleTokenCache();
      const { auth } = setup([{ method: "POST", url: GOOGLE_TOKEN_URL, respond: response }]);
      const result = await failure(auth.accessToken());
      expect(result, `${response.status}`).toMatchObject({ code, retryable });
      expect(result.message).not.toContain("revoked");
      expect(result.message).not.toContain(SECRETS.GMAIL_REFRESH_TOKEN);
    }
  });

  it("reports a dropped connection as a retryable time-out", async () => {
    const { auth } = setup([
      {
        method: "POST",
        url: GOOGLE_TOKEN_URL,
        respond: () => {
          throw new TypeError("network connection lost");
        },
      },
    ]);
    expect(await failure(auth.accessToken())).toMatchObject({ code: "timeout", retryable: true });
  });
});
