// GTM-agents: the operator webhook and the HTTP API fail closed. A bad channel secret is rejected
// before the database is touched, a chat that is not allowlisted gets nothing, and every /api/*
// route other than webhooks needs the bearer token, refusing everything while it is unset.
import { memoryKv, recordingOperator, recordingQueue, signedUpdateParser, updateRequest } from "@gtm-agents/core/agents/testing";
import { defineConfig } from "@gtm-agents/core/config";
import type { ChatMessage, Env } from "@gtm-agents/core";
import { createWorker } from "@gtm-agents/core";
import type { OperatorUpdate } from "@gtm-agents/core/ports";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uid } from "./helpers.ts";

const SECRET = "test-channel-secret";
const OPERATOR = "515151";
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
  operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] },
});

/** A database that records every statement prepared on it, so a test can prove nothing was. */
function watchedDb(): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const real = env.DB;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        statements.push(sql);
        return target.prepare(sql);
      };
      if (prop === "batch") return (list: D1PreparedStatement[]) => {
        statements.push("batch");
        return target.batch(list);
      };
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, statements };
}

function harness(bindings: Partial<Env> = {}) {
  const parser = signedUpdateParser(SECRET);
  const operator = recordingOperator(parser.parse);
  const queue = recordingQueue<ChatMessage>();
  const watched = watchedDb();
  const worker = createWorker(config, { operator: () => operator.channel });
  const testEnv: Env = { ...(env as unknown as Env), DB: watched.db, KV: memoryKv({ "operator:agent_enabled": "true" }) as unknown as KVNamespace, CHAT_QUEUE: queue as unknown as Queue<ChatMessage>, ...bindings };
  const send = async (request: Request): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { send, operator, parser, queue, statements: watched.statements };
}

const message = (chatId: string, userId = chatId): OperatorUpdate => ({ type: "command", chatId, userId, messageId: uid("m"), text: "draft an intro to jane@acme.example" });

describe("the operator webhook", () => {
  it("rejects a bad or missing secret before any database statement", async () => {
    const h = harness();
    for (const secret of ["not-the-secret", "", undefined]) {
      expect((await h.send(updateRequest(message(OPERATOR), secret))).status).toBe(401);
    }
    expect(h.statements).toEqual([]);
    expect(h.parser.seen.bodies).toBe(0);
    expect(h.queue.sent).toEqual([]);
    expect(h.operator.messages).toEqual([]);
  });

  it("ignores a chat that is not allowlisted: no reply, no queued turn, no database statement", async () => {
    const h = harness();
    const response = await h.send(updateRequest(message("999000111"), SECRET));
    expect(response.status).toBe(200);
    expect(h.operator.messages).toEqual([]);
    expect(h.operator.acks).toEqual([]);
    expect(h.queue.sent).toEqual([]);
    expect(h.statements).toEqual([]);
  });

  it("ignores an allowlisted chat when the sender is not an allowlisted user, and a callback from a stranger", async () => {
    const h = harness();
    await h.send(updateRequest(message(OPERATOR, "999000111"), SECRET));
    await h.send(updateRequest({ type: "callback", chatId: "999000111", userId: "999000111", action: "approve", payload: `dr_x.${"0".repeat(32)}`, messageId: "1", callbackId: uid("cb") }, SECRET));
    expect(h.queue.sent).toEqual([]);
    expect(h.operator.acks).toEqual([]);
    expect(h.statements).toEqual([]);
  });
});

describe("bearer auth on the API", () => {
  it("fails closed with 503 while GATEWAY_TOKEN is unset, and 401 for a wrong token", async () => {
    const unset = harness({ GATEWAY_TOKEN: undefined });
    for (const header of [undefined, "Bearer ", "Bearer anything"]) {
      const response = await unset.send(new Request("https://agent.acme.example/api/v1/runs/run_1", { headers: header ? { authorization: header } : {} }));
      expect(response.status, String(header)).toBe(503);
    }
    const set = harness({ GATEWAY_TOKEN: "test-gateway-token-value" });
    expect((await set.send(new Request("https://agent.acme.example/api/v1/runs/run_1", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });

  it("does not exempt anything but the webhook prefix", async () => {
    const h = harness({ GATEWAY_TOKEN: "test-gateway-token-value" });
    for (const path of ["/api/webhooks/../v1/runs/x", "/api/webhooks/%2e%2e/v1/runs/x", "/api/webhooks%2f..%2fv1/runs/x", "/api/webhook/operator", "/api/webhooksx/operator"]) {
      expect((await h.send(new Request(`https://agent.acme.example${path}`, { method: "POST" }))).status, path).toBe(401);
    }
    // The router is case-sensitive, so a differently cased path reaches no handler at all.
    expect((await h.send(new Request("https://agent.acme.example/API/v1/runs/x"))).status).toBe(404);
  });
});
