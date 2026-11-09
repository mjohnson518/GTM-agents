// GTM-agents: the Worker's dashboard routes: /admin/* responses cannot be framed, /ws answers 503
// until the dashboard is configured and turned on, and flags.list says which keys flags.set takes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/define-config.ts";
import type { Env } from "../src/env.ts";
import { isEditableFlag } from "../src/gateway/flags.ts";
import { createWorker } from "../src/worker.ts";
import { acmeConfig } from "./fixtures.ts";

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const assets = { fetch: async () => new Response("<!doctype html><title>Dashboard</title>", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher;

describe("dashboard routes", () => {
  it("serves /admin/* with headers that forbid framing", async () => {
    const worker = createWorker(defineConfig(acmeConfig));
    const response = await worker.app.fetch(new Request("https://agent.acme.example/admin/"), { ...env, ASSETS: assets }, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await response.text()).toContain("Dashboard");
  });

  it("answers 503 on /ws without the admin section, and while admin:enabled is off", async () => {
    const upgrade = () => new Request("https://agent.acme.example/ws", { headers: { Upgrade: "websocket", Origin: "https://agent.acme.example" } });
    const bare = createWorker(defineConfig(acmeConfig));
    expect((await bare.app.fetch(upgrade(), env as unknown as Env, ctx)).status).toBe(503);
    const configured = createWorker(defineConfig({ ...acmeConfig, admin: { accessTeamDomain: "acme.cloudflareaccess.com", accessAud: "a".repeat(64), allowedEmails: ["ops@acme.example"] } }));
    await env.KV.delete("admin:enabled");
    const response = await configured.app.fetch(upgrade(), env, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "dashboard_disabled" });
  });

  it("marks only the keys flags.set accepts as editable", () => {
    expect(isEditableFlag("cold_batch:enabled")).toBe(true);
    expect(isEditableFlag("budget:job:<job>:daily_cents")).toBe(true);
    for (const key of ["system:halt", "autonomy:<class>", "inbound:auto_send_tier", "cold_batch:auto_approve", "outreach:cold-pause", "delivery:breaker:<day>"]) expect(isEditableFlag(key), key).toBe(false);
  });
});
