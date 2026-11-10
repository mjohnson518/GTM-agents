// GTM-agents: the admin dashboard's WebSocket protocol, shared by the Worker (OperatorGateway) and
// the dashboard (apps/admin).
//
// Transport: the dashboard opens `wss://<deployment>/ws`. The Worker admits the upgrade only with a
// valid Cloudflare Access token for an allowed operator (default-deny), then hands the socket to the
// OperatorGateway Durable Object. Every frame is JSON:
//   client -> server  { id, method, params }        a request; `id` is unique per connection
//   server -> client  { id, result } | { id, error } the response to that request
//   server -> client  { event, data }                a pushed event (chat tokens, activity, status)
// `connect` must be the first request; everything else is refused until it succeeds.
//
// Rules every method follows on the server:
//   - the operator's identity comes from the verified Access token, never from params;
//   - an action runs through the same function a chat command or job uses, with the same gates,
//     digest checks and effects-ledger claims; the dashboard is never a second path around them;
//   - an approval carries the digest of exactly the text the dashboard showed (`shownDigest`), and
//     the server refuses it when the stored content no longer matches;
//   - permanently human-only classes stay capped; autonomy and experiment changes keep their
//     two-step propose then confirm;
//   - every mutation writes an audit row;
//   - text that came from outside (inbound mail, web pages, feedback) is returned as plain strings
//     and the dashboard renders it as text, never as HTML.
// Additive changes only: add optional fields and new methods; never change a field's meaning.

export const PROTOCOL_VERSION = 1;

export type RpcErrorCode = "unauthenticated" | "forbidden" | "invalid" | "not_found" | "conflict" | "unavailable" | "internal" | "rate_limited";

export interface RpcRequest<M extends MethodName = MethodName> {
  id: string;
  method: M;
  params: MethodParams<M>;
}

export type RpcResponse<M extends MethodName = MethodName> = { id: string; result: MethodResult<M> } | { id: string; error: { code: RpcErrorCode; message: string } };

/**
 * Chat events. A turn's reply arrives as chat.delta events, each appended to what the turn shows,
 * then one chat.done. When the model streams, deltas carry its text as it is written (batched, at
 * most a few thousand characters each); otherwise one delta carries the whole reply. `reset` (absent
 * means false) says: discard what this turn shows so far, then show `text`. It comes when a later
 * model call's answer replaces an earlier one, and when the final reply is not a continuation of
 * what was streamed. By chat.done a turn shows exactly its final reply, never a streamed piece the
 * reply left out; chat.history keeps only final replies.
 */
export type ServerEvent =
  | { event: "chat.delta"; data: { turnId: string; text: string; reset?: boolean } }
  | { event: "chat.done"; data: { turnId: string; status: "completed" | "aborted" | "failed"; message?: string } }
  | { event: "activity"; data: ActivityItem }
  | { event: "status"; data: SystemStatus };

/** A page of results. `cursor` is opaque; pass it back to continue. */
export interface Page<T> {
  items: T[];
  cursor?: string;
}

export interface SystemStatus {
  halted: boolean;
  coldPause: { paused: boolean; severity?: "warning" | "critical"; reason?: string; since?: string };
  flagsOn: string[];
  failingJobs: Array<{ job: string; lastError?: string; at: string }>;
  measurementHealthy: boolean;
}

export interface ActivityItem {
  id: string;
  at: string;
  kind: string;
  actor: string;
  summary: string;
  ref?: { type: string; id: string };
}

export interface DraftView {
  id: string;
  kind: string;
  to: string;
  subject: string;
  body: string;
  status: string;
  /** Digest of exactly this recipient, subject and body; echo it back to approve or send. */
  digest: string;
}

export interface Proposal {
  id: string;
  source: "autonomy" | "experiment" | "learning" | "brain" | "copy" | "self_review";
  title: string;
  /** The exact text or change that approving applies. */
  detail: string;
  createdAt: string;
  expiresAt?: string;
  /** Digest of `detail`; echo it back to approve. */
  digest: string;
  /** For two-step proposals (autonomy, experiment start): the confirm code shown with the record. */
  confirmCode?: string;
}

/** Every method: its params and its result. */
export interface Methods {
  connect: { params: { protocolVersion: number }; result: { operator: { email: string }; deployment: { name: string; environment: string }; capabilities: string[] } };
  status: { params: Record<string, never>; result: SystemStatus };
  health: { params: Record<string, never>; result: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> } };

  "chat.send": { params: { text: string }; result: { turnId: string } };
  "chat.history": { params: { limit?: number }; result: Array<{ role: "operator" | "agent"; text: string; at: string }> };
  "chat.abort": { params: { turnId: string }; result: { aborted: boolean } };

  "cockpit.get": { params: Record<string, never>; result: Record<string, unknown> };
  "cockpit.pause": { params: { reason: string }; result: SystemStatus };
  "cockpit.resume": { params: Record<string, never>; result: SystemStatus };
  "cockpit.drain": { params: { reason: string }; result: { cancelled: number } };
  "cockpit.replay": { params: Record<string, never>; result: { replayed: number } };

  /** Deal values are in major currency units (value_cents / 100). */
  "pipeline.summary": { params: Record<string, never>; result: { byStage: Record<string, { count: number; value: number }>; weightedForecast: number; winRate: number | null } };
  "pipeline.deals": { params: { stage?: string; cursor?: string }; result: Page<{ id: string; contactId: string | null; accountKey: string | null; stage: string; value: number | null; updatedAt: string }> };
  "pipeline.create": { params: { contactId: string; value?: number; notes?: string }; result: { id: string } };
  "pipeline.update": { params: { dealId: string; value?: number; notes?: string }; result: { ok: true } };
  "pipeline.transition": { params: { dealId: string; to: string; reason?: string }; result: { ok: true; stage: string } };

  "contacts.query": { params: { q?: string; warmth?: string; cursor?: string; limit?: number }; result: Page<{ id: string; name: string | null; email: string; accountKey: string | null; warmth: string; lastContactedAt: string | null }> };
  "contacts.get": { params: { id: string }; result: Record<string, unknown> };
  "contacts.update": { params: { id: string; patch: { firstName?: string; lastName?: string; jobTitle?: string; notes?: string } }; result: { ok: true } };
  "contacts.stats": { params: Record<string, never>; result: Record<string, number> };
  "contacts.next": { params: Record<string, never>; result: Array<{ id: string; reason: string }> };
  "contacts.log": { params: { id: string; cursor?: string }; result: Page<ActivityItem> };
  "contacts.summary": { params: { id: string }; result: { text: string } };

  "inbound.list": { params: { status?: string; cursor?: string }; result: Page<{ id: string; from: string; subject: string; preview: string; receivedAt: string; classification: string | null; intent: string | null; status: string; draft?: DraftView }> };
  "inbound.action": { params: { id: string; action: "archive" | "ignore" | "done" }; result: { ok: true } };
  "inbound.draftSend": { params: { draftId: string; shownDigest: string }; result: { status: string; message?: string } };
  "inbound.stats": { params: Record<string, never>; result: Record<string, number> };

  /** Drafts waiting on the operator (pending_approval by default), newest first, optionally of one kind (cold_intro, follow_up, recap, ...). */
  "drafts.list": { params: { status?: "draft" | "pending_approval" | "approved"; kind?: string; cursor?: string }; result: Page<DraftView> };
  "drafts.approve": { params: { draftId: string; shownDigest: string }; result: { status: string; message?: string } };
  "drafts.reject": { params: { draftId: string; reason?: string }; result: { ok: true } };

  "proposals.list": { params: { source?: Proposal["source"] }; result: Proposal[] };
  "proposals.approve": { params: { id: string; shownDigest: string; confirmCode?: string }; result: { status: string; message?: string } };
  "proposals.reject": { params: { id: string; reason?: string }; result: { ok: true } };

  "agents.list": { params: Record<string, never>; result: Array<{ name: string; role: string; model: string | null; tools: number }> };
  "agents.status": { params: Record<string, never>; result: Array<{ job: string; schedule: string; flag?: string; lastRun?: { status: string; at: string; summary?: string } }> };

  "activity.list": { params: { cursor?: string; kind?: string; limit?: number }; result: Page<ActivityItem> };
  "activity.subscribe": { params: { on: boolean }; result: { subscribed: boolean } };
  "activity.export": { params: { from: string; to: string }; result: { csv: string } };

  "security.audit": { params: Record<string, never>; result: Array<{ check: string; ok: boolean; detail: string }> };
  "config.get": { params: Record<string, never>; result: Record<string, unknown> };
  /** `editable` is true only for keys flags.set accepts (for a pattern family, its instances); the rule lives on the server. */
  "flags.list": { params: Record<string, never>; result: Array<{ key: string; kind: string; default: string | null; value: string | null; description: string; editable?: boolean }> };
  "flags.set": { params: { key: string; value: string | null }; result: { ok: true; value: string | null } };
  "cost.summary": { params: { days?: number }; result: { totalCents: number; byJob: Record<string, number>; byProvider: Record<string, number> } };
  "fitness.trend": { params: { days?: number }; result: Array<{ day: string; score: number | null; dimensions: Record<string, number | null> }> };

  "learning.summary": { params: Record<string, never>; result: Record<string, unknown> };
  "learning.list": { params: { status?: string }; result: Proposal[] };
  "learning.historySearch": { params: { q: string; limit?: number }; result: Array<{ sessionKey: string; at: string; snippet: string }> };
  "linkTriage.status": { params: Record<string, never>; result: { installed: boolean; detail?: Record<string, unknown> } };
  "changelog.list": { params: { q?: string; area?: string }; result: Array<{ version: string; date: string; area: string; text: string }> };
}

export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = Methods[M]["params"];
export type MethodResult<M extends MethodName> = Methods[M]["result"];

/** Methods allowed before `connect` succeeds. Everything else is refused with "unauthenticated". */
export const PRE_CONNECT_METHODS: readonly MethodName[] = Object.freeze(["connect", "health"]);

/** Methods that change state; each writes an audit row and runs through the module that owns the action. */
export const MUTATING_METHODS: readonly MethodName[] = Object.freeze([
  "chat.send",
  "chat.abort",
  "cockpit.pause",
  "cockpit.resume",
  "cockpit.drain",
  "cockpit.replay",
  "pipeline.create",
  "pipeline.update",
  "pipeline.transition",
  "contacts.update",
  "inbound.action",
  "inbound.draftSend",
  "drafts.approve",
  "drafts.reject",
  "proposals.approve",
  "proposals.reject",
  "flags.set",
]);
