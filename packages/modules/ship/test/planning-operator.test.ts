// GTM-agents: module commands in the operator chat (createWorker's `commands`): a module command is
// answered without the model, only for an allowlisted sender, once per message; /help lists its
// lines; a built-in command cannot be taken over; and a handler that throws is answered with a
// generic error and an audit row, never its error text. Every chat id and address is invented.
import { createExecutionContext, createMessageBatch, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHAT_QUEUE, createWorker, type ChatMessage, type Env } from "@gtm-agents/core";
import { memoryKv, recordingOperator, recordingQueue, scriptedModel, signedUpdateParser, updateRequest } from "@gtm-agents/core/agents/testing";
import { MODULE_COMMAND_FAILED_TEXT, processChatMessage, type ModuleCommand, type OperatorAgentOptions } from "@gtm-agents/core/operator";
import { createShipPlanning } from "../src/planning.ts";
import { SHIP_HELP_LINES } from "../src/planning-commands.ts";
import { SHIP_ON, SHIP_TEST_CHAT, SHIP_TEST_REPO, recordingBuild, resetShipTables, seedTheme, shipTestConfig } from "../src/planning-testing.ts";

const db = (env as unknown as { DB: D1Database }).DB;
const config = shipTestConfig();
const SECRET = "c".repeat(32);
let next = 0;

const ship = () => createShipPlanning<Env>({ config, repo: SHIP_TEST_REPO, startBuild: recordingBuild<Env>().start, readEngineeringContract: () => Promise.resolve(null) });

function setup(commands: ReadonlyArray<ModuleCommand<Env>>) {
  const operator = recordingOperator();
  const model = scriptedModel([{ text: "a model turn" }]);
  const kv = memoryKv({ "operator:agent_enabled": "true", ...SHIP_ON });
  const options: OperatorAgentOptions<Env> = { config, operator: () => operator.channel, model: () => model, commands };
  const testEnv = { ...(env as unknown as Env), KV: kv as unknown as KVNamespace };
  const send = (text: string, from = SHIP_TEST_CHAT, updateId = `u-${(next += 1)}`) =>
    processChatMessage(options, testEnv, { updateId, chatId: from, userId: from, sessionKey: `operator:${from}`, text } satisfies ChatMessage);
  return { operator, model, send };
}

beforeEach(async () => {
  await resetShipTables(db);
});

describe("a module command", () => {
  it("is answered without the model", async () => {
    await seedTheme(db, { title: "Export quarantined tests as CSV" });
    const { operator, model, send } = setup(ship().commands);
    await send("ship-themes");
    expect(model.requests).toHaveLength(0);
    expect(operator.messages.map((m) => m.text).join("\n")).toContain("Export quarantined tests as CSV");
  });

  it("is never run for a sender who is not allowlisted", async () => {
    let ran = 0;
    const spy: ModuleCommand<Env> = { module: "spy", helpLines: [], match: (t) => (t === "spy-run" ? () => Promise.resolve(`ran ${(ran += 1)}`) : null) };
    const { operator, model, send } = setup([spy]);
    await send("spy-run", "9990001");
    expect(ran).toBe(0);
    expect(model.requests).toHaveLength(0);
    expect(operator.messages).toHaveLength(0);
  });

  it("never reaches the queue from a sender the webhook does not allow", async () => {
    let ran = 0;
    const spy: ModuleCommand<Env> = { module: "spy", helpLines: [], match: (t) => (t === "spy-run" ? () => Promise.resolve(`ran ${(ran += 1)}`) : null) };
    const parser = signedUpdateParser(SECRET);
    const operator = recordingOperator(parser.parse);
    const model = scriptedModel([{ text: "a model turn" }]);
    const queue = recordingQueue<ChatMessage>();
    const worker = createWorker<Env>(config, { operator: () => operator.channel, model: () => model, commands: [spy] });
    const testEnv = { ...(env as unknown as Env), KV: memoryKv({ "operator:agent_enabled": "true" }) as unknown as KVNamespace, CHAT_QUEUE: queue as unknown as Queue<ChatMessage> };
    const post = async (chatId: string, text: string) => {
      const ctx = createExecutionContext();
      const res = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(updateRequest({ type: "command", chatId, userId: chatId, messageId: String((next += 1)), text }, SECRET), testEnv, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect(await (await post("9990002", "spy-run")).json()).toEqual({ ok: true });
    expect(queue.sent).toHaveLength(0);

    // An allowlisted sender's command goes through the queue to the module, still without the model.
    expect(await (await post(SHIP_TEST_CHAT, "spy-run")).json()).toEqual({ ok: true, queued: true });
    const batch = createMessageBatch(DEFAULT_CHAT_QUEUE, queue.sent.map((body, i) => ({ id: `q${i}`, timestamp: new Date(), attempts: 1, body })));
    const ctx = createExecutionContext();
    await worker.queue?.(batch, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(ran).toBe(1);
    expect(model.requests).toHaveLength(0);
    expect(operator.messages.map((m) => m.text)).toContain("ran 1");
  });

  it("runs once per message, even when the message is delivered twice", async () => {
    let ran = 0;
    const spy: ModuleCommand<Env> = { module: "spy", helpLines: [], match: (t) => (t === "spy-run" ? () => Promise.resolve(`ran ${(ran += 1)}`) : null) };
    const { send } = setup([spy]);
    await send("spy-run", SHIP_TEST_CHAT, "u-same");
    await send("spy-run", SHIP_TEST_CHAT, "u-same");
    expect(ran).toBe(1);
  });

  it("is answered with a generic error and an audit row when its handler throws", async () => {
    const boom: ModuleCommand<Env> = { module: "boom", helpLines: [], match: (t) => (t === "boom-now" ? () => Promise.reject(new Error("secret internal detail at db.acme.example")) : null) };
    const { operator, model, send } = setup([boom]);
    await send("boom-now");
    const texts = operator.messages.map((m) => m.text);
    expect(texts).toEqual([MODULE_COMMAND_FAILED_TEXT]);
    expect(texts.join("\n")).not.toContain("secret internal detail");
    expect(model.requests).toHaveLength(0);
    const audit = await db.prepare("SELECT agent_id, action, details FROM audit_log WHERE action = 'module_command_failed'").all<{ agent_id: string; action: string; details: string }>();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0]?.details ?? "{}")).toMatchObject({ module: "boom" });
  });

  it("is skipped when its match throws, and the message goes on to the model", async () => {
    const broken: ModuleCommand<Env> = {
      module: "broken",
      helpLines: [],
      match: () => {
        throw new Error("match must not throw");
      },
    };
    const { model, send } = setup([broken]);
    await send("tell me about our pipeline");
    expect(model.requests).toHaveLength(1);
  });
});

describe("built-in commands", () => {
  it("list the module's help lines in /help", async () => {
    const { operator, send } = setup(ship().commands);
    await send("/help");
    const help = operator.messages.map((m) => m.text).join("\n");
    for (const line of SHIP_HELP_LINES) expect(help).toContain(line);
  });

  it("cannot be taken over by a module", async () => {
    let ran = 0;
    const greedy: ModuleCommand<Env> = { module: "greedy", helpLines: [], match: () => () => Promise.resolve(`greedy ${(ran += 1)}`) };
    const { operator, send } = setup([greedy]);
    for (const text of ["/help", "/status", "/clean", "/start"]) await send(text);
    expect(ran).toBe(0);
    expect(operator.messages.some((m) => m.text.includes("commands:"))).toBe(true);
    expect(operator.messages.some((m) => m.text.startsWith("greedy"))).toBe(false);
  });
});
