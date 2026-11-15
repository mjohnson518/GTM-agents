// GTM-agents: tests for messages sent in a row: how a chat queue delivery is split into runs, how a
// message is routed before anything runs, and that a run is only ever one turn of messages for the
// model from one operator in one session. Chat and user ids are invented.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv, recordingOperator, recordingQueue, scriptedModel } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import type { ChatMessage, Env } from "../src/env.ts";
import { AGENT_DISABLED_TEXT, CHAT_BATCHING_FLAG, isChatBatchingEnabled } from "../src/operator/access.ts";
import { CHAT_DELIVERY_BUDGET_MS, CHAT_RUN_MAX_CHARS, CHAT_RUN_SEPARATOR, createChatConsumer, orderByChat, planChatRuns, processChatRun, routeChatText, type OperatorAgentOptions } from "../src/operator/chat.ts";
import type { ModuleCommand } from "../src/operator/module-commands.ts";
import { acmeConfig } from "./fixtures.ts";

let n = 0;
function msg(text: string, who: { chatId?: string; userId?: string; sessionKey?: string } = {}): ChatMessage {
  n += 1;
  const chatId = who.chatId ?? "910000001";
  return { updateId: `batching:${Date.now()}:${n}`, chatId, userId: who.userId ?? chatId, sessionKey: who.sessionKey ?? `chat:${chatId}`, text };
}
const forModel = (text: string) => routeChatText({}, text).kind === "turn";
const texts = (runs: ChatMessage[][]) => runs.map((run) => run.map((m) => m.text));
const plan = (messages: ChatMessage[], joinable: (text: string) => boolean = forModel) => planChatRuns(messages, (m) => m, joinable);

describe("planChatRuns", () => {
  it("keeps every message its own run when nothing may be joined", () => {
    const messages = [msg("find contacts at acme.example"), msg("and at globex.example")];
    expect(texts(plan(messages, () => false))).toEqual([["find contacts at acme.example"], ["and at globex.example"]]);
  });

  it("joins adjacent messages for the model from one operator in one session", () => {
    const messages = [msg("find contacts at acme.example"), msg("and at globex.example"), msg("then draft an intro to the first")];
    expect(texts(plan(messages))).toEqual([["find contacts at acme.example", "and at globex.example", "then draft an intro to the first"]]);
  });

  it("never lets a run cross a command, so order around /clean holds", () => {
    const messages = [msg("read https://acme.example/pricing"), msg("/clean"), msg("draft an intro to jane@acme.example")];
    expect(texts(plan(messages))).toEqual([["read https://acme.example/pricing"], ["/clean"], ["draft an intro to jane@acme.example"]]);
  });

  it("keeps commands apart from each other and from the model", () => {
    const messages = [msg("/status"), msg("/help"), msg("summarize the pipeline"), msg("/scorecard")];
    expect(texts(plan(messages))).toEqual([["/status"], ["/help"], ["summarize the pipeline"], ["/scorecard"]]);
  });

  it("joins only the same operator in the same chat and session", () => {
    const group = "-910000002";
    const messages = [
      msg("one", { chatId: group, userId: "910000003" }),
      msg("two", { chatId: group, userId: "910000004" }),
      msg("three", { chatId: group, userId: "910000004" }),
      msg("four", { chatId: group, userId: "910000004", sessionKey: "chat:other" }),
    ];
    expect(texts(plan(messages))).toEqual([["one"], ["two", "three"], ["four"]]);
  });

  it("joins only adjacent messages, keeping the delivery order across chats", () => {
    const a = { chatId: "910000005" };
    const b = { chatId: "910000006" };
    const messages = [msg("a1", a), msg("b1", b), msg("a2", a)];
    expect(texts(plan(messages))).toEqual([["a1"], ["b1"], ["a2"]]);
  });

  it("starts a new run before the joined text would pass the limit", () => {
    const half = Math.floor((CHAT_RUN_MAX_CHARS - CHAT_RUN_SEPARATOR.length) / 2);
    const fits = [msg("x".repeat(half)), msg("y".repeat(CHAT_RUN_MAX_CHARS - CHAT_RUN_SEPARATOR.length - half))];
    expect(plan(fits)).toHaveLength(1);
    const over = [msg("x".repeat(half)), msg("y".repeat(CHAT_RUN_MAX_CHARS - CHAT_RUN_SEPARATOR.length - half + 1)), msg("z")];
    expect(texts(plan(over)).map((run) => run.length)).toEqual([1, 2]);
  });

  it("leaves a message longer than the limit alone, as without merging", () => {
    const long = msg("w".repeat(CHAT_RUN_MAX_CHARS + 1));
    expect(plan([msg("short"), long, msg("after")]).map((run) => run.length)).toEqual([1, 1, 1]);
  });
});

describe("routeChatText", () => {
  it("routes commands before the model, in the handler's order", () => {
    expect(routeChatText({}, "summarize the pipeline").kind).toBe("turn");
    expect(routeChatText({}, "/status").kind).toBe("command");
    expect(routeChatText({}, "/clean@AcmeBot").kind).toBe("command");
    expect(routeChatText({}, "/unknowncmd").kind).toBe("command");
    expect(routeChatText({}, "/replies").kind).toBe("reply");
    expect(routeChatText({}, "/scorecard").kind).toBe("report");
    expect(routeChatText({}, "autonomy-status").kind).toBe("autonomy");
    expect(routeChatText({}, "sequence-release-sq20261109-1a2b3c").kind).toBe("sequence");
  });

  it("routes a module command before the model, and never ahead of a built-in", () => {
    const commands: ModuleCommand[] = [{ module: "acme-test", helpLines: [], match: (text) => (text === "acme-ping" ? () => Promise.resolve("pong") : null) }];
    expect(routeChatText({ commands }, "acme-ping").kind).toBe("module");
    expect(routeChatText({ commands }, "acme-pings").kind).toBe("turn");
    expect(routeChatText({ commands }, "/status").kind).toBe("command");
  });
});

describe("isChatBatchingEnabled", () => {
  it("is on only when the flag reads as on", async () => {
    expect(await isChatBatchingEnabled({ get: () => Promise.resolve("true") })).toBe(true);
    expect(await isChatBatchingEnabled({ get: () => Promise.resolve(null) })).toBe(false);
    expect(await isChatBatchingEnabled({ get: () => Promise.resolve("false") })).toBe(false);
    expect(await isChatBatchingEnabled({ get: () => Promise.reject(new Error("kv down")) })).toBe(false);
    expect(CHAT_BATCHING_FLAG).toBe("operator:chat_batching");
  });
});

describe("processChatRun", () => {
  const OPERATOR = "910000007";
  const config = defineConfig({
    ...acmeConfig,
    models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } },
    operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] },
  });
  const setup = (steps: Parameters<typeof scriptedModel>[0]) => {
    const operator = recordingOperator();
    const model = scriptedModel(steps);
    const testEnv = { ...(env as unknown as Env), KV: memoryKv({ "operator:agent_enabled": "true" }) as unknown as KVNamespace };
    return { operator, model, testEnv, options: { config, operator: () => operator.channel, model: () => model } };
  };
  const who = { chatId: OPERATOR, sessionKey: `chat:${OPERATOR}:${Date.now()}` };

  it("runs one turn on the messages joined by a blank line, and runs a redelivered message in no turn", async () => {
    const h = setup([{ text: "Both are in hand." }]);
    const run = [msg("find contacts at acme.example", who), msg("and at globex.example", who)];
    await processChatRun(h.options, h.testEnv, run);
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]?.messages).toEqual([{ role: "user", content: "find contacts at acme.example\n\nand at globex.example" }]);
    expect(h.operator.messages.map((m) => m.text)).toEqual(["Both are in hand."]);

    // The same run again (a redelivery) is claimed already: no turn, no spend, no reply.
    await processChatRun(h.options, h.testEnv, run);
    expect(h.model.requests).toHaveLength(1);
    expect(h.operator.messages).toHaveLength(1);
  });

  it("leaves out the messages of a run that an earlier turn handled", async () => {
    const h = setup([{ text: "First." }, { text: "Second." }]);
    const first = msg("find contacts at acme.example", { ...who, sessionKey: `${who.sessionKey}:b` });
    await processChatRun(h.options, h.testEnv, [first]);
    await processChatRun(h.options, h.testEnv, [first, msg("and at globex.example", { ...who, sessionKey: `${who.sessionKey}:b` })]);
    expect(h.model.requests).toHaveLength(2);
    expect(h.model.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: "and at globex.example" });
  });

  it("handles a run holding a command one message at a time, in order", async () => {
    const h = setup([{ text: "On it." }]);
    const session = { ...who, sessionKey: `${who.sessionKey}:c` };
    await processChatRun(h.options, h.testEnv, [msg("summarize the pipeline", session), msg("/status", session)]);
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]?.messages).toEqual([{ role: "user", content: "summarize the pipeline" }]);
    expect(h.operator.messages.map((m) => m.text)[0]).toBe("On it.");
    expect(h.operator.messages[1]?.text).toContain("Session taint");
  });

  it("handles a run from two sessions one message at a time", async () => {
    const h = setup([{ text: "One." }, { text: "Two." }]);
    await processChatRun(h.options, h.testEnv, [msg("first", { ...who, sessionKey: `${who.sessionKey}:d` }), msg("second", { ...who, sessionKey: `${who.sessionKey}:e` })]);
    expect(h.model.requests.map((r) => r.messages)).toEqual([[{ role: "user", content: "first" }], [{ role: "user", content: "second" }]]);
    expect(h.operator.messages.map((m) => m.text)).toEqual(["One.", "Two."]);
  });
});

describe("orderByChat", () => {
  const sent = (text: string, messageId: string | undefined, chatId = "910000010"): ChatMessage => ({ ...msg(text, { chatId }), ...(messageId === undefined ? {} : { messageId }) });
  const order = (messages: ChatMessage[]) => orderByChat(messages, (m) => m).map((m) => m.text);

  it("puts each chat's messages in the order they were sent, in the places that chat holds", () => {
    expect(order([sent("draft it", "12"), sent("/clean", "11"), sent("read the page", "10")])).toEqual(["read the page", "/clean", "draft it"]);
    const a = "910000011";
    const b = "910000012";
    expect(order([sent("a2", "20", a), sent("b1", "5", b), sent("a1", "19", a), sent("b2", "6", b)])).toEqual(["a1", "b1", "a2", "b2"]);
    // Numerically, not as text.
    expect(order([sent("ten", "10"), sent("nine", "9")])).toEqual(["nine", "ten"]);
  });

  it("leaves a message with no numeric id where it is, and keeps equal ids in delivery order", () => {
    const timer: ChatMessage = { ...msg("timer:tm_1"), timerId: "tm_1" };
    expect(order([sent("second", "31"), timer, sent("first", "30"), sent("odd", "x1"), sent("none", undefined)])).toEqual(["first", "timer:tm_1", "second", "odd", "none"]);
    expect(order([sent("one", "40"), sent("two", "40")])).toEqual(["one", "two"]);
  });
});

describe("the chat queue consumer", () => {
  const OPERATOR = "910000020";
  const config = defineConfig({
    ...acmeConfig,
    models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } },
    operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] },
  });
  let next = 1000;
  const say = (text: string, session: string): ChatMessage => ({ ...msg(text, { chatId: OPERATOR, sessionKey: session }), messageId: String((next += 1)) });
  const fresh = () => `chat:${OPERATOR}:${Date.now()}:${(next += 1)}`;
  const setup = (steps: Parameters<typeof scriptedModel>[0], flags: Record<string, string> = { "operator:agent_enabled": "true", "operator:chat_batching": "true" }, extra: Partial<OperatorAgentOptions> = {}) => {
    const operator = recordingOperator();
    const model = scriptedModel(steps);
    const queue = recordingQueue<ChatMessage>();
    const testEnv = { ...(env as unknown as Env), KV: memoryKv(flags) as unknown as KVNamespace, CHAT_QUEUE: queue as unknown as Queue<ChatMessage> };
    const options: OperatorAgentOptions = { config, operator: () => operator.channel, model: () => model, ...extra };
    const consumer = createChatConsumer(options);
    const deliver = async (bodies: readonly unknown[]) => {
      const batch = createMessageBatch("gtm-chat", bodies.map((body, i) => ({ id: `d${(next += 1)}-${i}`, timestamp: new Date(), attempts: 1, body })));
      const ctx = createExecutionContext();
      await consumer(batch, testEnv, ctx);
      return getQueueResult(batch, ctx);
    };
    return { operator, model, queue, deliver };
  };

  it("answers a delivery in the order the operator sent it, so a /clean stays between the tasks around it", async () => {
    const h = setup([{ text: "Read it." }, { text: "Drafted." }]);
    const session = fresh();
    const [read, clean, draft] = [say("read https://acme.example/pricing", session), say("/clean", session), say("draft an intro to jane@acme.example", session)];
    const result = await h.deliver([draft, read, clean]);
    expect(result.explicitAcks).toHaveLength(3);
    expect(h.model.requests.map((r) => r.messages.at(-1)?.content)).toEqual(["read https://acme.example/pricing", "draft an intro to jane@acme.example"]);
    expect(h.operator.messages.map((m) => m.text)[0]).toBe("Read it.");
    expect(h.operator.messages[1]?.text).toContain("clean session");
    expect(h.operator.messages[2]?.text).toBe("Drafted.");
  });

  it("starts no run past its time budget, and sends the rest back to the chat queue unclaimed", async () => {
    const h = setup([{ text: "First." }], undefined, { deliveryBudgetMs: 0 });
    const session = fresh();
    const messages = [say("summarize the pipeline", session), say("/status", session), say("and the open drafts", session)];
    const result = await h.deliver(messages);
    expect(result.explicitAcks).toHaveLength(3);
    expect(h.model.requests).toHaveLength(1);
    expect(h.operator.messages.map((m) => m.text)).toEqual(["First."]);
    expect(h.queue.sent).toEqual(messages.slice(1));
    // A later delivery answers them once.
    const later = setup([{ text: "Third." }]);
    await later.deliver(h.queue.sent);
    expect(later.model.requests.map((r) => r.messages.at(-1)?.content)).toEqual(["and the open drafts"]);
    expect(later.operator.messages[0]?.text).toContain("Session taint");
    expect(CHAT_DELIVERY_BUDGET_MS).toBe(600_000);
  });

  it("runs the rest anyway when they cannot be sent back", async () => {
    const h = setup([{ text: "First." }, { text: "Second." }], undefined, { deliveryBudgetMs: 0 });
    h.queue.failing = true;
    const session = fresh();
    const result = await h.deliver([say("summarize the pipeline", session), say("/status", session), say("and the open drafts", session)]);
    expect(result.explicitAcks).toHaveLength(3);
    expect(h.model.requests).toHaveLength(2);
    expect(h.operator.messages).toHaveLength(3);
  });

  it("drops a malformed message and still merges the messages around it", async () => {
    const h = setup([{ text: "Both." }]);
    const session = fresh();
    const result = await h.deliver([say("find contacts at acme.example", session), { text: "no ids" }, say("and at globex.example", session)]);
    expect(result.explicitAcks).toHaveLength(3);
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]?.messages.at(-1)?.content).toBe("find contacts at acme.example\n\nand at globex.example");
  });

  it("answers a merged run once when the agent is off, or no model is configured", async () => {
    const off = setup([], { "operator:chat_batching": "true" });
    const quiet = fresh();
    await off.deliver([say("one", quiet), say("two", quiet)]);
    expect(off.operator.messages.map((m) => m.text)).toEqual([AGENT_DISABLED_TEXT]);
    const session = fresh();
    const noModel = setup([], undefined, { model: () => undefined });
    await noModel.deliver([say("one", session), say("two", session)]);
    expect(noModel.operator.messages).toHaveLength(1);
    expect(noModel.operator.messages[0]?.text).toContain("No model gateway is configured");
  });

  it("runs a module command alone, in its place, between two turns", async () => {
    const commands: ModuleCommand[] = [{ module: "acme-test", helpLines: [], match: (text) => (text === "acme-ping" ? () => Promise.resolve("pong") : null) }];
    const h = setup([{ text: "One." }, { text: "Two." }], undefined, { commands });
    const session = fresh();
    await h.deliver([say("summarize the pipeline", session), say("acme-ping", session), say("and the open drafts", session)]);
    expect(h.operator.messages.map((m) => m.text)).toEqual(["One.", "pong", "Two."]);
    expect(h.model.requests).toHaveLength(2);
  });

  it("stores a merged turn as one operator message with its joined text", async () => {
    const h = setup([{ text: "Both are in hand." }]);
    const session = fresh();
    await h.deliver([say("find contacts at acme.example", session), say("and at globex.example", session)]);
    const { results } = await env.DB.prepare("SELECT role, content FROM chat_messages WHERE session_key = ?1 ORDER BY id").bind(session).all<{ role: string; content: string }>();
    expect(results.map((r) => [r.role, (JSON.parse(r.content) as { text: string }).text])).toEqual([
      ["user", "find contacts at acme.example\n\nand at globex.example"],
      ["assistant", "Both are in hand."],
    ]);
  });
});

