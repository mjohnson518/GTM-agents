// GTM-agents: the mailbox push webhook fails closed. A push without the shared secret, or with the
// wrong one, is refused before the database is touched; an unset secret answers 503; with the inbox
// off the push is acknowledged and nothing else happens; and a push is only a wake-up, whose body
// (including its history id) never chooses where the poll reads from.
import type { Env } from "@gtm-agents/core";
import { createWorker } from "@gtm-agents/core";
import { defineConfig } from "@gtm-agents/core/config";
import { cursorKey } from "@gtm-agents/core/inbox";
import { fakeInbox, inboundMessage, type FakeInbox } from "@gtm-agents/core/inbox/testing";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, uid } from "./helpers.ts";

const SECRET = "p".repeat(40);
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
});

/** A database that records every statement prepared on it, so a test can prove nothing was. */
function watchedDb(): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, statements };
}

function pubSubPush(path: string, init: { token?: string; header?: string } = {}): Request {
  const url = `https://agent.acme.example${path}${init.token !== undefined ? `?token=${encodeURIComponent(init.token)}` : ""}`;
  const body = JSON.stringify({ message: { data: btoa(JSON.stringify({ emailAddress: "avery@acme.example", historyId: "99999999" })), messageId: "1" }, subscription: "projects/acme-gtm-test/subscriptions/gmail-push" });
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", ...(init.header !== undefined ? { "x-push-token": init.header } : {}) }, body });
}

async function call(request: Request, options: { inbox?: FakeInbox; db?: D1Database; kv?: MemoryKv; secret?: string | undefined } = {}): Promise<Response> {
  const worker = createWorker(config, options.inbox ? { inbox: () => options.inbox } : {});
  const ctx = createExecutionContext();
  const testEnv = { ...(env as unknown as Env), DB: options.db ?? env.DB, KV: (options.kv ?? kvWith({ "inbox:enabled": "true" })) as unknown as KVNamespace, MAIL_PUSH_SECRET: "secret" in options ? options.secret : SECRET };
  const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function kvWith(values: Record<string, string>): MemoryKv {
  const kv = new MemoryKv();
  for (const [k, v] of Object.entries(values)) kv.map.set(k, v);
  return kv;
}

const PATH = "/api/webhooks/mail";

describe("the mailbox push webhook", () => {
  it("answers 503, touching nothing, while MAIL_PUSH_SECRET is unset", async () => {
    const watched = watchedDb();
    const inbox = fakeInbox({ name: uid("inbox") });
    expect((await call(pubSubPush(PATH, { token: SECRET }), { inbox, db: watched.db, secret: undefined })).status).toBe(503);
    expect(watched.statements).toEqual([]);
    expect(inbox.listCalls).toHaveLength(0);
  });

  it("refuses a push with no token, an empty token or the wrong token, before touching the database", async () => {
    const watched = watchedDb();
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage()] });
    for (const request of [pubSubPush(PATH), pubSubPush(PATH, { token: "" }), pubSubPush(PATH, { token: `${SECRET}x` }), pubSubPush(PATH, { header: SECRET.slice(1) })]) {
      expect((await call(request, { inbox, db: watched.db })).status).toBe(401);
    }
    expect(watched.statements).toEqual([]);
    expect(inbox.listCalls).toHaveLength(0);
  });

  it("acknowledges and does nothing else with the inbox off or its flag unreadable", async () => {
    const watched = watchedDb();
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage()] });
    const unreadable = kvWith({ "inbox:enabled": "true" });
    unreadable.failing = true;
    for (const kv of [kvWith({}), unreadable]) {
      const response = await call(pubSubPush(PATH, { token: SECRET }), { inbox, db: watched.db, kv });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, disabled: true });
    }
    expect(watched.statements).toEqual([]);
    expect(inbox.listCalls).toHaveLength(0);
  });

  it("acknowledges without polling while the system is halted", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage()] });
    const response = await call(pubSubPush(PATH, { token: SECRET }), { inbox, kv: kvWith({ "inbox:enabled": "true", "system:halt": JSON.stringify({ reason: "test" }) }) });
    expect(await response.json()).toMatchObject({ ok: true, halted: true });
    expect(inbox.listCalls).toHaveLength(0);
  });

  it("treats a verified push as a wake-up: one poll from the stored cursor, never from the push's history id", async () => {
    const message = inboundMessage({ from: { email: `${uid("riley")}@prospect.example` } });
    const inbox = fakeInbox({ name: uid("inbox"), messages: [message] });
    const kv = kvWith({ "inbox:enabled": "true", [cursorKey(inbox.name)]: JSON.stringify({ cursor: "n:0", at: new Date().toISOString() }) });
    const response = await call(pubSubPush(PATH, { header: SECRET }), { inbox, kv });
    expect(response.status).toBe(200);
    expect(inbox.listCalls.map((c) => c.cursor)).toEqual(["n:0"]);
    const row = await env.DB.prepare("SELECT classification FROM inbound_emails WHERE provider = ?1 AND provider_message_id = ?2").bind(inbox.name, message.providerMessageId).first();
    expect(row).not.toBeNull();
    // A burst of pushes runs one poll.
    expect(await (await call(pubSubPush(PATH, { token: SECRET }), { inbox, kv })).json()).toMatchObject({ coalesced: true });
    expect(inbox.listCalls).toHaveLength(1);
  });

  it("answers 503 after verifying when no mailbox is configured", async () => {
    expect((await call(pubSubPush(PATH, { token: SECRET }))).status).toBe(503);
  });
});
