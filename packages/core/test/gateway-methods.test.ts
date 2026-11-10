// GTM-agents: the dashboard's methods do what their modules do: the cockpit pauses and resumes through
// the kill switch, deals move only forward through transitionDeal, chat runs commands and refuses
// while the agent is off, activity exports safe CSV, and the changelog parses. All data is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/define-config.ts";
import type { Env } from "../src/env.ts";
import type { ConnectionState, GatewayContext } from "../src/gateway/context.ts";
import { handleFrame } from "../src/gateway/dispatch.ts";
import { parseChangelog } from "../src/gateway/ops.ts";
import type { ServerEvent } from "../src/gateway/protocol.ts";
import { createJobRegistry } from "../src/jobs/registry.ts";
import type { ModuleCommand } from "../src/operator/module-commands.ts";
import { COLD_PAUSE_CRITICAL_KEY } from "../src/sending/kill-switch.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const EMAIL = "ops@acme.example";
const config = defineConfig({ ...acmeConfig, admin: { accessTeamDomain: "acme.cloudflareaccess.com", accessAud: "a".repeat(64), allowedEmails: [EMAIL] } });

class Kv {
  readonly map = new Map<string, string>();
  get = async (k: string) => this.map.get(k) ?? null;
  put = async (k: string, v: string) => void this.map.set(k, v);
  delete = async (k: string) => void this.map.delete(k);
}

function harness(commands?: ReadonlyArray<ModuleCommand>) {
  const kv = new Kv();
  kv.map.set("admin:enabled", "true");
  const events: ServerEvent[] = [];
  const deferred: Array<Promise<unknown>> = [];
  const state: ConnectionState = { email: EMAIL, sub: "u", expiresAt: Date.now() + 3_600_000, connected: true, subscribed: false, rl: { start: Date.now(), requests: 0, mutations: 0, chats: 0 } };
  const ctx: GatewayContext = {
    env: { DB: db, KV: kv } as unknown as Env,
    wiring: { config, registry: () => createJobRegistry([]), lifecycle: false, agent: {}, extensions: {}, ...(commands ? { commands } : {}) },
    state,
    now: () => new Date(),
    actor: `operator:${EMAIL}`,
    flags: { get: (k) => kv.get(k) },
    push: (e) => events.push(e),
    broadcast: (e) => events.push(e),
    defer: (t) => deferred.push(t),
    turns: new Map(),
    audit: {},
  };
  let n = 0;
  const call = async <T = unknown>(method: string, params?: unknown) => {
    const out = await handleFrame(JSON.stringify({ id: `r${(n += 1)}`, method, params }), ctx);
    return JSON.parse(out.reply ?? "{}") as { result?: T; error?: { code: string; message: string } };
  };
  return { kv, events, deferred, call };
}

const id = () => `t-${crypto.randomUUID().slice(0, 8)}`;

describe("cockpit", () => {
  it("pauses critically through the kill switch and resumes it", async () => {
    const h = harness();
    const paused = await h.call<{ coldPause: { paused: boolean; severity: string } }>("cockpit.pause", { reason: "bounce spike" });
    expect(paused.result?.coldPause).toMatchObject({ paused: true, severity: "critical" });
    expect(JSON.parse(h.kv.map.get(COLD_PAUSE_CRITICAL_KEY) ?? "{}")).toMatchObject({ reason: "bounce spike", source: `operator:${EMAIL}` });
    expect(h.events.some((e) => e.event === "status")).toBe(true);
    const resumed = await h.call<{ coldPause: { paused: boolean } }>("cockpit.resume", {});
    expect(resumed.result?.coldPause.paused).toBe(false);
  });

  it("refuses a replay while delivery is off", async () => {
    expect((await harness().call("cockpit.replay", {})).error?.code).toBe("unavailable");
  });
});

describe("pipeline", () => {
  it("creates a deal for a contact and moves it forward only", async () => {
    const h = harness();
    const contactId = id();
    await db
      .prepare("INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key) VALUES (?1, 'Jane', 'Doe', ?2, ?3, ?3, 'globex.example')")
      .bind(contactId, `${contactId}@globex.example`, contactId.padEnd(64, "0").replace(/[^0-9a-f]/g, "0"))
      .run();
    const created = await h.call<{ id: string }>("pipeline.create", { contactId, value: 1200.5 });
    const dealId = created.result?.id ?? "";
    expect(dealId).not.toBe("");
    expect((await h.call("pipeline.transition", { dealId, to: "engaged", reason: "replied" })).result).toEqual({ ok: true, stage: "engaged" });
    expect((await h.call("pipeline.transition", { dealId, to: "contacted" })).error?.code).toBe("conflict");
    const deals = await h.call<{ items: Array<{ id: string; value: number; stage: string }> }>("pipeline.deals", { stage: "engaged" });
    expect(deals.result?.items.find((d) => d.id === dealId)).toMatchObject({ value: 1200.5, stage: "engaged" });
    const history = await db.prepare("SELECT actor FROM deal_stage_history WHERE deal_id = ?1").bind(dealId).first<{ actor: string }>();
    expect(history?.actor).toBe(`operator:${EMAIL}`);
    const found = await h.call<{ items: Array<{ id: string; name: string }> }>("contacts.query", { q: "jane doe" });
    expect(found.result?.items.some((c) => c.id === contactId)).toBe(true);
  });
});

describe("chat", () => {
  it("refuses while the agent is off and runs /help without the model once it is on", async () => {
    const h = harness();
    expect((await h.call("chat.send", { text: "hello" })).error?.code).toBe("unavailable");
    h.kv.map.set("operator:agent_enabled", "true");
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "/help" });
    await Promise.all(h.deferred);
    const delta = h.events.find((e) => e.event === "chat.delta");
    expect(delta?.event === "chat.delta" && delta.data.turnId === sent.result?.turnId && delta.data.text.includes("commands")).toBe(true);
    expect(h.events.some((e) => e.event === "chat.done")).toBe(true);
    expect((await h.call("chat.send", { text: "batch-release-abc123-def456" })).result).toHaveProperty("turnId");
    expect((await h.call("chat.send", { text: "summarize our pipeline" })).error?.code).toBe("unavailable");
  });
});

describe("chat commands that run elsewhere", () => {
  it("refuses a module command, a follow-up command and a learning command without running them or calling the model", async () => {
    let ran = 0;
    const ship: ModuleCommand = {
      module: "ship",
      helpLines: ["ship-themes  list the open themes"],
      match: (text) => (/^ship-[a-z]+/.test(text.trim()) ? () => Promise.resolve(`ran ${(ran += 1)}`) : null),
    };
    const h = harness([ship]);
    h.kv.map.set("operator:agent_enabled", "true");
    // No model is wired: a message passed on as a task would answer "unavailable" instead of a turn.
    for (const text of ["ship-approve-th1 0123456789abcdef0123456789abcdef", "fu-approve-0123456789", "learning-list"]) {
      const before = h.events.length;
      const sent = await h.call<{ turnId: string }>("chat.send", { text });
      expect(sent.result, text).toHaveProperty("turnId");
      await Promise.all(h.deferred);
      const said = h.events.slice(before).find((e) => e.event === "chat.delta");
      expect(said?.event === "chat.delta" && said.data.text, text).toContain("Nothing was run.");
    }
    expect(ran).toBe(0);
  });

  it("lists a module's commands in /help", async () => {
    const ship: ModuleCommand = { module: "ship", helpLines: ["ship-themes  list the open themes"], match: () => null };
    const h = harness([ship]);
    h.kv.map.set("operator:agent_enabled", "true");
    await h.call("chat.send", { text: "/help" });
    await Promise.all(h.deferred);
    const said = h.events.find((e) => e.event === "chat.delta");
    expect(said?.event === "chat.delta" && said.data.text).toContain("ship-themes");
  });
});

describe("activity and changelog", () => {
  it("exports activity as CSV with formula cells neutralized", async () => {
    const h = harness();
    await db.prepare("INSERT INTO audit_log (agent_id, action, details) VALUES ('=cmd|calc', 'test.action', ?1)").bind(JSON.stringify({ draftId: "d1" })).run();
    const day = new Date().toISOString().slice(0, 10);
    const out = await h.call<{ csv: string }>("activity.export", { from: day, to: day });
    expect(out.result?.csv).toContain("'=cmd|calc");
    const page = await h.call<{ items: Array<{ kind: string; ref?: { type: string } }> }>("activity.list", { kind: "test.action" });
    expect(page.result?.items[0]).toMatchObject({ kind: "test.action", ref: { type: "draft" } });
  });

  it("parses releases, areas and entries", () => {
    const entries = parseChangelog(["# Changelog", "", "## [1.2.0] - 2026-11-01", "### Dashboard", "- Added the cockpit view.", "", "## 1.1.0 (2026-10-01)", "- Fixed a typo."].join("\n"));
    expect(entries).toEqual([
      { version: "1.2.0", date: "2026-11-01", area: "dashboard", text: "Added the cockpit view." },
      { version: "1.1.0", date: "2026-10-01", area: "general", text: "Fixed a typo." },
    ]);
  });
});
