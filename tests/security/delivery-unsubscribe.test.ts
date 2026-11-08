// GTM-agents: the unsubscribe link cannot be triggered by a prefetch or forged. GET never acts and
// never touches the database (mail scanners and link previews fetch links on their own), a forged
// token is rejected before the database is touched, and only a POST with a valid token opts out.
import type { Env } from "@gtm-agents/core";
import { createWorker } from "@gtm-agents/core";
import { defineConfig } from "@gtm-agents/core/config";
import { checkSuppression, signUnsubscribeToken } from "@gtm-agents/core/sending";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uid } from "./helpers.ts";

// A synthetic signing key, low-entropy on purpose so secret scanners never mistake it for a real one.
const KEY = "k".repeat(48);
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

async function call(request: Request, db: D1Database): Promise<Response> {
  const worker = createWorker(config);
  const ctx = createExecutionContext();
  const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, { ...(env as unknown as Env), DB: db, UNSUBSCRIBE_SIGNING_KEY: KEY }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the unsubscribe link", () => {
  it("never acts on GET, however often it is fetched", async () => {
    const address = `${uid("riley").replace(/_/g, "-")}@prospect.example`;
    const token = await signUnsubscribeToken(address, KEY);
    const watched = watchedDb();
    for (const method of ["GET", "HEAD"]) {
      const response = await call(new Request(`https://agent.acme.example/u/${token}`, { method }), watched.db);
      expect(response.status, method).toBe(200);
    }
    expect(watched.statements).toEqual([]);
    expect((await checkSuppression(env.DB, [address])).ok).toBe(true);
  });

  it("rejects a forged token before touching the database", async () => {
    const forged = await signUnsubscribeToken(`${uid("riley").replace(/_/g, "-")}@prospect.example`, `${KEY}-forged`);
    const watched = watchedDb();
    expect((await call(new Request(`https://agent.acme.example/u/${forged}`, { method: "POST" }), watched.db)).status).toBe(400);
    expect(watched.statements).toEqual([]);
  });

  it("opts out only on POST with a valid token", async () => {
    const address = `${uid("riley").replace(/_/g, "-")}@prospect.example`;
    const token = await signUnsubscribeToken(address, KEY);
    const response = await call(new Request(`https://agent.acme.example/u/${token}`, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }), env.DB);
    expect(response.status).toBe(200);
    expect((await checkSuppression(env.DB, [address])).blocked).toEqual([{ recipient: address, reason: "opt_out" }]);
  });
});
