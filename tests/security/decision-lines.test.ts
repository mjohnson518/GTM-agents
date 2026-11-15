// GTM-agents: a decision line can never carry text into a session that has not already seen it. The
// line names a draft's recipient, so it is written only into the session whose turn created that
// draft, after that turn's taint was recorded, and only while the session has not been cleared since:
// never into the chat where the button was tapped when another session made the draft, never into a
// session /clean ended, and never for a draft no turn created (a reply to inbound mail), whose
// recipient came from third-party text no session read.
import { DECISION_LINES_FLAG, clearSession, loadSession, runHubTurn, sessionKeyFor, type HubAgentDeps } from "@gtm-agents/core/agents";
import { memoryKv, recordingOperator, scriptedModel, toolStep } from "@gtm-agents/core/agents/testing";
import { defineConfig } from "@gtm-agents/core/config";
import { approvalPayload, handleApprovalCallback, requestDraftApproval } from "@gtm-agents/core/operator";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uid } from "./helpers.ts";

const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example" },
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    domain: "outreach.acme.example",
  },
  models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } },
});

const kv = memoryKv({ [DECISION_LINES_FLAG]: "true" });
const flags = { get: (k: string) => kv.get(k) };

/** A turn in `chatId` that looks a contact up (metadata taint) and drafts to them. */
async function draftIn(chatId: string): Promise<string> {
  const model = scriptedModel([
    toolStep({ name: "contacts_search", input: { query: "okafor" } }),
    toolStep({ name: "drafts_create", input: { recipient_email: "ada.okafor@globex.example", subject: "Flaky builds", body: "Hi Ada,\n\nA short note.\n\nAvery" } }),
    { text: "Drafted." },
  ]);
  const deps: HubAgentDeps = { db: env.DB, kv, flags, config, model, brain: () => Promise.resolve(null) };
  const turn = await runHubTurn(deps, { sessionKey: sessionKeyFor(chatId), chatId, text: "Look up Ada Okafor and draft her a note." });
  const id = turn.drafts[0]?.id;
  if (!id) throw new Error("no draft was created");
  return id;
}

async function approveIn(chatId: string, draftId: string): Promise<string> {
  const operator = recordingOperator();
  const approvals = { db: env.DB, shown: memoryKv(), operator: operator.channel, flags };
  const request = await requestDraftApproval(approvals, draftId, chatId);
  if (!request.ok) throw new Error(request.reason);
  const outcome = await handleApprovalCallback(approvals, { type: "callback", chatId, userId: chatId, action: "approve", payload: approvalPayload(draftId, request.digest), messageId: "1", callbackId: uid("cb") });
  return outcome.outcome;
}

async function lines(chatId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT content FROM chat_messages WHERE session_key = ?1 ORDER BY id").bind(sessionKeyFor(chatId)).all<{ content: string }>();
  return results.map((r) => JSON.parse(r.content) as { text: string; from?: string }).flatMap((m) => (m.from === "system" ? [m.text] : []));
}

describe("decision lines", () => {
  it("reach only the session that created the draft, already at the taint of the record it was drafted from", async () => {
    const maker = uid("chat");
    const tapper = uid("chat");
    const id = await draftIn(maker);
    expect(await approveIn(tapper, id)).toBe("approved");
    expect(await lines(tapper)).toEqual([]);
    const written = await lines(maker);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("ada.okafor@globex.example");
    // The session the address reached had read the contact record it came from.
    expect((await loadSession(env.DB, sessionKeyFor(maker), maker)).taint).toBe("metadata");
  });

  it("never reach a session cleared after the draft was created", async () => {
    const chatId = uid("chat");
    const id = await draftIn(chatId);
    await clearSession(env.DB, sessionKeyFor(chatId), chatId);
    expect(await approveIn(chatId, id)).toBe("approved");
    expect(await lines(chatId)).toEqual([]);
    const state = await loadSession(env.DB, sessionKeyFor(chatId), chatId);
    expect(state.taint).toBe("none");
    expect(state.pending).toEqual([]);
  });

  it("are never written for a draft no turn created, even when it is approved in a chat", async () => {
    const chatId = uid("chat");
    const reply = uid("dr");
    await env.DB.prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status) VALUES (?1, 'reply', 'sender@prospect.example', 'Re: pricing', 'Thanks for writing.', 'pending_approval')")
      .bind(reply)
      .run();
    expect(await approveIn(chatId, reply)).toBe("approved");
    expect(await lines(chatId)).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE instr(content, 'sender@prospect.example') > 0").first()).toEqual({ n: 0 });
  });
});
