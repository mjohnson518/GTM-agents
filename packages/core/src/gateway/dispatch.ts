// GTM-agents: one dashboard frame in, one response out. The OperatorGateway Durable Object calls
// handleFrame for every message on a socket; everything that decides what a request may do is here,
// so it is tested without a socket.
//
// In order, a frame is:
//   1. refused when admin:enabled is off or unreadable, when the Access token it connected with has expired (the socket closes and the
//      dashboard reconnects through Access) or the email is no longer allowlisted;
//   2. refused when larger than MAX_FRAME_BYTES, or not a request object;
//   3. counted against the connection's rate limits (requests, mutations and chat messages per
//      minute); far over the limit closes the socket;
//   4. refused before `connect` unless it is in PRE_CONNECT_METHODS;
//   5. parsed against its method's params schema (params.ts);
//   6. run, with the operator's identity from the connection, never from params;
//   7. for a mutating method, recorded in the audit log, whatever the outcome.
import { writeAudit } from "../events/audit.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { isFlagOn } from "../jobs/loop.ts";
import { isAllowedEmail, type AdminConfig } from "./access.ts";
import { ADMIN_FLAG } from "./route.ts";
import { activityExport, activityList, activitySubscribe } from "./activity.ts";
import { chatAbort, chatHistory, chatSend } from "./chat.ts";
import { RpcError, type ConnectionState, type GatewayContext, type Handler, type Handlers } from "./context.ts";
import {
  contactsGet,
  contactsLog,
  contactsNext,
  contactsQuery,
  contactsStats,
  contactsSummary,
  contactsUpdate,
  pipelineCreate,
  pipelineDeals,
  pipelineSummary,
  pipelineTransition,
  pipelineUpdate,
} from "./crm.ts";
import { draftsApprove, draftsList, draftsReject, inboundAction, inboundDraftSend, inboundList, inboundStats } from "./inbox.ts";
import {
  agentsList,
  agentsStatus,
  changelogList,
  cockpitDrain,
  cockpitGet,
  cockpitPause,
  cockpitReplay,
  cockpitResume,
  configGet,
  costSummary,
  fitnessTrend,
  flagsList,
  flagsSet,
  health,
  learningSummary,
  linkTriageStatus,
  securityAudit,
  status,
} from "./ops.ts";
import { parseParams } from "./params.ts";
import { learningHistorySearch, learningList, proposalsApprove, proposalsList, proposalsReject } from "./proposals.ts";
import { MUTATING_METHODS, PRE_CONNECT_METHODS, PROTOCOL_VERSION, type MethodName, type RpcErrorCode } from "./protocol.ts";

export const MAX_FRAME_BYTES = 64 * 1024;
export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMITS = Object.freeze({ requests: 120, mutations: 30, chats: 10 });
/** Requests in one window past which the socket is closed rather than answered. */
export const RATE_CLOSE_AT = RATE_LIMITS.requests * 2;

export const CLOSE = Object.freeze({ expired: 4001, forbidden: 4003, tooLarge: 1009, policy: 1008 });

/** Methods the protocol leaves out of MUTATING_METHODS but that change state here. */
const ALSO_AUDITED: readonly MethodName[] = ["activity.export"];

const connect: Handler<"connect"> = (p, ctx) => {
  if (p.protocolVersion !== PROTOCOL_VERSION) return Promise.reject(new RpcError("invalid", `this server speaks protocol ${PROTOCOL_VERSION}`));
  ctx.state.connected = true;
  const env = ctx.env as unknown as Record<string, unknown>;
  const { wiring } = ctx;
  const capabilities = (Object.keys(HANDLERS) as MethodName[]).filter((m) => {
    if (m === "chat.send") return wiring.model !== undefined;
    if (m === "cockpit.replay") return wiring.email !== undefined;
    if (m === "inbound.draftSend") return wiring.inbox !== undefined;
    if (m === "linkTriage.status") return wiring.config.modules.linkIntake.enabled && wiring.extensions.linkTriage !== undefined;
    if (m === "fitness.trend") return wiring.extensions.fitness !== undefined;
    return true;
  });
  return Promise.resolve({
    operator: { email: ctx.state.email },
    deployment: { name: wiring.config.company.name, environment: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "production" },
    capabilities,
  });
};

export const HANDLERS: Handlers = {
  connect,
  status,
  health,
  "chat.send": chatSend,
  "chat.history": chatHistory,
  "chat.abort": chatAbort,
  "cockpit.get": cockpitGet,
  "cockpit.pause": cockpitPause,
  "cockpit.resume": cockpitResume,
  "cockpit.drain": cockpitDrain,
  "cockpit.replay": cockpitReplay,
  "pipeline.summary": pipelineSummary,
  "pipeline.deals": pipelineDeals,
  "pipeline.create": pipelineCreate,
  "pipeline.update": pipelineUpdate,
  "pipeline.transition": pipelineTransition,
  "contacts.query": contactsQuery,
  "contacts.get": contactsGet,
  "contacts.update": contactsUpdate,
  "contacts.stats": contactsStats,
  "contacts.next": contactsNext,
  "contacts.log": contactsLog,
  "contacts.summary": contactsSummary,
  "inbound.list": inboundList,
  "inbound.action": inboundAction,
  "inbound.draftSend": inboundDraftSend,
  "inbound.stats": inboundStats,
  "drafts.list": draftsList,
  "drafts.approve": draftsApprove,
  "drafts.reject": draftsReject,
  "proposals.list": proposalsList,
  "proposals.approve": proposalsApprove,
  "proposals.reject": proposalsReject,
  "agents.list": agentsList,
  "agents.status": agentsStatus,
  "activity.list": activityList,
  "activity.subscribe": activitySubscribe,
  "activity.export": activityExport,
  "security.audit": securityAudit,
  "config.get": configGet,
  "flags.list": flagsList,
  "flags.set": flagsSet,
  "cost.summary": costSummary,
  "fitness.trend": fitnessTrend,
  "learning.summary": learningSummary,
  "learning.list": learningList,
  "learning.historySearch": learningHistorySearch,
  "linkTriage.status": linkTriageStatus,
  "changelog.list": changelogList,
};

export interface FrameOutcome {
  /** The response frame to send, if any. */
  reply?: string;
  /** Close the socket with this code and reason. */
  close?: { code: number; reason: string };
  /** True when the request changed state (an audit row was written). */
  mutated?: boolean;
}

const errorFrame = (id: string, code: RpcErrorCode, message: string): string => JSON.stringify({ id, error: { code, message } });

const isMutating = (method: MethodName): boolean => MUTATING_METHODS.includes(method) || ALSO_AUDITED.includes(method);

function frameText(raw: string | ArrayBuffer): string | null {
  if (typeof raw === "string") return new TextEncoder().encode(raw).length > MAX_FRAME_BYTES ? null : raw;
  if (raw.byteLength > MAX_FRAME_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return null;
  }
}

/**
 * Whether a socket may stay open: on the allowlist, inside its Access session, and with the
 * dashboard switched on. Checked on every frame and before every activity push. Null means admitted.
 */
export function socketGate(admin: AdminConfig | undefined, state: Pick<ConnectionState, "email" | "expiresAt"> | null, enabled: boolean, now: number): { code: number; reason: string } | null {
  if (!admin || !state || !isAllowedEmail(admin, state.email)) return { code: CLOSE.forbidden, reason: "not allowed" };
  if (now >= state.expiresAt) return { code: CLOSE.expired, reason: "the Access session expired; reconnect" };
  if (!enabled) return { code: CLOSE.forbidden, reason: "the dashboard is turned off" };
  return null;
}

/** Read the admin:enabled switch. Off or unreadable is off. */
export async function dashboardEnabled(flags: GatewayContext["flags"]): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(ADMIN_FLAG));
  } catch {
    return false;
  }
}

/** Handle one frame. Never throws. */
export async function handleFrame(raw: string | ArrayBuffer, ctx: GatewayContext): Promise<FrameOutcome> {
  const now = ctx.now().getTime();
  // The off switch is a gate on every frame, not only the upgrade: off or unreadable closes the socket.
  const refused = socketGate(ctx.wiring.config.admin, ctx.state, await dashboardEnabled(ctx.flags), now);
  if (refused) return { close: refused };

  const text = frameText(raw);
  if (text === null) return { close: { code: CLOSE.tooLarge, reason: "frame too large" } };
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return { reply: errorFrame("", "invalid", "a frame is one JSON object") };
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return { reply: errorFrame("", "invalid", "a frame is one JSON object") };
  const { id, method, params } = frame as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof id !== "string" || id === "" || id.length > 64) return { reply: errorFrame("", "invalid", "a request needs an id of 1 to 64 characters") };

  const rl = ctx.state.rl;
  if (now - rl.start >= RATE_WINDOW_MS) Object.assign(rl, { start: now, requests: 0, mutations: 0, chats: 0 });
  rl.requests += 1;
  if (rl.requests > RATE_CLOSE_AT) return { close: { code: CLOSE.policy, reason: "too many requests" } };
  if (rl.requests > RATE_LIMITS.requests) return { reply: errorFrame(id, "rate_limited", "too many requests; slow down") };

  if (typeof method !== "string" || !Object.hasOwn(HANDLERS, method)) return { reply: errorFrame(id, "invalid", "unknown method") };
  const name = method as MethodName;
  if (!ctx.state.connected && !PRE_CONNECT_METHODS.includes(name)) return { reply: errorFrame(id, "unauthenticated", "send connect first") };

  const mutating = isMutating(name);
  if (mutating) {
    rl.mutations += 1;
    if (rl.mutations > RATE_LIMITS.mutations) return { reply: errorFrame(id, "rate_limited", "too many changes in a minute; slow down") };
  }
  if (name === "chat.send") {
    rl.chats += 1;
    if (rl.chats > RATE_LIMITS.chats) return { reply: errorFrame(id, "rate_limited", "too many chat messages in a minute; slow down") };
  }

  const parsed = parseParams(name, params);
  if (!parsed.ok) return { reply: errorFrame(id, "invalid", parsed.message) };

  ctx.audit = {};
  let reply: string;
  let outcome: "ok" | RpcErrorCode = "ok";
  try {
    const handler = HANDLERS[name] as Handler<MethodName>;
    const result = await handler(parsed.value, ctx);
    reply = JSON.stringify({ id, result });
  } catch (error) {
    const code: RpcErrorCode = error instanceof RpcError ? error.code : "internal";
    const message = error instanceof RpcError ? error.message : "the request failed";
    outcome = code;
    if (!(error instanceof RpcError)) console.error(JSON.stringify({ level: "error", msg: "dashboard method failed", scope: "gateway", method: name, error: sanitizeErrorMessage(error) }));
    reply = errorFrame(id, code, message.slice(0, 500));
  }
  if (mutating) {
    // Bookkeeping: a failed audit write is dropped, never allowed to fail the request.
    await writeAudit(ctx.env.DB, { agentId: ctx.actor, action: `dashboard.${name}`, details: { outcome, ...ctx.audit }, now: ctx.now() });
  }
  return { reply, mutated: mutating };
}
