// GTM-agents: tests for createWorker: the HTTP surface, the scheduled loop and the queue handler.
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import type { Env } from "../src/env.ts";
import type { JobOutcome } from "../src/jobs/loop.ts";
import { MAX_BODY_BYTES, createWorker } from "../src/worker.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);
const testEnv = env as unknown as Env;

async function call(worker: ReturnType<typeof createWorker>, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("createWorker: HTTP", () => {
  const worker = createWorker(config);

  it("answers GET /health", async () => {
    const response = await call(worker, new Request("https://agent.example/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "gtm-agents" });
  });

  it("returns JSON 404 for unknown routes", async () => {
    const response = await call(worker, new Request("https://agent.example/nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("rejects a body over the limit when Content-Length says so", async () => {
    const body = "x".repeat(MAX_BODY_BYTES + 1);
    const response = await call(worker, new Request("https://agent.example/health", { method: "POST", body }));
    expect(response.status).toBe(413);
  });

  it("rejects an oversized body even without a Content-Length header", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const worker2 = createWorker(config, { routes: (app) => app.post("/echo", async (c) => c.text(String((await c.req.text()).length))) });
    const response = await call(worker2, new Request("https://agent.example/echo", { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(response.status).toBe(413);
  });

  it("mounts extra routes and hides internal errors", async () => {
    const custom = createWorker(config, {
      routes: (app) => {
        app.get("/hello", (c) => c.text("hi"));
        app.get("/explode", () => {
          throw new Error("secret detail");
        });
      },
    });
    expect(await (await call(custom, new Request("https://agent.example/hello"))).text()).toBe("hi");
    const failed = await call(custom, new Request("https://agent.example/explode"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("secret detail");
  });
});

describe("createWorker: scheduled and queue handlers", () => {
  it("runs only the jobs registered for the firing cron, and keeps going after a failure", async () => {
    const ran: string[] = [];
    let outcomes: JobOutcome[] = [];
    const worker = createWorker(config, {
      jobs: [
        { name: "first_job", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 1000 }, run: async () => { ran.push("first"); throw new Error("first failed"); } },
        { name: "second_job", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 1000 }, run: async () => { ran.push("second"); } },
        { name: "other_job", schedule: "0 13 * * MON-THU", ceilings: { maxDurationMs: 1000 }, run: async () => { ran.push("other"); } },
      ],
      onScheduled: (_cron, o) => {
        outcomes = o;
      },
    });
    expect(worker.registry.schedules()).toEqual(["0 13 * * MON-THU", "0 9 * * MON-FRI"]);
    const controller = createScheduledController({ cron: "0 9 * * MON-FRI", scheduledTime: new Date("2026-11-02T09:00:00Z") });
    const ctx = createExecutionContext();
    await (worker.scheduled as (c: ScheduledController, e: Env, x: ExecutionContext) => Promise<void>)(controller, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(ran).toEqual(["first", "second"]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "completed"]);
  });

  it("retries a batch from a queue with no registered consumer, so it reaches the dead-letter queue instead of being dropped", async () => {
    const worker = createWorker(config);
    const batch = createMessageBatch("gtm-unknown", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { id: "evt_1" } }]);
    const ctx = createExecutionContext();
    await (worker.queue as (b: MessageBatch, e: Env, c: ExecutionContext) => Promise<void>)(batch, testEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryBatch.retry).toBe(true);
    expect(result.ackAll).toBe(false);
  });

  it("hands a batch to the consumer registered for its queue", async () => {
    const seen: unknown[] = [];
    const worker = createWorker(config, {
      queueConsumers: {
        "gtm-events": async (batch) => {
          for (const m of batch.messages) {
            seen.push(m.body);
            m.ack();
          }
        },
      },
    });
    const batch = createMessageBatch("gtm-events", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { id: "evt_1" } }]);
    const ctx = createExecutionContext();
    await (worker.queue as (b: MessageBatch, e: Env, c: ExecutionContext) => Promise<void>)(batch, testEnv, ctx);
    await getQueueResult(batch, ctx);
    expect(seen).toEqual([{ id: "evt_1" }]);
  });
});
