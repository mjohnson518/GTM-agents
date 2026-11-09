// GTM-agents: tests for first-touch attribution as the reply track writes it to the send ledger: the
// latest first touch within 60 days, the reply's own timestamps, a bounded reply_after_step, and
// the earliest reply winning. Every contact and send is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_WINDOW_DAYS as METRICS_WINDOW } from "../src/metrics/index.ts";
import { ATTRIBUTION_WINDOW_DAYS, creditReply } from "../src/replies/ledger.ts";
import { insertContact, uid } from "./delivery-fakes.ts";

const db = env.DB;

async function send(contactId: string, step: number, sentAt: string, path = step === 1 ? "cold" : "sequence"): Promise<string> {
  const id = uid("os");
  await db.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sequence_step, sent_at) VALUES (?1, ?2, ?3, 'test-ledger', ?4, ?5)").bind(id, contactId, path, step, sentAt).run();
  return id;
}

const ledger = (id: string) => db.prepare("SELECT replied_at, reply_intent, reply_after_step, positive_reply_at FROM outreach_sends WHERE id = ?1").bind(id).first();

describe("first-touch attribution", () => {
  it("has one window, defined by the metrics module", () => {
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(METRICS_WINDOW);
    expect(METRICS_WINDOW).toBe(60);
  });

  it("credits the latest first touch before the reply, with the reply's own time and the depth actually sent", async () => {
    const c = await insertContact(db);
    const older = await send(c.id, 1, "2022-01-01T10:00:00.000Z");
    const first = await send(c.id, 1, "2022-02-01T10:00:00.000Z");
    await send(c.id, 2, "2022-02-04T10:00:00.000Z");
    await send(c.id, 3, "2022-02-20T10:00:00.000Z");
    const credit = await creditReply(db, { contactId: c.id, intent: "question", classification: "reply", receivedAt: "2022-02-10T08:30:00.000Z" });
    expect(credit).toEqual({ sendId: first, replyAfterStep: 2, positive: true });
    expect(await ledger(first)).toEqual({ replied_at: "2022-02-10T08:30:00.000Z", reply_intent: "question", reply_after_step: 2, positive_reply_at: "2022-02-10T08:30:00.000Z" });
    expect(await ledger(older)).toEqual({ replied_at: null, reply_intent: null, reply_after_step: null, positive_reply_at: null });
  });

  it("keeps the earliest reply when replies arrive out of order", async () => {
    const c = await insertContact(db);
    const first = await send(c.id, 1, "2022-03-01T10:00:00.000Z");
    await send(c.id, 2, "2022-03-04T10:00:00.000Z");
    await creditReply(db, { contactId: c.id, intent: "interested", classification: "reply", receivedAt: "2022-03-06T09:00:00.000Z" });
    await creditReply(db, { contactId: c.id, intent: "objection", classification: "reply", receivedAt: "2022-03-02T09:00:00.000Z" });
    expect(await ledger(first)).toEqual({ replied_at: "2022-03-02T09:00:00.000Z", reply_intent: "objection", reply_after_step: 1, positive_reply_at: "2022-03-06T09:00:00.000Z" });
  });

  it("credits nothing outside the window, and nothing that is not a reply", async () => {
    const c = await insertContact(db);
    const first = await send(c.id, 1, "2022-04-01T10:00:00.000Z");
    expect((await creditReply(db, { contactId: c.id, intent: "interested", classification: "reply", receivedAt: "2022-06-15T10:00:00.000Z" })).sendId).toBeNull();
    expect((await creditReply(db, { contactId: c.id, intent: "opt_out", classification: "reply", receivedAt: "2022-04-02T10:00:00.000Z" })).sendId).toBeNull();
    expect((await creditReply(db, { contactId: c.id, intent: "interested", classification: "auto_reply", receivedAt: "2022-04-02T10:00:00.000Z" })).sendId).toBeNull();
    expect((await creditReply(db, { contactId: c.id, intent: "interested", classification: "reply", receivedAt: "2022-03-31T10:00:00.000Z" })).sendId).toBeNull();
    expect(await ledger(first)).toEqual({ replied_at: null, reply_intent: null, reply_after_step: null, positive_reply_at: null });
  });
});
