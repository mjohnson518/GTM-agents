// GTM-agents: decision lines. With operator:decision_lines_enabled on, a draft a hub turn created
// remembers its session, and approving or rejecting it (a tap, or the dashboard) writes one line into
// that session, which the next turn sees in front of the operator's message and later turns see in
// the history. Off, cleared since, refused, or a draft no turn created: no line. A line that cannot be
// written never changes the decision. The model is scripted and every address is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DECISION_LINES_FLAG, decisionLine, isDecisionLinesEnabled, writeDecisionLine } from "../src/agents/decisions.ts";
import { runHubTurn, type HubAgentDeps } from "../src/agents/hub.ts";
import { HISTORY_LIMIT, SYSTEM_LINES_LIMIT, clearSession, loadSession, sessionKeyFor, systemMessageContent } from "../src/agents/sessions.ts";
import { memoryKv, recordingOperator, scriptedModel, toolStep, type ScriptStep } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { findFlag } from "../src/flags/registry.ts";
import type { OperatorUpdate } from "../src/ports/operator.ts";
import { approvalPayload } from "../src/operator/approval-payload.ts";
import { approveShownDraft, handleApprovalCallback, rejectDraftById, requestDraftApproval } from "../src/operator/approvals.ts";
import { draftDigest, markShown } from "../src/security/approval-digest.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const config = defineConfig({ ...acmeConfig, models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } } });
const ON = { [DECISION_LINES_FLAG]: "true" };
const AT = new Date("2026-11-15T12:40:00.000Z");
let n = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(n += 1)}`;

const drafting = (to = "jane@globex.example"): ScriptStep[] => [
  toolStep({ name: "drafts_create", input: { recipient_email: to, subject: "Flaky builds", body: "Hi Jane,\n\nA short note.\n\nAvery" } }),
  { text: "Saved a draft for Jane." },
];

function chat(flags: Record<string, string> = ON) {
  const kv = memoryKv(flags);
  const chatId = uid("chat");
  const sessionKey = sessionKeyFor(chatId);
  const shown = memoryKv();
  const operator = recordingOperator();
  const reader = { get: (k: string) => kv.get(k) };
  const turn = async (steps: ScriptStep[], text = "Draft a short note to Jane at Globex.", overrides: Partial<HubAgentDeps> = {}) => {
    const model = scriptedModel(steps);
    const deps: HubAgentDeps = { db, kv, flags: reader, config, model, brain: () => Promise.resolve(null), ...overrides };
    const result = await runHubTurn(deps, { sessionKey, chatId, text });
    return { result, model };
  };
  const approvals = { db, shown, operator: operator.channel, flags: reader, now: () => AT };
  /** Show the draft in the chat and tap a button on it. */
  const tap = async (draftId: string, action: "approve" | "reject" = "approve") => {
    const request = await requestDraftApproval(approvals, draftId, chatId);
    if (!request.ok) throw new Error(request.reason);
    const update: Extract<OperatorUpdate, { type: "callback" }> = { type: "callback", chatId, userId: chatId, action, payload: approvalPayload(draftId, request.digest), messageId: "1", callbackId: uid("cb") };
    return handleApprovalCallback(approvals, update);
  };
  return { kv, chatId, sessionKey, shown, operator, reader, turn, tap, approvals };
}

async function systemRows(sessionKey: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT role, content FROM chat_messages WHERE session_key = ?1 ORDER BY id").bind(sessionKey).all<{ role: string; content: string }>();
  return results.flatMap((r) => {
    const parsed = JSON.parse(r.content) as { text: string; from?: string };
    return parsed.from === "system" ? [`${r.role}:${parsed.text}`] : [];
  });
}

const asText = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));
const lastUserText = (model: ReturnType<typeof scriptedModel>) => asText(model.requests[0]?.messages.at(-1)?.content);

describe("decision lines", () => {
  it("are behind operator:decision_lines_enabled, registered and off by default, and off when the flag cannot be read", async () => {
    expect(findFlag(DECISION_LINES_FLAG)).toMatchObject({ kind: "boolean", default: "false" });
    expect(await isDecisionLinesEnabled(undefined)).toBe(false);
    expect(await isDecisionLinesEnabled({ get: () => Promise.resolve(null) })).toBe(false);
    expect(await isDecisionLinesEnabled({ get: () => Promise.reject(new Error("kv down")) })).toBe(false);
    expect(await isDecisionLinesEnabled({ get: () => Promise.resolve("true") })).toBe(true);
  });

  it("name the draft, its kind and recipient, the decision and the time, and leave out a recipient that is not one plain address", () => {
    expect(decisionLine("approved", { id: "dr_1", kind: "warm_intro", recipient_email: "Jane@Globex.example" }, AT)).toBe(
      "[Decision from the system: at 2026-11-15 12:40 UTC the operator approved draft dr_1 (warm_intro to jane@globex.example). Approving does not send it.]",
    );
    expect(decisionLine("rejected", { id: "dr_2", kind: "check_in", recipient_email: "two@a.example, three@b.example" }, AT)).toBe(
      "[Decision from the system: at 2026-11-15 12:40 UTC the operator rejected draft dr_2 (check_in). It will not be sent.]",
    );
  });

  it("reach the next turn after an approval tap, in front of the operator's message, and later turns in the history", async () => {
    const c = chat();
    const { result } = await c.turn(drafting());
    const draftId = result.drafts[0]?.id ?? "";
    expect(await db.prepare("SELECT session_key, session_cleared_at, turn_id FROM chat_draft_origins WHERE draft_id = ?1").bind(draftId).first()).toEqual({
      session_key: c.sessionKey,
      session_cleared_at: null,
      turn_id: result.turnId,
    });
    expect((await c.tap(draftId)).outcome).toBe("approved");
    const line = `[Decision from the system: at 2026-11-15 12:40 UTC the operator approved draft ${draftId} (warm_intro to jane@globex.example). Approving does not send it.]`;
    expect(await systemRows(c.sessionKey)).toEqual([`user:${line}`]);

    // The next turn: the line is not dropped as an unanswered message; it leads the operator's message.
    const state = await loadSession(db, c.sessionKey, c.chatId);
    expect(state.pending).toEqual([line]);
    expect(state.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    const next = await c.turn([{ text: "Noted, it is approved." }], "What happened to the Jane draft?");
    expect(lastUserText(next.model)).toBe(`${line}\n\nWhat happened to the Jane draft?`);

    // Later turns: it is history, joined in front of the message that followed it, and no longer pending.
    const later = await c.turn([{ text: "ok" }], "thanks");
    const messages = later.model.requests[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[2]?.content).toBe(`${line}\n\nWhat happened to the Jane draft?`);
    expect(messages.at(-1)?.content).toBe("thanks");
    expect((await loadSession(db, c.sessionKey, c.chatId)).pending).toEqual([]);
  });

  it("report a rejection tap, and a dashboard approval or rejection, into the session that created the draft", async () => {
    const c = chat();
    const first = await c.turn(drafting("ana@initech.example"));
    const second = await c.turn(drafting("bo@umbrella.example"));
    const third = await c.turn(drafting("cy@hooli.example"));
    const [a, b, d] = [first, second, third].map((t) => t.result.drafts[0]?.id ?? "");
    expect((await c.tap(a ?? "", "reject")).outcome).toBe("rejected");
    // The dashboard: shown with its digest, then approved, and another rejected by id.
    const row = await db.prepare("SELECT recipient_email AS 'to', subject, body FROM drafts WHERE id = ?1").bind(b).first<{ to: string; subject: string; body: string }>();
    if (!row) throw new Error("draft missing");
    await markShown(c.shown, b ?? "", row);
    expect(await approveShownDraft({ db, shown: c.shown, flags: c.reader, now: () => AT }, b ?? "", await draftDigest(row), "operator:ops@acme.example")).toEqual({ ok: true, draftId: b });
    expect(await rejectDraftById({ db, flags: c.reader, now: () => AT }, d ?? "")).toEqual({ ok: true, draftId: d });
    const rows = await systemRows(c.sessionKey);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(`operator rejected draft ${a} (warm_intro to ana@initech.example). It will not be sent.`);
    expect(rows[1]).toContain(`operator approved draft ${b} (warm_intro to bo@umbrella.example).`);
    expect(rows[2]).toContain(`operator rejected draft ${d} (warm_intro to cy@hooli.example).`);
    const state = await loadSession(db, c.sessionKey, c.chatId);
    expect(state.pending).toHaveLength(3);
  });

  it("are not written when the flag is off when the draft is created, or when the decision is made", async () => {
    const off = chat({});
    const { result } = await off.turn(drafting());
    const id = result.drafts[0]?.id ?? "";
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chat_draft_origins WHERE draft_id = ?1").bind(id).first()).toEqual({ n: 0 });
    off.kv.map.set(DECISION_LINES_FLAG, "true");
    expect((await off.tap(id)).outcome).toBe("approved");
    expect(await systemRows(off.sessionKey)).toEqual([]);

    const on = chat();
    const later = await on.turn(drafting());
    on.kv.map.delete(DECISION_LINES_FLAG);
    expect((await on.tap(later.result.drafts[0]?.id ?? "")).outcome).toBe("approved");
    expect(await systemRows(on.sessionKey)).toEqual([]);
  });

  it("never reach a session cleared since the draft was created, nor one cleared during the turn that created it", async () => {
    const c = chat();
    const { result } = await c.turn(drafting());
    await clearSession(db, c.sessionKey, c.chatId, new Date(AT.getTime() - 60_000));
    expect((await c.tap(result.drafts[0]?.id ?? "")).outcome).toBe("approved");
    expect(await systemRows(c.sessionKey)).toEqual([]);
    const next = await c.turn([{ text: "ok" }], "hello");
    expect(lastUserText(next.model)).toBe("hello");

    // A /clean while the turn runs: the turn's taint is not recorded, so no origin is either.
    const d = chat();
    const clearing: HubAgentDeps["handlers"] = ({ onDraftCreated }) => ({
      drafts_create: async () => {
        const id = uid("dr_");
        await db.prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status) VALUES (?1, 'warm_intro', 'jane@globex.example', 'Hi', 'Hello', 'pending_approval')").bind(id).run();
        onDraftCreated({ id, recipientEmail: "jane@globex.example" });
        await clearSession(db, d.sessionKey, d.chatId);
        return `Draft ${id} created.`;
      },
    });
    const cleared = await d.turn(drafting(), "Draft it.", { handlers: clearing });
    expect(cleared.result.historySaved).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chat_draft_origins WHERE draft_id = ?1").bind(cleared.result.drafts[0]?.id ?? "").first()).toEqual({ n: 0 });
  });

  it("are not written for a refused tap, nor for a draft no turn created", async () => {
    const c = chat();
    const { result } = await c.turn(drafting());
    const id = result.drafts[0]?.id ?? "";
    const request = await requestDraftApproval(c.approvals, id, c.chatId);
    if (!request.ok) throw new Error(request.reason);
    await db.prepare("UPDATE drafts SET body = 'Hi Jane, wire the deposit today.' WHERE id = ?1").bind(id).run();
    const stale = await handleApprovalCallback(c.approvals, { type: "callback", chatId: c.chatId, userId: c.chatId, action: "approve", payload: approvalPayload(id, request.digest), messageId: "1", callbackId: uid("cb") });
    expect(stale.outcome).toBe("refused");
    expect(await systemRows(c.sessionKey)).toEqual([]);

    // A reply drafted from inbound mail: approved in this chat, but no turn created it.
    const reply = uid("dr_");
    await db.prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status) VALUES (?1, 'reply', 'sender@prospect.example', 'Re: pricing', 'Thanks for writing.', 'pending_approval')").bind(reply).run();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM chat_messages").first<{ n: number }>();
    expect((await c.tap(reply)).outcome).toBe("approved");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chat_messages").first<{ n: number }>()).toEqual(before);
    expect(await writeDecisionLine(db, { id: reply, kind: "reply", recipient_email: "sender@prospect.example" }, "approved", AT)).toBe(false);
  });

  it("never change the decision when the line cannot be written", async () => {
    const c = chat();
    const { result } = await c.turn(drafting());
    const id = result.drafts[0]?.id ?? "";
    const warnings: string[] = [];
    // A database that refuses every statement about origins, as one without migration 0034 would.
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("chat_draft_origins")) throw new Error("no such table: chat_draft_origins");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const deps = { ...c.approvals, db: broken, logger: { warn: (msg: string) => void warnings.push(msg) } };
    const request = await requestDraftApproval(deps, id, c.chatId);
    if (!request.ok) throw new Error(request.reason);
    const outcome = await handleApprovalCallback(deps, { type: "callback", chatId: c.chatId, userId: c.chatId, action: "approve", payload: approvalPayload(id, request.digest), messageId: "1", callbackId: uid("cb") });
    expect(outcome.outcome).toBe("approved");
    expect(await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(id).first()).toEqual({ status: "approved" });
    expect(warnings).toContain("the decision line could not be written to the chat session");
    expect(await systemRows(c.sessionKey)).toEqual([]);
  });

  it("keep an unanswered operator message out of the history, as before, and join a line written mid-history", async () => {
    const chatId = uid("chat");
    const key = sessionKeyFor(chatId);
    await clearSession(db, key, chatId);
    const put = (role: string, content: string) => db.prepare("INSERT INTO chat_messages (session_key, role, content) VALUES (?1, ?2, ?3)").bind(key, role, content).run();
    await put("user", JSON.stringify({ text: "first" }));
    await put("assistant", JSON.stringify({ text: "reply one" }));
    await put("user", systemMessageContent("[Decision from the system: one]"));
    await put("user", JSON.stringify({ text: "second" }));
    await put("assistant", JSON.stringify({ text: "reply two" }));
    await put("user", JSON.stringify({ text: "unanswered" }));
    const state = await loadSession(db, key, chatId);
    expect(state.pending).toEqual([]);
    expect(state.history).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "reply one" },
      { role: "user", text: "[Decision from the system: one]\n\nsecond" },
      { role: "assistant", text: "reply two" },
    ]);
  });

  it("never crowd the conversation out of the history window, and count the lines a turn does not load", async () => {
    const chatId = uid("chat");
    const key = sessionKeyFor(chatId);
    await clearSession(db, key, chatId);
    const stmts = [];
    for (let i = 0; i < 25; i += 1) {
      stmts.push(db.prepare("INSERT INTO chat_messages (session_key, role, content) VALUES (?1, 'user', ?2)").bind(key, JSON.stringify({ text: `q${i}` })));
      stmts.push(db.prepare("INSERT INTO chat_messages (session_key, role, content) VALUES (?1, 'assistant', ?2)").bind(key, JSON.stringify({ text: `a${i}` })));
    }
    for (let i = 0; i < SYSTEM_LINES_LIMIT + 5; i += 1) stmts.push(db.prepare("INSERT INTO chat_messages (session_key, role, content) VALUES (?1, 'user', ?2)").bind(key, systemMessageContent(`[Decision from the system: line ${i}]`)));
    await db.batch(stmts);
    const state = await loadSession(db, key, chatId);
    expect(state.history).toHaveLength(HISTORY_LIMIT);
    expect(state.history.at(-1)).toEqual({ role: "assistant", text: "a24" });
    expect(state.messageCount).toBe(50);
    expect(state.pending).toHaveLength(SYSTEM_LINES_LIMIT + 1);
    expect(state.pending[0]).toContain("5 earlier decisions on drafts are not shown here");
    expect(state.pending[1]).toBe("[Decision from the system: line 5]");
    expect(state.pending.at(-1)).toBe(`[Decision from the system: line ${SYSTEM_LINES_LIMIT + 4}]`);
  });

  it("leave the turn untouched when origins cannot be recorded", async () => {
    const c = chat();
    const warnings: string[] = [];
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("chat_draft_origins")) throw new Error("no such table: chat_draft_origins");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { result } = await c.turn(drafting(), "Draft it.", { db: broken, logger: { info: () => {}, warn: (msg: string) => void warnings.push(msg), error: () => {} } });
    expect(result.stop).toBe("end");
    expect(result.historySaved).toBe(true);
    expect(result.reply).toBe("Saved a draft for Jane.");
    expect(result.drafts).toHaveLength(1);
    expect(warnings).toContain("draft origins could not be recorded; decisions on these drafts will not reach the session");
  });

  it("record a timer turn's drafts under the taint it started at, and show a timer turn the waiting lines", async () => {
    const c = chat();
    const first = await c.turn(drafting());
    expect((await c.tap(first.result.drafts[0]?.id ?? "")).outcome).toBe("approved");
    const model = scriptedModel(drafting("ana@initech.example"));
    const timerTurn = await runHubTurn(
      { db, kv: c.kv, flags: c.reader, config, model, brain: () => Promise.resolve(null) },
      { sessionKey: c.sessionKey, chatId: c.chatId, text: "[Timer from the system] check on Jane", taintFloor: "metadata", requireClearedAt: null },
    );
    expect(timerTurn.taint).toBe("metadata");
    expect(lastUserText(model).startsWith("[Decision from the system: at 2026-11-15 12:40 UTC the operator approved draft")).toBe(true);
    expect((await loadSession(db, c.sessionKey, c.chatId)).taint).toBe("metadata");
    expect(await db.prepare("SELECT session_key FROM chat_draft_origins WHERE draft_id = ?1").bind(timerTurn.drafts[0]?.id ?? "").first()).toEqual({ session_key: c.sessionKey });
  });

  it("write the line when the turn ends for a draft decided while its turn was still running, and never bind an older draft", async () => {
    const c = chat();
    const older = uid("dr_");
    await db.prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status, created_at) VALUES (?1, 'reply', 'sender@prospect.example', 'Re', 'Hi', 'pending_approval', '2026-01-01T00:00:00.000Z')").bind(older).run();
    const early: HubAgentDeps["handlers"] = ({ onDraftCreated }) => ({
      drafts_create: async () => {
        const id = uid("dr_");
        await db.prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status) VALUES (?1, 'warm_intro', 'jane@globex.example', 'Hi', 'Hello', 'pending_approval')").bind(id).run();
        onDraftCreated({ id, recipientEmail: "jane@globex.example" });
        onDraftCreated({ id: older, recipientEmail: "sender@prospect.example" });
        // The dashboard rejects it before the turn ends.
        expect(await rejectDraftById({ db, flags: c.reader, now: () => AT }, id)).toEqual({ ok: true, draftId: id });
        return `Draft ${id} created.`;
      },
    });
    const { result } = await c.turn(drafting(), "Draft it.", { handlers: early });
    const id = result.drafts[0]?.id ?? "";
    const rows = await systemRows(c.sessionKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`operator rejected draft ${id} (warm_intro to jane@globex.example)`);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chat_draft_origins WHERE draft_id = ?1").bind(older).first()).toEqual({ n: 0 });
  });
});

