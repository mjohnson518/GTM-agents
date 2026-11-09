// GTM-agents: GET /ws, the dashboard's WebSocket upgrade. Default-deny, in this order:
//   1. no admin section in gtm.config.ts: 503, the dashboard is not configured;
//   2. the admin:enabled flag off or unreadable: 503;
//   3. an Origin other than this deployment's own (or one listed in admin.allowedOrigins): 403, so
//      another site cannot open a socket with the operator's Access cookie;
//   4. no valid Cloudflare Access token: 403;
//   5. a valid token whose email is not on admin.allowedEmails: the upgrade is accepted by the Worker
//      itself and closed at once with code 4403, so the dashboard can tell "signed in, but not
//      allowed" from a network failure (a browser cannot read an HTTP status on a failed upgrade).
//      Nothing reaches the Durable Object and nothing is sent on that socket;
//   6. not a WebSocket upgrade: 426.
// Only then is the upgrade handed to the OperatorGateway Durable Object, in a new request that
// carries nothing from the client but the upgrade and the verified identity. There is no bearer
// token on this route: Access is the authentication.
import type { Context } from "hono";
import type { GtmConfig } from "../config/schema.ts";
import type { Env } from "../env.ts";
import { isFlagOn } from "../jobs/loop.ts";
import { verifyAccessRequest, type AccessIdentity, type AccessVerifyOptions } from "./access.ts";

export const GATEWAY_PATH = "/ws";
export const ADMIN_FLAG = "admin:enabled";
/** The single gateway instance's name. */
export const GATEWAY_INSTANCE = "operator-gateway";
/** The header the Worker uses to hand the verified identity to the Durable Object. */
export const IDENTITY_HEADER = "X-Gtm-Operator-Identity";
/** The close code for a signed-in operator who is not on admin.allowedEmails. */
export const NOT_ALLOWED_CLOSE = 4403;

export interface GatewayRouteOptions extends AccessVerifyOptions {
  log?: { warn(msg: string, data?: Record<string, unknown>): void };
}

const refuse = (status: number, error: string): Response => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** Accept the upgrade in the Worker and close it at once with `code`: the only refusal a browser can read. */
function closedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** True when `origin` is this deployment's own origin or one the admin config lists. */
export function originAllowed(request: Request, admin: NonNullable<GtmConfig["admin"]>, origin: string | null): boolean {
  if (!origin) return false;
  const own = new URL(request.url).origin;
  if (origin === own) return true;
  return admin.allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin === origin;
    } catch {
      return false;
    }
  });
}

/** Verify everything about an upgrade request. Returns the identity, or the response that refuses it. */
export async function admitUpgrade(
  request: Request,
  env: Pick<Env, "KV">,
  config: GtmConfig,
  options: GatewayRouteOptions = {},
): Promise<{ ok: true; identity: AccessIdentity } | { ok: false; response: Response; notAllowed?: boolean }> {
  const admin = config.admin;
  if (!admin) return { ok: false, response: refuse(503, "dashboard_not_configured") };
  let enabled: boolean;
  try {
    enabled = env.KV ? isFlagOn(await env.KV.get(ADMIN_FLAG)) : false;
  } catch {
    enabled = false;
  }
  if (!enabled) return { ok: false, response: refuse(503, "dashboard_disabled") };
  if (!originAllowed(request, admin, request.headers.get("Origin"))) return { ok: false, response: refuse(403, "forbidden") };
  const verified = await verifyAccessRequest(request, admin, options);
  const upgrade = (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
  if (!verified.ok) {
    options.log?.warn("dashboard connection refused", { reason: verified.reason });
    if (verified.notAllowed && upgrade) return { ok: false, response: closedSocket(NOT_ALLOWED_CLOSE, "not on the dashboard allowlist"), notAllowed: true };
    return { ok: false, response: refuse(403, verified.notAllowed ? "not_allowed" : "forbidden"), ...(verified.notAllowed ? { notAllowed: true } : {}) };
  }
  if (!upgrade) return { ok: false, response: refuse(426, "websocket_upgrade_required") };
  return { ok: true, identity: verified.identity };
}

/** The /ws handler createWorker mounts. */
export function createGatewayRoute<E extends Env>(config: GtmConfig, options: GatewayRouteOptions = {}): (c: Context<{ Bindings: E }>) => Promise<Response> {
  return async (c) => {
    const admitted = await admitUpgrade(c.req.raw, c.env, config, options);
    if (!admitted.ok) return admitted.response;
    if (!c.env.GATEWAY) return refuse(503, "dashboard_not_configured");
    const stub = c.env.GATEWAY.get(c.env.GATEWAY.idFromName(GATEWAY_INSTANCE));
    // A fresh request: no client header reaches the object except the upgrade itself.
    const forwarded = new Request("https://gateway.internal/connect", {
      headers: { Upgrade: "websocket", [IDENTITY_HEADER]: JSON.stringify(admitted.identity) },
    });
    return stub.fetch(forwarded);
  };
}
