// GTM-agents: the dashboard's inbound mail and draft methods.
//
// Approvals are bound to content. Every draft the dashboard is shown carries the digest of exactly
// its recipient, subject and body, and the server records that it was shown (markShown). An approve
// or send names the draft and echoes that digest back (`shownDigest`); approveShownDraft re-reads
// the draft, refuses when its current content has another digest or was not the content shown, and
// approves with the same compare-and-set as a chat approval. A send then goes through
// sendApprovedReply (replies/send.ts), which re-checks the approval digest, the thread's freshness
// and every send gate itself. Settling a message runs the reply commands' own code, so evidence,
// reminders and drafts close exactly as they do from the chat.
//
// Mail text (the sender, subject, preview and draft body) came from outside or from a model: it is
// returned as plain strings, and the dashboard renders it as text.
import { approveShownDraft, rejectDraftById } from "../operator/approvals.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { runReplyCommand } from "../replies/commands.ts";
import { REPLY_FLAGS, replyFlagOn } from "../replies/flags.ts";
import { describeSend } from "../replies/outbox.ts";
import { sendApprovedReply } from "../replies/send.ts";
import { draftDigest, markShown, wasShown } from "../security/approval-digest.ts";
import { RpcError, decodeCursor, encodeCursor, type GatewayContext, type Handler } from "./context.ts";
import type { DraftView } from "./protocol.ts";
import { tryBuild } from "./wiring.ts";

const PAGE = 25;
const OWED = ["new", "notified", "draft_created"];

interface DraftColumns {
  id: string;
  kind: string;
  recipient_email: string | null;
  subject: string | null;
  body: string | null;
  status: string;
}

/** The draft as shown, with its digest; an approvable draft is recorded as shown. */
async function draftView(ctx: GatewayContext, d: DraftColumns): Promise<DraftView> {
  const content = { to: d.recipient_email, subject: d.subject, body: d.body };
  const digest = await draftDigest(content);
  if ((d.status === "pending_approval" || d.status === "draft") && ctx.env.KV && !(await wasShown(ctx.env.KV, d.id, content))) {
    // Bookkeeping: if it is not recorded, an approval is refused (wasShown fails closed), never approved blind.
    await markShown(ctx.env.KV, d.id, content);
  }
  return { id: d.id, kind: d.kind, to: d.recipient_email ?? "", subject: d.subject ?? "", body: d.body ?? "", status: d.status, digest };
}

/** A channel for command code that does not notify: settling a message never sends a chat message. */
const silentChannel: OperatorChannel = {
  name: "dashboard",
  notify: () => Promise.reject(new Error("the dashboard does not send chat messages")),
  requestApproval: () => Promise.reject(new Error("the dashboard does not send chat messages")),
  editMessage: () => Promise.reject(new Error("the dashboard does not send chat messages")),
  acknowledgeCallback: () => Promise.resolve(),
  parseUpdate: () => Promise.resolve({ type: "ignored", reason: "dashboard" }),
  registerWebhook: () => Promise.resolve(),
};

function replyDeps(ctx: GatewayContext) {
  const { env, wiring } = ctx;
  const inbox = tryBuild(wiring.inbox, env);
  return {
    db: env.DB,
    kv: env.KV,
    shown: env.KV,
    flags: ctx.flags,
    config: wiring.config,
    operator: tryBuild(wiring.operator, env) ?? silentChannel,
    ...(inbox ? { inbox } : {}),
    unsubscribeSigningKey: env.UNSUBSCRIBE_SIGNING_KEY,
    baseUrl: env.AGENT_BASE_URL,
    now: ctx.now,
  };
}

interface InboundRow {
  id: string;
  sender_email: string;
  subject: string | null;
  body_preview: string | null;
  received_at: string;
  classification: string | null;
  intent: string | null;
  status: string;
  d_id: string | null;
  d_kind: string | null;
  d_to: string | null;
  d_subject: string | null;
  d_body: string | null;
  d_status: string | null;
}

export const inboundList: Handler<"inbound.list"> = async (p, ctx) => {
  const after = decodeCursor(p.cursor);
  const { results } = await ctx.env.DB.prepare(
    `SELECT i.id, i.sender_email, i.subject, i.body_preview, i.received_at, i.classification, i.intent, i.status,
            d.id AS d_id, d.kind AS d_kind, d.recipient_email AS d_to, d.subject AS d_subject, d.body AS d_body, d.status AS d_status
       FROM inbound_emails i LEFT JOIN drafts d ON d.id = i.draft_id
      WHERE (?1 IS NULL OR i.status = ?1) AND (?2 IS NULL OR i.received_at || '|' || i.id < ?2)
      ORDER BY i.received_at DESC, i.id DESC LIMIT ?3`,
  )
    .bind(p.status ?? null, after, PAGE + 1)
    .all<InboundRow>();
  const items = await Promise.all(
    results.slice(0, PAGE).map(async (r) => ({
      id: r.id,
      from: r.sender_email,
      subject: r.subject ?? "",
      preview: r.body_preview ?? "",
      receivedAt: r.received_at,
      classification: r.classification,
      intent: r.intent,
      status: r.status,
      ...(r.d_id && r.d_kind && r.d_status
        ? { draft: await draftView(ctx, { id: r.d_id, kind: r.d_kind, recipient_email: r.d_to, subject: r.d_subject, body: r.d_body, status: r.d_status }) }
        : {}),
    })),
  );
  const last = results[PAGE - 1];
  return { items, ...(results.length > PAGE && last ? { cursor: encodeCursor(`${last.received_at}|${last.id}`) } : {}) };
};

async function inboundStatus(ctx: GatewayContext, id: string): Promise<string | null> {
  const row = await ctx.env.DB.prepare("SELECT status FROM inbound_emails WHERE id = ?1").bind(id).first<{ status: string }>();
  return row?.status ?? null;
}

/** Settle a message through the reply commands' own code, then confirm the status it left. */
async function settle(ctx: GatewayContext, id: string, name: "reply_done" | "reply_ignore", expected: string): Promise<void> {
  const text = await runReplyCommand(replyDeps(ctx), { name, args: id }, { chatId: "dashboard", userId: ctx.state.email });
  if ((await inboundStatus(ctx, id)) !== expected) throw new RpcError("conflict", text.slice(0, 300));
}

export const inboundAction: Handler<"inbound.action"> = async (p, ctx) => {
  const status = await inboundStatus(ctx, p.id);
  ctx.audit.inboundId = p.id;
  ctx.audit.action = p.action;
  if (status === null) throw new RpcError("not_found", "no such message");
  const owed = OWED.includes(status);
  if (p.action === "done" || p.action === "ignore") {
    if (!owed) throw new RpcError("conflict", `that message is already ${status}`);
    await settle(ctx, p.id, p.action === "done" ? "reply_done" : "reply_ignore", p.action === "done" ? "responded" : "ignored");
    return { ok: true };
  }
  if (status === "archived") throw new RpcError("conflict", "that message is already archived");
  // Archiving an owed message first settles it as needing no answer, so its draft and reminders close.
  if (owed) await settle(ctx, p.id, "reply_ignore", "ignored");
  const result = await ctx.env.DB.prepare("UPDATE inbound_emails SET status = 'archived', updated_at = ?2 WHERE id = ?1 AND status IN ('responded', 'ignored')").bind(p.id, ctx.now().toISOString()).run();
  if ((result.meta.changes ?? 0) === 0) throw new RpcError("conflict", "that message changed state; reload it");
  return { ok: true };
};

/** Approve (when still pending) and send a reply draft, bound to the digest the dashboard showed. */
export const inboundDraftSend: Handler<"inbound.draftSend"> = async (p, ctx) => {
  ctx.audit.draftId = p.draftId;
  const draft = await ctx.env.DB.prepare("SELECT id, kind, recipient_email, subject, body, status, approved_digest FROM drafts WHERE id = ?1").bind(p.draftId).first<DraftColumns & { approved_digest: string | null }>();
  if (!draft) throw new RpcError("not_found", "no such draft");
  if (draft.kind !== "reply") throw new RpcError("invalid", "only reply drafts are sent from the inbound view");
  if (!(await replyFlagOn(ctx.flags, REPLY_FLAGS.send))) throw new RpcError("unavailable", `sending replies is turned off (${REPLY_FLAGS.send}); send it from your mailbox, then mark it done`);
  const current = await draftDigest({ to: draft.recipient_email, subject: draft.subject, body: draft.body });
  if (draft.status === "approved") {
    // Already approved (from the chat, or an earlier attempt): the shown digest must still be that approval.
    if (draft.approved_digest !== p.shownDigest || current !== p.shownDigest) throw new RpcError("conflict", "this draft changed after it was shown; reload it and review it again");
  } else {
    const approved = await approveShownDraft({ db: ctx.env.DB, shown: ctx.env.KV, now: ctx.now }, draft.id, p.shownDigest, ctx.actor);
    if (!approved.ok) throw new RpcError(approved.code === "not_found" ? "not_found" : "conflict", approved.reason);
    ctx.audit.approved = true;
  }
  const deps = replyDeps(ctx);
  const result = await sendApprovedReply(deps, draft.id);
  ctx.audit.result = result.status;
  return { status: result.status, message: describeSend(result, draft.recipient_email ?? "(unknown)") };
};

export const inboundStats: Handler<"inbound.stats"> = async (_p, ctx) => {
  const [byStatus, ready] = await Promise.all([
    ctx.env.DB.prepare("SELECT status, COUNT(*) AS n FROM inbound_emails GROUP BY status").all<{ status: string; n: number }>(),
    ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM inbound_emails i JOIN drafts d ON d.id = i.draft_id WHERE d.status = 'pending_approval'").first<{ n: number }>(),
  ]);
  const stats: Record<string, number> = {};
  let total = 0;
  for (const r of byStatus.results) {
    stats[r.status] = Number(r.n);
    total += Number(r.n);
  }
  return { total, ...stats, draftsReady: Number(ready?.n ?? 0) };
};

export const draftsList: Handler<"drafts.list"> = async (p, ctx) => {
  const after = decodeCursor(p.cursor);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, kind, recipient_email, subject, body, status, created_at FROM drafts
      WHERE status = ?1 AND (?4 IS NULL OR kind = ?4) AND (?2 IS NULL OR created_at || '|' || id < ?2) ORDER BY created_at DESC, id DESC LIMIT ?3`,
  )
    .bind(p.status ?? "pending_approval", after, PAGE + 1, p.kind ?? null)
    .all<DraftColumns & { created_at: string }>();
  const items = await Promise.all(results.slice(0, PAGE).map((d) => draftView(ctx, d)));
  const last = results[PAGE - 1];
  return { items, ...(results.length > PAGE && last ? { cursor: encodeCursor(`${last.created_at}|${last.id}`) } : {}) };
};

/**
 * Draft kinds whose approval belongs to the module that drafted them, because approving there also
 * re-checks the contact and sends (lifecycle follow-ups: fu-approve-<id> and fu-reject-<id>). The
 * dashboard lists them but never approves or rejects them through the generic path, which would leave
 * the module's own record open.
 */
export const OWN_APPROVAL_KINDS: ReadonlyMap<string, string> = new Map([["lifecycle", "a lifecycle follow-up is approved with fu-approve-<id> in the operator chat, which checks the contact again and sends it"]]);

/** Approve a draft. Approving marks it approved; nothing is sent. */
export const draftsApprove: Handler<"drafts.approve"> = async (p, ctx) => {
  ctx.audit.draftId = p.draftId;
  const row = await ctx.env.DB.prepare("SELECT kind FROM drafts WHERE id = ?1").bind(p.draftId).first<{ kind: string }>();
  if (!row) throw new RpcError("not_found", "no such draft");
  const owner = OWN_APPROVAL_KINDS.get(row.kind);
  if (owner) throw new RpcError("invalid", owner);
  const approved = await approveShownDraft({ db: ctx.env.DB, shown: ctx.env.KV, now: ctx.now }, p.draftId, p.shownDigest, ctx.actor);
  if (!approved.ok) throw new RpcError(approved.code === "not_found" ? "not_found" : "conflict", approved.reason);
  return { status: "approved", message: "Approved. Nothing was sent." };
};

export const draftsReject: Handler<"drafts.reject"> = async (p, ctx) => {
  ctx.audit.draftId = p.draftId;
  const row = await ctx.env.DB.prepare("SELECT kind FROM drafts WHERE id = ?1").bind(p.draftId).first<{ kind: string }>();
  if (!row) throw new RpcError("not_found", "no such draft");
  // Rejecting one of these also closes the owning module's record (fu-reject-<id>), so it is done there.
  const owner = OWN_APPROVAL_KINDS.get(row.kind);
  if (owner) throw new RpcError("invalid", owner.replace("is approved with fu-approve-<id>", "is approved with fu-approve-<id> or dropped with fu-reject-<id>"));
  const rejected = await rejectDraftById({ db: ctx.env.DB, now: ctx.now }, p.draftId);
  if (!rejected.ok) throw new RpcError(rejected.code === "not_found" ? "not_found" : "conflict", rejected.reason);
  return { ok: true };
};
