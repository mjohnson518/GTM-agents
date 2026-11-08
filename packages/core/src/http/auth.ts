// GTM-agents: bearer authentication for the HTTP API, and the constant-time comparison every
// shared-secret check uses.
//
// Every /api/* route requires `Authorization: Bearer <GATEWAY_TOKEN>`, except /api/webhooks/*, whose
// routes verify their own signatures (the operator channel's secret token, an HMAC, a provider
// signature). The check is a gate, so it fails closed: an unset GATEWAY_TOKEN answers 503 to every
// protected route instead of letting requests through, and a missing or wrong token answers 401.
import type { MiddlewareHandler } from "hono";

const encoder = new TextEncoder();

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * Compare two secrets without leaking where they differ or how long the expected one is. Both sides
 * are hashed to 32 bytes first, so the loop always runs over the same length, and every byte is
 * folded into one accumulator. An empty expected value never matches.
 */
export async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  if (typeof provided !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export const WEBHOOK_PREFIX = "/api/webhooks/";

/** True for a path that verifies its own signature instead of the bearer token. */
export function isWebhookPath(path: string): boolean {
  return path.startsWith(WEBHOOK_PREFIX);
}

export interface BearerAuthOptions {
  /** Reads the expected token. Defaults to the GATEWAY_TOKEN binding. */
  token?: (env: Record<string, unknown>) => string | undefined;
}

/**
 * Hono middleware for /api/*: webhook paths pass through to their own verification; every other
 * path needs the bearer token. Mount it with `app.use("/api/*", bearerAuth())`.
 */
export function bearerAuth(options: BearerAuthOptions = {}): MiddlewareHandler {
  const read = options.token ?? ((env) => (typeof env.GATEWAY_TOKEN === "string" ? env.GATEWAY_TOKEN : undefined));
  return async (c, next) => {
    // c.req.path is the same decoded path the router matches on, so the skip cannot be steered
    // onto a route the router would treat differently.
    if (isWebhookPath(c.req.path)) return next();
    const expected = read((c.env ?? {}) as Record<string, unknown>);
    if (!expected) return c.json({ error: "auth_not_configured", detail: "set GATEWAY_TOKEN with wrangler secret put" }, 503);
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
    if (!match || !(await constantTimeEqual(match[1] ?? "", expected))) {
      return c.json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="gtm-agents"' });
    }
    return next();
  };
}
