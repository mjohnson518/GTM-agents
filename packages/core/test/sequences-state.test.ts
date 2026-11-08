// GTM-agents: tests for the sequence state writes: stopping and holding sequences by contact or by
// account, and what each leaves alone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { holdSequences, stopSequences } from "../src/sequences/state.ts";
import { insertCampaign, insertContact, NOW, uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;

async function enrol(campaignId: string, contactId: string, fields: { status?: string; active?: number; next?: string | null } = {}): Promise<void> {
  await db
    .prepare("INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_step, sequence_active, next_send_at) VALUES (?1, ?2, ?3, 1, ?4, ?5)")
    .bind(campaignId, contactId, fields.status ?? "sent", fields.active ?? 1, fields.next === undefined ? new Date(NOW.getTime() + 3 * DAY).toISOString() : fields.next)
    .run();
}

const row = (campaignId: string, contactId: string) =>
  db
    .prepare("SELECT status, sequence_active, next_send_at, sequence_pause_reason FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2")
    .bind(campaignId, contactId)
    .first<{ status: string; sequence_active: number; next_send_at: string | null; sequence_pause_reason: string | null }>();

describe("stopSequences", () => {
  it("stops every sequence at an account, not just the contact who replied", async () => {
    const account = `${uid("acct")}.example`;
    const campaignId = await insertCampaign(db);
    const replied = await insertContact(db, { email: `riley@${account}`, accountKey: account });
    const colleague = await insertContact(db, { email: `sam@${account}`, accountKey: account });
    const elsewhere = await insertContact(db);
    for (const c of [replied, colleague, elsewhere]) await enrol(campaignId, c.id);
    expect(await stopSequences(db, { contactIds: [replied.id], accountKey: account }, { reason: "reply", status: "replied", now: NOW })).toBe(2);
    expect(await row(campaignId, replied.id)).toMatchObject({ status: "replied", sequence_active: 0, next_send_at: null, sequence_pause_reason: "reply" });
    expect(await row(campaignId, colleague.id)).toMatchObject({ status: "replied", sequence_active: 0 });
    expect(await row(campaignId, elsewhere.id)).toMatchObject({ status: "sent", sequence_active: 1 });
  });

  it("keeps a status already past sent and the first pause reason, and is idempotent", async () => {
    const campaignId = await insertCampaign(db);
    const contact = await insertContact(db);
    await enrol(campaignId, contact.id, { status: "bounced" });
    await stopSequences(db, { contactIds: [contact.id] }, { reason: "hard bounce", status: "bounced", now: NOW });
    await stopSequences(db, { contactIds: [contact.id] }, { reason: "reply", status: "replied", now: NOW });
    expect(await row(campaignId, contact.id)).toMatchObject({ status: "bounced", sequence_active: 0, sequence_pause_reason: "hard bounce" });
  });

  it("does nothing without a scope", async () => {
    expect(await stopSequences(db, {}, { reason: "reply", status: "replied", now: NOW })).toBe(0);
    expect(await stopSequences(db, { contactIds: [] }, { reason: "reply", status: "replied", now: NOW })).toBe(0);
  });
});

describe("holdSequences", () => {
  it("moves the next step later, never earlier, and never wakes a stopped sequence", async () => {
    const campaignId = await insertCampaign(db);
    const soon = await insertContact(db);
    const later = await insertContact(db);
    const stopped = await insertContact(db);
    await enrol(campaignId, soon.id, { next: new Date(NOW.getTime() + DAY).toISOString() });
    await enrol(campaignId, later.id, { next: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    await enrol(campaignId, stopped.id, { active: 0, next: null });
    const until = new Date(NOW.getTime() + 10 * DAY);
    expect(await holdSequences(db, { contactIds: [soon.id, later.id, stopped.id] }, { until, reason: "out of office", now: NOW })).toBe(1);
    expect(await row(campaignId, soon.id)).toMatchObject({ next_send_at: until.toISOString(), sequence_active: 1, sequence_pause_reason: "out of office" });
    expect((await row(campaignId, later.id))?.next_send_at).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    expect(await row(campaignId, stopped.id)).toMatchObject({ sequence_active: 0, next_send_at: null });
  });
});
