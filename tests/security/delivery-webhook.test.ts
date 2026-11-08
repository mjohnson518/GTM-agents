// GTM-agents: the email provider webhook fails closed. A tampered, unsigned or replayed (stale)
// webhook is rejected before the database is touched, a webhook nobody can verify answers 503, and a
// redelivered event changes nothing the second time.
import type { Env } from "@gtm-agents/core";
import { createWorker } from "@gtm-agents/core";
import { defineConfig } from "@gtm-agents/core/config";
import type { EmailEvent } from "@gtm-agents/core/ports";
import { fakeEmailProvider, fakeEmailWebhook } from "@gtm-agents/core/sending/testing";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uid } from "./helpers.ts";

const SECRET = "test-email-webhook-secret";
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

async function call(provider: ReturnType<typeof fakeEmailProvider> | undefined, request: Request, db: D1Database): Promise<Response> {
  const worker = createWorker(config, { email: () => provider });
  const ctx = createExecutionContext();
  const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, { ...(env as unknown as Env), DB: db }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const complaint = (): EmailEvent => ({ type: "complained", providerMessageId: uid("msg"), tags: {}, to: `${uid("riley").replace(/_/g, "-")}@prospect.example`, at: new Date().toISOString() });

describe("the email provider webhook", () => {
  it("rejects a tampered webhook before touching the database", async () => {
    const watched = watchedDb();
    const response = await call(fakeEmailProvider({ name: uid("esp"), webhookSecret: SECRET }), await fakeEmailWebhook([complaint()], { secret: SECRET, tamper: true }), watched.db);
    expect(response.status).toBe(401);
    expect(watched.statements).toEqual([]);
  });

  it("rejects a replayed webhook outside the 5-minute window before touching the database", async () => {
    const watched = watchedDb();
    const stale = await fakeEmailWebhook([complaint()], { secret: SECRET, at: new Date(Date.now() - 6 * 60_000) });
    expect((await call(fakeEmailProvider({ name: uid("esp"), webhookSecret: SECRET }), stale, watched.db)).status).toBe(401);
    expect(watched.statements).toEqual([]);
  });

  it("rejects an unsigned webhook, and a webhook signed with another secret", async () => {
    const watched = watchedDb();
    const provider = fakeEmailProvider({ name: uid("esp"), webhookSecret: SECRET });
    expect((await call(provider, await fakeEmailWebhook([complaint()], { secret: SECRET, unsigned: true }), watched.db)).status).toBe(401);
    expect((await call(provider, await fakeEmailWebhook([complaint()], { secret: `${SECRET}-other` }), watched.db)).status).toBe(401);
    expect(watched.statements).toEqual([]);
  });

  it("answers 503, touching nothing, when no provider or no webhook secret is configured", async () => {
    const watched = watchedDb();
    expect((await call(undefined, await fakeEmailWebhook([complaint()], { secret: SECRET }), watched.db)).status).toBe(503);
    expect((await call(fakeEmailProvider({ name: uid("esp") }), await fakeEmailWebhook([complaint()], { secret: SECRET }), watched.db)).status).toBe(503);
    expect(watched.statements).toEqual([]);
  });

  it("processes a redelivered event once", async () => {
    const provider = fakeEmailProvider({ name: uid("esp"), webhookSecret: SECRET });
    const event = complaint();
    const first = await call(provider, await fakeEmailWebhook([event], { secret: SECRET }), env.DB);
    expect(await first.json()).toMatchObject({ processed: 1 });
    const watched = watchedDb();
    const second = await call(provider, await fakeEmailWebhook([event], { secret: SECRET }), watched.db);
    expect(await second.json()).toMatchObject({ processed: 0, duplicates: 1 });
    // Suppression is re-applied (it is idempotent and runs before the claim); nothing else is written twice.
    expect(watched.statements.filter((sql) => /^\s*(INSERT|UPDATE)/i.test(sql) && !/event_effects|suppression|campaign_contacts|outreach_sequence_runs|deferred_sends|contacts SET warmth/i.test(sql))).toEqual([]);
  });
});
