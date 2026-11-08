// GTM-agents: the milestone gate for delivery, end to end: a batch goes out, delivery is recorded,
// and a bounce suppresses the address.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import type { Env } from "../src/env.ts";
import { createOutreachSender } from "../src/sending/boundary.ts";
import { checkSuppression } from "../src/sending/suppression.ts";
import { fakeEmailWebhook } from "../src/sending/testing.ts";
import { createWorker } from "../src/worker.ts";
import { coldItem, config, harness, insertCampaign, insertContact, insertDraft, NOW, WEBHOOK_SECRET } from "./delivery-fakes.ts";

const db = env.DB;

describe("delivery, end to end", () => {
  it("sends a batch, records delivery, and suppresses a bounced address so the next send is refused", async () => {
    const h = harness(db);
    const operator = recordingOperator();
    const worker = createWorker(config, { email: () => h.provider, operator: () => operator.channel });
    const post = async (request: Request) => {
      const ctx = createExecutionContext();
      const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, env as unknown as Env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };

    // A batch of three approved cold drafts goes out.
    const campaignId = await insertCampaign(db);
    const contacts = await Promise.all([1, 2, 3].map(() => insertContact(db)));
    const items = await Promise.all(
      contacts.map(async (c) => {
        const item = coldItem(c, { campaignId });
        const draft = await insertDraft(db, c, { subject: item.subject, body: item.body }, { campaignId });
        return { ...item, draftId: draft.id, approvedDigest: draft.digest };
      }),
    );
    const send = createOutreachSender(h.deps);
    const outcomes = await send(items);
    expect(outcomes.map((o) => o.status)).toEqual(["sent", "sent", "sent"]);

    // Each send is on the ledger, each contact is contacted, and each message carries the footer and headers.
    for (const [i, contact] of contacts.entries()) {
      const outcome = outcomes[i];
      if (outcome?.status !== "sent") throw new Error("expected a send");
      expect(await db.prepare("SELECT contact_id, provider_message_id FROM outreach_sends WHERE id = ?1").bind(outcome.sendId).first()).toEqual({ contact_id: contact.id, provider_message_id: outcome.providerMessageId });
      expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string }>())?.warmth).toBe("contacted");
      const message = h.provider.messages()[i];
      expect(message?.text).toContain(config.sending.postalAddress);
      expect(message?.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/agent\.acme\.example\/u\/[^>]+>, <mailto:/);
      expect(message?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }

    // The provider reports the first delivered and the second hard-bounced, through the signed webhook.
    const [delivered, bounced] = outcomes.map((o) => (o.status === "sent" ? o : null));
    const [first, second] = contacts;
    if (!delivered || !bounced || !first || !second) throw new Error("expected two sends");
    const at = NOW.toISOString();
    const tagsOf = (i: number) => h.provider.messages()[i]?.tags ?? {};
    const deliveredResponse = await post(await fakeEmailWebhook([{ type: "delivered", providerMessageId: delivered.providerMessageId, tags: tagsOf(0), to: first.email, at }], { secret: WEBHOOK_SECRET, at: NOW }));
    expect(deliveredResponse.status).toBe(200);
    expect((await db.prepare("SELECT delivered_at FROM outreach_sends WHERE id = ?1").bind(delivered.sendId).first<{ delivered_at: string | null }>())?.delivered_at).not.toBeNull();
    expect((await db.prepare("SELECT delivered FROM domain_delivery WHERE domain = ?1").bind(first.email.split("@")[1]).first<{ delivered: number }>())?.delivered).toBe(1);

    const bounceResponse = await post(await fakeEmailWebhook([{ type: "bounced", providerMessageId: bounced.providerMessageId, tags: tagsOf(1), to: second.email, at, hard: true }], { secret: WEBHOOK_SECRET, at: NOW }));
    expect(bounceResponse.status).toBe(200);
    expect((await checkSuppression(db, [second.email])).blocked).toEqual([{ recipient: second.email, reason: "bounce" }]);
    expect(await db.prepare("SELECT warmth, verification_status FROM contacts WHERE id = ?1").bind(second.id).first()).toEqual({ warmth: "contacted", verification_status: "undeliverable" });
    expect((await db.prepare("SELECT hard_bounces FROM domain_delivery WHERE domain = ?1").bind(second.email.split("@")[1]).first<{ hard_bounces: number }>())?.hard_bounces).toBe(1);

    // The next send to the bounced address is refused at the boundary.
    const [next] = await send([coldItem(second, { path: "sequence", sequenceStep: 2 })]);
    expect(next).toMatchObject({ status: "blocked", reason: "suppressed" });
    expect(next?.status === "blocked" && next.message.startsWith("[SEND BLOCKED:suppressed]")).toBe(true);
    expect(h.provider.messages()).toHaveLength(3);
  });
});
