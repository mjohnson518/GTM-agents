// GTM-agents: an approval tap binds to the content the operator was shown. A tap whose digest no
// longer matches the draft (it was edited after it was shown), a tap whose digest was altered, and a
// tap on a draft that was never shown are all refused, and the draft stays pending. A good tap
// approves the draft and sends nothing.
import { recordingOperator } from "@gtm-agents/core/agents/testing";
import { approvalPayload, handleApprovalCallback, requestDraftApproval } from "@gtm-agents/core/operator";
import type { OperatorUpdate } from "@gtm-agents/core/ports";
import { draftDigest } from "@gtm-agents/core/security";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, uid } from "./helpers.ts";

const OPERATOR = "616161";

async function pendingDraft(body = "Hi Jane, setup takes under an hour."): Promise<{ id: string; content: { to: string; subject: string; body: string } }> {
  const id = uid("dr");
  const content = { to: "jane@acme.example", subject: "Setup in under an hour", body };
  await env.DB.prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status) VALUES (?1, 'warm_intro', ?2, ?3, ?4, 'pending_approval')").bind(id, content.to, content.subject, content.body).run();
  return { id, content };
}

function tap(payload: string, action = "approve"): Extract<OperatorUpdate, { type: "callback" }> {
  return { type: "callback", chatId: OPERATOR, userId: OPERATOR, action, payload, messageId: "1", callbackId: uid("cb") };
}

async function status(id: string): Promise<unknown> {
  return env.DB.prepare("SELECT status, approved_digest FROM drafts WHERE id = ?1").bind(id).first();
}

describe("approval taps", () => {
  it("refuse a stale digest: the draft changed after it was shown", async () => {
    const operator = recordingOperator();
    const shown = new MemoryKv();
    const deps = { db: env.DB, shown, operator: operator.channel };
    const { id } = await pendingDraft();
    const request = await requestDraftApproval(deps, id, OPERATOR);
    if (!request.ok) throw new Error(request.reason);
    // The draft is edited after the operator saw it.
    await env.DB.prepare("UPDATE drafts SET body = 'Hi Jane, wire the deposit today.' WHERE id = ?1").bind(id).run();
    const outcome = await handleApprovalCallback(deps, tap(approvalPayload(id, request.digest)));
    expect(outcome).toMatchObject({ outcome: "refused" });
    expect(await status(id)).toEqual({ status: "pending_approval", approved_digest: null });
    expect(operator.acks.at(-1)?.text).toContain("changed after it was shown");
    // A fresh request shows the current content, bound to its own digest.
    expect(operator.approvals.at(-1)?.preview).toContain("wire the deposit today");
    expect(operator.approvals.at(-1)?.digest).not.toBe(request.digest);
  });

  it("refuse a tap whose digest was altered", async () => {
    const operator = recordingOperator();
    const shown = new MemoryKv();
    const deps = { db: env.DB, shown, operator: operator.channel };
    const { id } = await pendingDraft();
    const request = await requestDraftApproval(deps, id, OPERATOR);
    if (!request.ok) throw new Error(request.reason);
    const forged = `${id}.${"f".repeat(32)}`;
    expect((await handleApprovalCallback(deps, tap(forged))).outcome).toBe("refused");
    expect(await status(id)).toEqual({ status: "pending_approval", approved_digest: null });
  });

  it("refuse a tap on a draft that was never shown, even with its correct digest", async () => {
    const operator = recordingOperator();
    const deps = { db: env.DB, shown: new MemoryKv(), operator: operator.channel };
    const { id, content } = await pendingDraft();
    const outcome = await handleApprovalCallback(deps, tap(approvalPayload(id, await draftDigest(content))));
    expect(outcome.outcome).toBe("refused");
    expect(await status(id)).toEqual({ status: "pending_approval", approved_digest: null });
  });

  it("refuse when the shown record cannot be read", async () => {
    const operator = recordingOperator();
    const shown = new MemoryKv();
    const deps = { db: env.DB, shown, operator: operator.channel };
    const { id } = await pendingDraft();
    const request = await requestDraftApproval(deps, id, OPERATOR);
    if (!request.ok) throw new Error(request.reason);
    shown.failing = true;
    expect((await handleApprovalCallback(deps, tap(approvalPayload(id, request.digest)))).outcome).toBe("refused");
    expect(await status(id)).toEqual({ status: "pending_approval", approved_digest: null });
  });

  it("approve exactly the content that was shown, and send nothing", async () => {
    const operator = recordingOperator();
    const deps = { db: env.DB, shown: new MemoryKv(), operator: operator.channel };
    const { id } = await pendingDraft();
    const request = await requestDraftApproval(deps, id, OPERATOR);
    if (!request.ok) throw new Error(request.reason);
    expect(await handleApprovalCallback(deps, tap(approvalPayload(id, request.digest)))).toEqual({ outcome: "approved", draftId: id });
    expect(await status(id)).toEqual({ status: "approved", approved_digest: request.digest });
    expect(operator.messages).toEqual([]);
    expect(await env.DB.prepare("SELECT sent_at FROM drafts WHERE id = ?1").bind(id).first()).toEqual({ sent_at: null });
  });
});
