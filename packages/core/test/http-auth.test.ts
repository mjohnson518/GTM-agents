// GTM-agents: tests for bearer authentication on /api/* and the constant-time comparison.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import type { Env } from "../src/env.ts";
import { constantTimeEqual, isWebhookPath } from "../src/http/auth.ts";
import { createWorker } from "../src/worker.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);
const TOKEN = "test-gateway-token-value";

function worker() {
  return createWorker(config, {
    routes: (app) => {
      app.get("/api/v1/runs/:id", (c) => c.json({ id: c.req.param("id") }));
      app.post("/api/webhooks/custom", (c) => c.json({ reached: true }));
    },
  });
}

async function call(request: Request, bindings: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv: Env = { ...(env as unknown as Env), ...bindings };
  const response = await (worker().fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("constantTimeEqual", () => {
  it("matches only the exact secret, and never an empty expected value", async () => {
    expect(await constantTimeEqual(TOKEN, TOKEN)).toBe(true);
    expect(await constantTimeEqual(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(await constantTimeEqual(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(false);
    expect(await constantTimeEqual("anything", "")).toBe(false);
  });
});

describe("bearer auth on /api/*", () => {
  it("lets a request with the right token through", async () => {
    const response = await call(new Request("https://agent.example/api/v1/runs/run_1", { headers: { authorization: `Bearer ${TOKEN}` } }), { GATEWAY_TOKEN: TOKEN });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "run_1" });
  });

  it("answers 401 to a missing, malformed or wrong token", async () => {
    for (const header of [undefined, TOKEN, `Basic ${TOKEN}`, "Bearer wrong-token", `Bearer ${TOKEN} extra`]) {
      const response = await call(new Request("https://agent.example/api/v1/runs/run_1", { headers: header ? { authorization: header } : {} }), { GATEWAY_TOKEN: TOKEN });
      expect(response.status, String(header)).toBe(401);
    }
  });

  it("fails closed with 503 when GATEWAY_TOKEN is unset, whatever the request carries", async () => {
    const response = await call(new Request("https://agent.example/api/v1/runs/run_1", { headers: { authorization: "Bearer " } }), { GATEWAY_TOKEN: undefined });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "auth_not_configured" });
  });

  it("protects unknown /api/* paths before they can answer 404", async () => {
    expect((await call(new Request("https://agent.example/api/nothing-here"), { GATEWAY_TOKEN: TOKEN })).status).toBe(401);
  });

  it("leaves webhook paths to their own signature checks", async () => {
    const response = await call(new Request("https://agent.example/api/webhooks/custom", { method: "POST" }), { GATEWAY_TOKEN: undefined });
    expect(response.status).toBe(200);
    expect(isWebhookPath("/api/webhooks/operator")).toBe(true);
    expect(isWebhookPath("/api/webhooksx/operator")).toBe(false);
    expect(isWebhookPath("/api/v1/webhooks/x")).toBe(false);
  });

  it("does not let a dot segment or an encoded path step out of the webhook prefix", async () => {
    const dotted = await call(new Request("https://agent.example/api/webhooks/../v1/runs/run_1"), { GATEWAY_TOKEN: TOKEN });
    expect(dotted.status).toBe(401);
    const encoded = await call(new Request("https://agent.example/api/webhooks/%2e%2e/v1/runs/run_1"), { GATEWAY_TOKEN: TOKEN });
    expect(encoded.status).toBe(401);
  });

  it("leaves routes outside /api alone", async () => {
    expect((await call(new Request("https://agent.example/health"), { GATEWAY_TOKEN: undefined })).status).toBe(200);
  });
});
