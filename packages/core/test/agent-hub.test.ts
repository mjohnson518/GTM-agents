// GTM-agents: tests for the hub agent's chat turn: the system prompt, the tool loop, cost rows, the
// turn ceiling, the round limit, and session taint and history. The model is scripted and every
// page, person and address is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CHAT_JOB, runHubTurn, type HubAgentDeps } from "../src/agents/hub.ts";
import { clearSession, loadSession, raiseSessionTaint, sessionKeyFor, shapeHistory } from "../src/agents/sessions.ts";
import { memoryKv, scriptedModel, toolStep, type ScriptStep } from "../src/agents/testing.ts";
import type { BrainSlice } from "../src/brain/assemble.ts";
import { tokenCostMicroCents } from "../src/budget/cost-ledger.ts";
import { defineConfig } from "../src/config/index.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const PRICE = { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 };
const config = defineConfig({ ...acmeConfig, models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": PRICE } } });
const PAGE = "<html><head><title>Acme pricing</title></head><body><p>Acme has three plans. Team is $400 a month.</p></body></html>";
let n = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(n += 1)}`;

const brain: BrainSlice = { task: "strategist", version: "v-test", text: "GTM BRAIN (version v-test)\n### personas (v1)\n- economic-buyer: role: economic_buyer", included: ["personas"], missing: [], bytes: 60 };

function pageFetch(): typeof fetch {
  return () => Promise.resolve(new Response(PAGE, { headers: { "content-type": "text/html" } }));
}

function setup(steps: ScriptStep[], overrides: Partial<HubAgentDeps> = {}, flags: Record<string, string> = {}) {
  const kv = memoryKv(flags);
  const model = scriptedModel(steps);
  const chatId = uid("chat");
  const deps: HubAgentDeps = { db, kv, flags: { get: (k) => kv.get(k) }, config, model, fetch: pageFetch(), brain: () => Promise.resolve(brain), ...overrides };
  return { kv, model, deps, chatId, sessionKey: sessionKeyFor(chatId) };
}

describe("the hub agent's turn", () => {
  it("builds the system prompt from config and the approved brain, and puts tool output only in the user turn, fenced", async () => {
    const s = setup([toolStep({ name: "web_fetch", input: { url: "https://acme.example/pricing" } }), { text: "Acme has three plans; Team is $400 a month." }]);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Look at https://acme.example/pricing" });
    expect(turn.stop).toBe("end");
    const [first, second] = s.model.requests;
    expect(first?.role).toBe("strategist");
    expect(first?.model).toBe("test-strategist");
    expect(first?.system).toContain("You are Avery, the go-to-market agent for Acme (acme.example)");
    expect(first?.system).toContain("economic-buyer: role: economic_buyer");
    expect(first?.tools?.map((t) => t.name)).toEqual(["web_fetch", "contacts_search", "drafts_create"]);
    expect(second?.system).toBe(first?.system);
    expect(second?.system).not.toContain("three plans");
    const results = second?.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ type: "tool_result", toolCallId: "call_web_fetch_0" });
    expect(String(results[0]?.content)).toContain('<tool_output source="web_fetch" trust="untrusted"');
    expect(String(results[0]?.content)).toContain("Acme has three plans");
    expect(turn.reply).toContain("Acme has three plans");
  });

  it("writes one chat run row, and a cost row with the turn, run and job for every model call", async () => {
    const s = setup([toolStep({ name: "contacts_search", input: { query: "okafor" } }), { text: "No contacts yet." }]);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Who do we know at Acme?" });
    const run = await db.prepare("SELECT task_name, trigger, status, turn_id FROM execution_runs WHERE id = ?1").bind(turn.runId).first();
    expect(run).toEqual({ task_name: CHAT_JOB, trigger: "chat", status: "completed", turn_id: turn.turnId });
    const { results } = await db.prepare("SELECT run_id, turn_id, job, model, capability, cost_micro_cents FROM cost_events WHERE turn_id = ?1").bind(turn.turnId).all();
    const each = tokenCostMicroCents({ inputTokens: 1000, outputTokens: 200 }, PRICE);
    expect(results).toEqual([
      { run_id: turn.runId, turn_id: turn.turnId, job: CHAT_JOB, model: "test-strategist", capability: "model", cost_micro_cents: each },
      { run_id: turn.runId, turn_id: turn.turnId, job: CHAT_JOB, model: "test-strategist", capability: "model", cost_micro_cents: each },
    ]);
  });

  it("refuses a model with no price before calling it", async () => {
    const unpriced = defineConfig({ ...acmeConfig, models: { roles: { strategist: "unpriced-model" } } });
    const s = setup([{ text: "never" }], { config: unpriced });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "hello" });
    expect(turn.stop).toBe("unpriced");
    expect(turn.reply).toContain("models.pricing");
    expect(s.model.requests).toHaveLength(0);
    expect(await db.prepare("SELECT status FROM execution_runs WHERE id = ?1").bind(turn.runId).first()).toEqual({ status: "failed" });
  });

  it("declines when no strategist model is configured", async () => {
    const s = setup([{ text: "never" }], { config: defineConfig(acmeConfig) });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "hello" });
    expect(turn.stop).toBe("no_model");
    expect(s.model.requests).toHaveLength(0);
  });

  it("checks the turn ceiling before every model call", async () => {
    const s = setup([toolStep({ name: "contacts_search", input: { query: "acme" } }), { text: "never reached" }], {}, { "chat:turn_max_cents": "1" });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Search and summarize" });
    expect(turn.stop).toBe("turn_ceiling");
    expect(s.model.requests).toHaveLength(1);
    expect(s.model.remaining()).toBe(1);
    expect(turn.reply).toContain("spend ceiling");
  });

  it("stops at the turn ceiling even when cost rows cannot be written", async () => {
    const real = db;
    // Cost rows fail (bookkeeping fails open); everything else works.
    const noCosts = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => (sql.includes("INSERT INTO cost_events") ? target.prepare("INSERT INTO no_such_table VALUES (1)") : target.prepare(sql));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const step = toolStep({ name: "contacts_search", input: { query: "acme" } });
    const s = setup([step, step, step, step, step], { db: noCosts, maxRounds: 5 }, { "chat:turn_max_cents": "1" });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Keep searching" });
    expect(turn.stop).toBe("turn_ceiling");
    expect(s.model.requests).toHaveLength(1);
  });

  it("prices a call by the model that served it when that model has a price", async () => {
    const priced = defineConfig({ ...acmeConfig, models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": PRICE, "fallback-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } } });
    const s = setup([{ text: "Answered by the fallback.", model: "fallback-model" }], { config: priced });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "hello" });
    const row = await db.prepare("SELECT model, cost_micro_cents FROM cost_events WHERE turn_id = ?1").bind(turn.turnId).first();
    expect(row).toEqual({ model: "fallback-model", cost_micro_cents: tokenCostMicroCents({ inputTokens: 1000, outputTokens: 200 }, { inputCentsPerMTok: 100, outputCentsPerMTok: 500 }) });
  });

  it("stops at the round limit", async () => {
    const step = toolStep({ name: "contacts_search", input: { query: "acme" } });
    const s = setup([step, step, step], { maxRounds: 2 });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Keep searching" });
    expect(turn.stop).toBe("round_limit");
    expect(turn.rounds).toBe(2);
    expect(s.model.requests).toHaveLength(2);
  });

  it("sends the gateway's own assistant content back unchanged within the loop", async () => {
    const content = [{ type: "thinking", thinking: "", signature: "sig-test" }, { type: "tool_use", id: "toolu_1", name: "contacts_search", input: { query: "acme" } }];
    const s = setup([{ ...toolStep({ name: "contacts_search", input: { query: "acme" }, id: "toolu_1" }), content }, { text: "done" }]);
    await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Search" });
    expect(s.model.requests[1]?.messages.at(-2)).toEqual({ role: "assistant", content });
  });

  it("loads the session's taint at the start, never lowers it, and tells the model what the session refuses", async () => {
    const s = setup([{ text: "Here is what I know." }]);
    const state = await loadSession(db, s.sessionKey, s.chatId);
    await raiseSessionTaint(db, s.sessionKey, "full", state.clearedAt);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "What did that page say?" });
    expect(turn.startTaint).toBe("full");
    expect(turn.taint).toBe("full");
    expect((await loadSession(db, s.sessionKey, s.chatId)).taint).toBe("full");
    // A lower write never lowers it.
    const now = await loadSession(db, s.sessionKey, s.chatId);
    expect(await raiseSessionTaint(db, s.sessionKey, "none", now.clearedAt)).toBe(true);
    expect((await loadSession(db, s.sessionKey, s.chatId)).taint).toBe("full");
    const content = s.model.requests[0]?.messages.at(-1)?.content;
    expect(typeof content === "string" ? content : "").toContain("drafts_create will be refused until the operator sends /clean");
  });

  it("refuses a draft after a page read in the same turn, and core tells the operator to /clean", async () => {
    const s = setup([
      toolStep({ name: "web_fetch", input: { url: "https://acme.example/pricing" } }, { name: "drafts_create", input: { recipient_email: "jane@acme.example", subject: "Hi", body: "Team is $400." } }),
      { text: "I read the page but could not create the draft." },
    ]);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Read the page and draft to jane@acme.example" });
    expect(turn.refusedForTaint).toBe(true);
    expect(turn.drafts).toEqual([]);
    expect(turn.taint).toBe("full");
    expect(turn.reply).toContain("Send /clean to start a clean session");
    const results = s.model.requests[1]?.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(results[1]).toMatchObject({ isError: true });
    expect(String(results[1]?.content)).toContain("[ACTION BLOCKED] drafts_create was not run");
  });

  it("keeps the operator's message and the reply in history, and sends earlier turns as plain text pairs", async () => {
    const s = setup([{ text: "First answer." }, { text: "Second answer." }]);
    await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "First question" });
    const second = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Second question" });
    expect(second.historySaved).toBe(true);
    expect(s.model.requests[1]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second question" },
    ]);
  });

  it("writes nothing into a session that was cleared while the turn ran", async () => {
    const s = setup([]);
    s.deps.model = scriptedModel([
      async () => {
        await clearSession(db, s.sessionKey, s.chatId, new Date(Date.now() + 5));
        return toolStep({ name: "web_fetch", input: { url: "https://acme.example/pricing" } });
      },
      { text: "The page lists three plans." },
    ]);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Read the page" });
    expect(turn.taint).toBe("full");
    expect(turn.historySaved).toBe(false);
    const state = await loadSession(db, s.sessionKey, s.chatId);
    expect(state.taint).toBe("none");
    expect(state.messageCount).toBe(0);
  });

  it("ends the turn with a sanitized message and a failed run row when the model call fails", async () => {
    const s = setup([
      () => {
        throw new Error("upstream said Bearer sk-secret-value at https://internal.example/x");
      },
    ]);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "hello" });
    expect(turn.stop).toBe("model_error");
    expect(turn.reply).not.toContain("sk-secret-value");
    expect(turn.reply).not.toContain("internal.example");
    expect(await db.prepare("SELECT status FROM execution_runs WHERE id = ?1").bind(turn.runId).first()).toEqual({ status: "failed" });
  });

  it("does not run when the session cannot be read", async () => {
    const failing = { prepare: () => { throw new Error("D1_ERROR: unavailable"); }, batch: () => { throw new Error("D1_ERROR"); } } as unknown as D1Database;
    const s = setup([{ text: "never" }], { db: failing });
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "hello" });
    expect(turn.stop).toBe("session_unreadable");
    expect(s.model.requests).toHaveLength(0);
  });
});

describe("the hub agent's turn, streamed", () => {
  function streamingSetup(steps: ScriptStep[], flags: Record<string, string> = {}) {
    const s = setup(steps, {}, flags);
    const model = scriptedModel(steps, { stream: { chunkChars: 5 } });
    return { ...s, model, deps: { ...s.deps, model } };
  }

  it("streams each model call's text with its round while tools run as before, and decides the reply as without streaming", async () => {
    const steps: ScriptStep[] = [{ ...toolStep({ name: "web_fetch", input: { url: "https://acme.example/pricing" } }), text: "Reading the page." }, { text: "Acme has three plans." }];
    const s = streamingSetup(steps);
    const seen: Array<[string, number]> = [];
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Look at https://acme.example/pricing", onText: (text, round) => seen.push([text, round]) });
    expect(s.model.modes).toEqual(["stream", "stream"]);
    expect(seen.filter(([, r]) => r === 1).map(([t]) => t).join("")).toBe("Reading the page.");
    expect(seen.filter(([, r]) => r === 2).map(([t]) => t).join("")).toBe("Acme has three plans.");
    const results = s.model.requests[1]?.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(String(results[0]?.content)).toContain('<tool_output source="web_fetch" trust="untrusted"');

    const plain = setup(steps);
    const unstreamed = await runHubTurn(plain.deps, { sessionKey: plain.sessionKey, chatId: plain.chatId, text: "Look at https://acme.example/pricing" });
    expect(turn.reply).toBe(unstreamed.reply);
    const history = await loadSession(db, s.sessionKey, s.chatId, new Date());
    expect(history.history.map((m) => m.text)).toEqual(["Look at https://acme.example/pricing", turn.reply]);
  });

  it("records the cost of every streamed call with the turn, run and job", async () => {
    const s = streamingSetup([toolStep({ name: "contacts_search", input: { query: "okafor" } }), { text: "No contacts yet." }]);
    const turn = await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Who do we know at Acme?", onText: () => undefined });
    expect(s.model.modes).toEqual(["stream", "stream"]);
    const { results } = await db.prepare("SELECT run_id, job, cost_micro_cents FROM cost_events WHERE turn_id = ?1").bind(turn.turnId).all();
    const each = tokenCostMicroCents({ inputTokens: 1000, outputTokens: 200 }, PRICE);
    expect(results).toEqual([
      { run_id: turn.runId, job: CHAT_JOB, cost_micro_cents: each },
      { run_id: turn.runId, job: CHAT_JOB, cost_micro_cents: each },
    ]);
  });

  it("calls complete, not stream, when nobody watches the answer arrive", async () => {
    const s = streamingSetup([{ text: "Three plans." }]);
    await runHubTurn(s.deps, { sessionKey: s.sessionKey, chatId: s.chatId, text: "Plans?" });
    expect(s.model.modes).toEqual(["complete"]);
  });

  it("never lets a failing viewer fail the turn", async () => {
    const s = streamingSetup([{ text: "Three plans." }]);
    const turn = await runHubTurn(s.deps, {
      sessionKey: s.sessionKey,
      chatId: s.chatId,
      text: "Plans?",
      onText: () => {
        throw new Error("viewer gone");
      },
    });
    expect(turn.stop).toBe("end");
    expect(turn.reply).toBe("Three plans.");
  });
});

describe("shapeHistory", () => {
  it("starts with the operator, alternates roles and drops a trailing unanswered message", () => {
    expect(
      shapeHistory([
        { role: "assistant", text: "orphan" },
        { role: "user", text: "a" },
        { role: "user", text: "b" },
        { role: "assistant", text: "c" },
        { role: "user", text: "d" },
      ]),
    ).toEqual([
      { role: "user", text: "a\n\nb" },
      { role: "assistant", text: "c" },
    ]);
  });
});
