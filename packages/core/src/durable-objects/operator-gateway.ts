// GTM-agents: OperatorGateway, the Durable Object that holds the admin dashboard's WebSocket
// connections and runs its requests (packages/core/src/gateway/).
//
// One instance serves every dashboard. Sockets use the hibernation API: an idle dashboard costs
// nothing, and the text frame "ping" is answered with "pong" by the runtime without waking the
// object. Each socket's attachment holds the identity the Worker verified with Cloudflare Access
// before the upgrade (the object never reads identity from a frame), whether `connect` has
// succeeded, the activity subscription and the rate-limit window, so all of it survives
// hibernation. While any dashboard subscribes to activity, an alarm every ACTIVITY_POLL_MS pushes
// new audit rows to the subscribers. Each push re-checks what every frame checks: the admin:enabled
// switch (off or unreadable closes every socket and stops the alarm), and for each socket the
// allowlist and its Access expiry, so a quiet subscribed tab cannot outlive either.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { isAllowedEmail } from "../gateway/access.ts";
import { activityItem, activitySince, latestActivityId } from "../gateway/activity.ts";
import { contextFlags, type ConnectionState, type GatewayContext, type RunningTurn } from "../gateway/context.ts";
import { dashboardEnabled, handleFrame, socketGate } from "../gateway/dispatch.ts";
import type { ServerEvent } from "../gateway/protocol.ts";
import { IDENTITY_HEADER } from "../gateway/route.ts";
import { gatewayWiring } from "../gateway/wiring.ts";

export const ACTIVITY_POLL_MS = 10_000;
/** Open dashboard sockets per operator email. */
export const MAX_SOCKETS_PER_OPERATOR = 5;
const LAST_ACTIVITY_KEY = "activity:last";

const unavailable = (status: number, error: string) => Response.json({ error }, { status });

function readState(ws: WebSocket): ConnectionState | null {
  try {
    const s = ws.deserializeAttachment() as ConnectionState | null;
    return s && typeof s.email === "string" && typeof s.expiresAt === "number" && s.rl ? s : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, frame: string | ServerEvent): void {
  try {
    ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  } catch {
    // The socket closed; there is nobody to tell.
  }
}

export class OperatorGateway extends DurableObject<Env> {
  private readonly turns = new Map<string, RunningTurn>();
  /**
   * Each socket's state while the object is awake. Frames on one socket can be handled concurrently
   * (a handler awaiting I/O lets the next frame in), so the rate-limit counters live here, shared by
   * every handler, and the attachment is the copy that survives hibernation.
   */
  private readonly live = new WeakMap<WebSocket, ConnectionState>();

  private stateOf(ws: WebSocket): ConnectionState | null {
    const known = this.live.get(ws);
    if (known) return known;
    const stored = readState(ws);
    if (stored) this.live.set(ws, stored);
    return stored;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override fetch(request: Request): Response {
    const wiring = gatewayWiring();
    const admin = wiring?.config.admin;
    if (!wiring || !admin) return unavailable(503, "dashboard_not_configured");
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return unavailable(426, "websocket_upgrade_required");
    let identity: { email?: unknown; sub?: unknown; expiresAt?: unknown };
    try {
      identity = JSON.parse(request.headers.get(IDENTITY_HEADER) ?? "") as typeof identity;
    } catch {
      return unavailable(403, "forbidden");
    }
    if (typeof identity.email !== "string" || typeof identity.expiresAt !== "number" || !isAllowedEmail(admin, identity.email)) return unavailable(403, "forbidden");
    if (this.ctx.getWebSockets(identity.email).length >= MAX_SOCKETS_PER_OPERATOR) return unavailable(429, "too_many_connections");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [identity.email]);
    const state: ConnectionState = {
      email: identity.email,
      sub: typeof identity.sub === "string" ? identity.sub : "",
      expiresAt: identity.expiresAt,
      connected: false,
      subscribed: false,
      rl: { start: Date.now(), requests: 0, mutations: 0, chats: 0 },
    };
    server.serializeAttachment(state);
    this.live.set(server, state);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const wiring = gatewayWiring();
    const state = this.stateOf(ws);
    if (!wiring || !state) {
      ws.close(1011, "the dashboard is not available");
      return;
    }
    const wasSubscribed = state.subscribed;
    const deferred: Array<Promise<unknown>> = [];
    const ctx: GatewayContext = {
      env: this.env,
      wiring,
      state,
      now: () => new Date(),
      actor: `operator:${state.email}`,
      flags: contextFlags(this.env),
      push: (event) => send(ws, event),
      broadcast: (event) => {
        for (const socket of this.ctx.getWebSockets()) if (this.stateOf(socket)?.connected) send(socket, event);
      },
      defer: (task) => deferred.push(task),
      turns: this.turns,
      audit: {},
    };
    const outcome = await handleFrame(message, ctx);
    try {
      ws.serializeAttachment(state);
    } catch {
      // An attachment that cannot be stored leaves the previous one; the next frame re-checks everything.
    }
    if (outcome.reply) send(ws, outcome.reply);
    if (outcome.close) {
      try {
        ws.close(outcome.close.code, outcome.close.reason);
      } catch {
        // Already closed.
      }
      return;
    }
    if (state.subscribed && !wasSubscribed) await this.startActivityStream();
    if (outcome.mutated) await this.pollActivity();
    await Promise.allSettled(deferred);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async alarm(): Promise<void> {
    if (await this.pollActivity()) await this.ctx.storage.setAlarm(Date.now() + ACTIVITY_POLL_MS);
  }

  private subscribers(): WebSocket[] {
    const now = Date.now();
    return this.ctx.getWebSockets().filter((ws) => {
      const s = this.stateOf(ws);
      return s !== null && s.connected && s.subscribed && s.expiresAt > now;
    });
  }

  /** Close every socket the gates no longer admit, and return the subscribers that remain. */
  private async admittedSubscribers(): Promise<WebSocket[]> {
    const admin = gatewayWiring()?.config.admin;
    const enabled = await dashboardEnabled(contextFlags(this.env));
    const now = Date.now();
    const closed = new Set<WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const refused = socketGate(admin, this.stateOf(ws), enabled, now);
      if (!refused) continue;
      closed.add(ws);
      try {
        ws.close(refused.code, refused.reason);
      } catch {
        // Already closed.
      }
    }
    return this.subscribers().filter((ws) => !closed.has(ws));
  }

  private async startActivityStream(): Promise<void> {
    try {
      // Stream from now: a new subscriber reads the past with activity.list.
      if (this.subscribers().length <= 1) await this.ctx.storage.put(LAST_ACTIVITY_KEY, await latestActivityId(this.env.DB));
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ACTIVITY_POLL_MS);
    } catch {
      // The stream is a convenience: activity.list still shows everything.
    }
  }

  /** Push audit rows newer than the last one pushed. Returns false when nobody is subscribed. */
  private async pollActivity(): Promise<boolean> {
    const subscribers = await this.admittedSubscribers();
    if (subscribers.length === 0) return false;
    try {
      const last = (await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY)) ?? (await latestActivityId(this.env.DB));
      const rows = await activitySince(this.env.DB, last);
      if (rows.length > 0) {
        for (const row of rows) {
          const event: ServerEvent = { event: "activity", data: activityItem(row) };
          for (const ws of subscribers) send(ws, event);
        }
        await this.ctx.storage.put(LAST_ACTIVITY_KEY, rows[rows.length - 1]?.id ?? last);
      }
    } catch {
      // Try again at the next poll.
    }
    return true;
  }
}
