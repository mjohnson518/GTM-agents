// GTM-agents: tests for signed unsubscribe tokens and the /u/:token routes: GET confirms and never
// acts, POST opts the address out once.
import { recordingOperator } from "../src/agents/testing.ts";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { checkSuppression } from "../src/sending/suppression.ts";
import { isUsableSigningKey, publicOrigin, signUnsubscribeToken, verifyUnsubscribeToken } from "../src/sending/unsubscribe-token.ts";
import { createWorker } from "../src/worker.ts";
import { config, insertCampaign, insertContact, SIGNING_KEY, uid, watchedDb } from "./delivery-fakes.ts";

const db = env.DB;

describe("unsubscribe tokens", () => {
  it("round-trips a normalized address", async () => {
    const token = await signUnsubscribeToken("Riley@Prospect.example", SIGNING_KEY);
    expect(await verifyUnsubscribeToken(token, SIGNING_KEY)).toBe("riley@prospect.example");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects an altered address, an altered MAC, another key and malformed tokens", async () => {
    const token = await signUnsubscribeToken("riley@prospect.example", SIGNING_KEY);
    const [address, mac] = token.split(".");
    const other = btoa("mallory@prospect.example").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(await verifyUnsubscribeToken(`${other}.${mac}`, SIGNING_KEY)).toBeNull();
    expect(await verifyUnsubscribeToken(`${address}.${(mac ?? "").slice(0, -2)}AA`, SIGNING_KEY)).toBeNull();
    expect(await verifyUnsubscribeToken(token, `${SIGNING_KEY}-rotated`)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", `${address}.`, `${"A".repeat(600)}.${mac}`]) expect(await verifyUnsubscribeToken(bad, SIGNING_KEY)).toBeNull();
  });

  it("fails closed without a usable key", async () => {
    expect(isUsableSigningKey(undefined)).toBe(false);
    expect(isUsableSigningKey("too-short")).toBe(false);
    await expect(signUnsubscribeToken("riley@prospect.example", "too-short")).rejects.toThrow(/UNSUBSCRIBE_SIGNING_KEY/);
    const token = await signUnsubscribeToken("riley@prospect.example", SIGNING_KEY);
    expect(await verifyUnsubscribeToken(token, undefined)).toBeNull();
  });

  it("accepts only an https base URL (or plain http on localhost)", () => {
    expect(publicOrigin("https://agent.acme.example/some/path")).toBe("https://agent.acme.example");
    expect(publicOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(publicOrigin("http://agent.acme.example")).toBeNull();
    expect(publicOrigin("https://user:pass@agent.acme.example")).toBeNull();
    expect(publicOrigin(undefined)).toBeNull();
  });
});

describe("the /u/:token routes", () => {
  const operator = recordingOperator();
  const worker = createWorker(config, { operator: () => operator.channel });

  async function call(request: Request, bindings: Partial<Env> = {}): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, { ...(env as unknown as Env), UNSUBSCRIBE_SIGNING_KEY: SIGNING_KEY, ...bindings }, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("GET shows a confirmation with a POST form and changes nothing", async () => {
    const contact = await insertContact(db);
    const token = await signUnsubscribeToken(contact.email, SIGNING_KEY);
    const response = await call(new Request(`https://agent.acme.example/u/${token}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('method="post"');
    expect(html).toContain(contact.email);
    expect((await checkSuppression(db, [contact.email])).ok).toBe(true);
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string }>())?.warmth).toBe("cold");
  });

  it("POST suppresses, opts the contact out, stops sequences, cancels deferred sends and notifies once", async () => {
    const contact = await insertContact(db);
    const campaignId = await insertCampaign(db);
    await db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_active, sequence_step) VALUES (?1, ?2, 'sent', 1, 1)").bind(campaignId, contact.id).run();
    await db
      .prepare("INSERT INTO deferred_sends (id, contact_id, send_path, recipient_email, subject, body, defer_reason, next_attempt_at) VALUES (?1, ?2, 'sequence', ?3, 'Following up', 'Body', 'outside_window', '2026-11-05T13:00:00.000Z')")
      .bind(uid("deferred"), contact.id, contact.email)
      .run();
    const token = await signUnsubscribeToken(contact.email, SIGNING_KEY);
    const before = operator.messages.length;
    const oneClick = () => new Request(`https://agent.acme.example/u/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    const response = await call(oneClick());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("unsubscribed");
    expect((await checkSuppression(db, [contact.email])).blocked).toEqual([{ recipient: contact.email, reason: "opt_out" }]);
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string }>())?.warmth).toBe("opted_out");
    expect(await db.prepare("SELECT status, sequence_active FROM campaign_contacts WHERE campaign_id = ?1").bind(campaignId).first()).toEqual({ status: "opted_out", sequence_active: 0 });
    expect((await db.prepare("SELECT status FROM deferred_sends WHERE contact_id = ?1").bind(contact.id).first<{ status: string }>())?.status).toBe("cancelled");
    expect(operator.messages.length - before).toBe(1);
    expect((await call(oneClick())).status).toBe(200);
    expect(operator.messages.length - before).toBe(1);
  });

  it("answers 400 to a forged token and 503 without a signing key", async () => {
    const token = await signUnsubscribeToken("riley@prospect.example", `${SIGNING_KEY}-other`);
    expect((await call(new Request(`https://agent.acme.example/u/${token}`, { method: "POST" }))).status).toBe(400);
    expect((await call(new Request(`https://agent.acme.example/u/${token}`))).status).toBe(400);
    expect((await call(new Request(`https://agent.acme.example/u/${token}`), { UNSUBSCRIBE_SIGNING_KEY: undefined })).status).toBe(503);
  });

  it("GET reads nothing from the database at all", async () => {
    const watched = watchedDb(db);
    const contact = await insertContact(db);
    const token = await signUnsubscribeToken(contact.email, SIGNING_KEY);
    const response = await call(new Request(`https://agent.acme.example/u/${token}`), { DB: watched.db });
    expect(response.status).toBe(200);
    expect(watched.statements).toEqual([]);
  });
});
