// GTM-agents: tests for POST /api/webhooks/operator: verification before anything else, the
// allowlist, deduplication, the agent flag and the hand-off to CHAT_QUEUE. Chat and user ids are
// invented.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv, recordingOperator, recordingQueue, signedUpdateParser, updateRequest, type MemoryKvNamespace, type RecordingQueue } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import type { ChatMessage, Env } from "../src/env.ts";
import { AdapterError } from "../src/ports/types.ts";
import type { OperatorChannel, OperatorUpdate } from "../src/ports/operator.ts";
import { createWorker } from "../src/worker.ts";
import { acmeConfig } from "./fixtures.ts";

const SECRET = "test-channel-secret";
const OPERATOR = "700800900";
let n = 0;
const nextId = () => String(Date.now() * 100 + (n += 1));

function harness(options: { allowed?: string[]; channel?: OperatorChannel | null; flag?: string | null; queue?: boolean } = {}) {
  const allowed = options.allowed ?? [OPERATOR];
  const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: allowed, allowedUserIds: allowed } });
  const parser = signedUpdateParser(SECRET);
  const operator = recordingOperator(parser.parse);
  const kv: MemoryKvNamespace = memoryKv(options.flag === null ? {} : { "operator:agent_enabled": options.flag ?? "true" });
  const queue: RecordingQueue<ChatMessage> = recordingQueue<ChatMessage>();
  const channel = options.channel === undefined ? operator.channel : options.channel;
  const worker = createWorker(config, { operator: () => channel ?? undefined });
  const testEnv = { ...(env as unknown as Env), KV: kv as unknown as KVNamespace, CHAT_QUEUE: options.queue === false ? undefined : (queue as unknown as Queue<ChatMessage>) } as Env;
  const post = async (request: Request): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { post, operator, parser, kv, queue };
}

function command(text: string, ids: { chatId?: string; userId?: string; messageId?: string } = {}): OperatorUpdate {
  return { type: "command", chatId: ids.chatId ?? OPERATOR, userId: ids.userId ?? OPERATOR, messageId: ids.messageId ?? nextId(), text };
}

async function effectCount(key: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE event_id = ?1").bind(key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe("the operator webhook", () => {
  it("queues a verified message from an allowlisted operator and answers at once", async () => {
    const h = harness();
    const update = command("look at https://acme.example/pricing");
    const response = await h.post(updateRequest(update, SECRET));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: true });
    expect(h.queue.sent).toEqual([
      { updateId: `operator:${OPERATOR}:${update.type === "command" ? update.messageId : ""}`, chatId: OPERATOR, userId: OPERATOR, messageId: update.type === "command" ? update.messageId : "", sessionKey: `chat:${OPERATOR}`, text: "look at https://acme.example/pricing" },
    ]);
    expect(h.operator.messages).toEqual([]);
  });

  it("rejects a bad secret with 401 before reading the update or writing anything", async () => {
    const h = harness();
    const update = command("hello");
    for (const secret of ["wrong-secret", undefined]) {
      const response = await h.post(updateRequest(update, secret));
      expect(response.status).toBe(401);
    }
    expect(h.parser.seen.bodies).toBe(0);
    expect(h.queue.sent).toEqual([]);
    expect(await effectCount(`operator:${OPERATOR}:${update.type === "command" ? update.messageId : ""}`)).toBe(0);
  });

  it("ignores a chat that is not allowlisted: no reply, no queue, no ledger row", async () => {
    const h = harness();
    const stranger = "111222333";
    const update = command("hi", { chatId: stranger, userId: stranger });
    const response = await h.post(updateRequest(update, SECRET));
    expect(response.status).toBe(200);
    expect(h.operator.messages).toEqual([]);
    expect(h.queue.sent).toEqual([]);
    expect(await effectCount(`operator:${stranger}:${update.type === "command" ? update.messageId : ""}`)).toBe(0);
  });

  it("needs both the chat id and the user id on the allowlist", async () => {
    const h = harness();
    await h.post(updateRequest(command("hi", { userId: "999" }), SECRET));
    await h.post(updateRequest(command("hi", { chatId: "999" }), SECRET));
    expect(h.queue.sent).toEqual([]);
  });

  it("denies everyone while the allowlist is empty", async () => {
    const h = harness({ allowed: [] });
    await h.post(updateRequest(command("hi"), SECRET));
    expect(h.queue.sent).toEqual([]);
    expect(h.operator.messages).toEqual([]);
  });

  it("handles a redelivered update once", async () => {
    const h = harness();
    const update = command("once");
    await h.post(updateRequest(update, SECRET));
    const again = await h.post(updateRequest(update, SECRET));
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(h.queue.sent).toHaveLength(1);
  });

  it("replies that the agent is disabled while the flag is off or unreadable, and queues nothing", async () => {
    for (const flag of [null, "false"]) {
      const h = harness({ flag });
      const response = await h.post(updateRequest(command("hello"), SECRET));
      expect(await response.json()).toEqual({ ok: true, disabled: true });
      expect(h.operator.messages.map((m) => m.text)).toEqual([expect.stringContaining("turned off")]);
      expect(h.queue.sent).toEqual([]);
    }
    const unreadable = harness();
    unreadable.kv.failing = true;
    await unreadable.post(updateRequest(command("hello"), SECRET));
    expect(unreadable.queue.sent).toEqual([]);
    expect(unreadable.operator.messages).toHaveLength(1);
  });

  it("answers 503 when no operator channel is configured, or the channel cannot verify", async () => {
    expect((await harness({ channel: null }).post(updateRequest(command("hi"), SECRET))).status).toBe(503);
    const broken = recordingOperator(() => Promise.reject(new AdapterError("secret not set", "unavailable", false)));
    expect((await harness({ channel: broken.channel }).post(updateRequest(command("hi"), SECRET))).status).toBe(503);
  });

  it("releases its claim when the message cannot be queued, so a redelivery is handled", async () => {
    const h = harness();
    const update = command("retry me");
    h.queue.failing = true;
    expect((await h.post(updateRequest(update, SECRET))).status).toBe(503);
    h.queue.failing = false;
    expect(await (await h.post(updateRequest(update, SECRET))).json()).toEqual({ ok: true, queued: true });
    expect(h.queue.sent).toHaveLength(1);
  });

  it("acknowledges an update the channel ignores", async () => {
    const h = harness();
    const response = await h.post(updateRequest({ type: "ignored", reason: "an edited message" }, SECRET));
    expect(await response.json()).toEqual({ ok: true });
  });

  it("runs a redelivered chat queue message only once", async () => {
    const h = harness({ queue: false });
    const { processChatMessage } = await import("../src/operator/chat.ts");
    const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] } });
    const model = { name: "never", complete: () => Promise.reject(new Error("no model call expected")), embed: () => Promise.reject(new Error("no")) };
    const message = { updateId: `redelivery:${nextId()}`, chatId: OPERATOR, userId: OPERATOR, sessionKey: `chat:${OPERATOR}`, text: "summarize our pipeline" };
    const testEnv = { ...(env as unknown as Env), KV: h.kv as unknown as KVNamespace };
    await processChatMessage({ config, operator: () => h.operator.channel, model: () => model }, testEnv, message);
    await processChatMessage({ config, operator: () => h.operator.channel, model: () => model }, testEnv, message);
    // The first delivery ran a turn (and reported the model failure); the second did nothing.
    expect(h.operator.messages).toHaveLength(1);
  });

  it("handles the message after answering when no queue is bound", async () => {
    const h = harness({ queue: false });
    const response = await h.post(updateRequest(command("/help"), SECRET));
    expect(await response.json()).toEqual({ ok: true, queued: false });
    expect(h.operator.messages[0]?.text).toContain("/clean");
    expect(h.operator.messages[0]?.chatId).toBe(OPERATOR);
  });
});
