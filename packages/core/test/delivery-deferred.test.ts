// GTM-agents: tests for the deferred queue's replay: due rows are claimed once, re-checked, and sent
// through the same send function, with backoff and a page after the last attempt.
//
// Each test runs on its own dates early in 2026, so the replay only ever sees the rows it queued.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createOutreachSender } from "../src/sending/boundary.ts";
import { DEFERRED_MAX_ATTEMPTS, deferredBackoffMs, replayDeferred } from "../src/sending/deferred.ts";
import { coldItem, harness, insertCampaign, insertContact, uid, type TestContact } from "./delivery-fakes.ts";

const db = env.DB;

/** Queue a cold item for a Tokyo contact at `at` (02:00 Thursday in Tokyo, outside the window). */
async function queue(contact: TestContact, at: Date, overrides = {}) {
  const h = harness(db, { now: () => at });
  const [outcome] = await createOutreachSender(h.deps)([coldItem(contact, overrides)]);
  expect(outcome?.status).toBe("deferred");
  const row = await db.prepare("SELECT id, next_attempt_at FROM deferred_sends WHERE contact_id = ?1 AND status = 'queued'").bind(contact.id).first<{ id: string; next_attempt_at: string }>();
  if (!row) throw new Error("no queued row");
  return row;
}

const rowOf = (id: string) => db.prepare("SELECT status, attempt_count, next_attempt_at, last_error, provider_message_id FROM deferred_sends WHERE id = ?1").bind(id).first<Record<string, unknown>>();

describe("deferred replay", () => {
  it("backs off 1h, 2h, 4h, 8h", () => {
    expect([1, 2, 3, 4].map(deferredBackoffMs)).toEqual([1, 2, 4, 8].map((h) => h * 3_600_000));
  });

  it("sends a queued row once its window opens, through the same boundary", async () => {
    const contact = await insertContact(db, { timezone: "Asia/Tokyo" });
    const row = await queue(contact, new Date("2026-01-07T17:00:00.000Z"));
    expect(row.next_attempt_at).toBe("2026-01-07T23:00:00.000Z");
    const early = harness(db, { now: () => new Date("2026-01-07T22:00:00.000Z") });
    expect(await replayDeferred({ ...early.deps, maxRows: 50 })).toMatchObject({ due: 0 });
    const h = harness(db, { now: () => new Date("2026-01-07T23:30:00.000Z") });
    const result = await replayDeferred({ ...h.deps, maxRows: 50 });
    expect(result).toMatchObject({ due: 1, claimed: 1, sent: 1 });
    expect(await rowOf(row.id)).toMatchObject({ status: "sent", attempt_count: 1 });
    expect(h.provider.messages()[0]?.to.email).toBe(contact.email);
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string }>())?.warmth).toBe("contacted");
  });

  it("cancels a cold row whose contact was contacted since, and a sequence row whose contact replied", async () => {
    const contacted = await insertContact(db, { timezone: "Asia/Tokyo" });
    const replied = await insertContact(db, { timezone: "Asia/Tokyo", warmth: "contacted" });
    const campaignId = await insertCampaign(db);
    const coldRow = await queue(contacted, new Date("2026-01-14T17:00:00.000Z"));
    const seqRow = await queue(replied, new Date("2026-01-14T17:00:00.000Z"), { path: "sequence", campaignId });
    await db.prepare("UPDATE contacts SET warmth = 'contacted' WHERE id = ?1").bind(contacted.id).run();
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, contact_id) VALUES (?1, 'test', ?2, ?3, '2026-01-14T18:00:00.000Z', ?4)")
      .bind(uid("inbound"), uid("msg"), replied.email, replied.id)
      .run();
    const h = harness(db, { now: () => new Date("2026-01-14T23:30:00.000Z") });
    const result = await replayDeferred({ ...h.deps, maxRows: 50 });
    expect(result).toMatchObject({ claimed: 2, cancelled: 2, sent: 0 });
    expect(await rowOf(coldRow.id)).toMatchObject({ status: "cancelled" });
    expect(String((await rowOf(seqRow.id))?.last_error)).toContain("replied");
    expect(h.provider.batches).toHaveLength(0);
  });

  it("requeues with backoff, then fails after the last attempt and pages once", async () => {
    const contact = await insertContact(db, { timezone: "Asia/Tokyo" });
    const row = await queue(contact, new Date("2026-01-21T17:00:00.000Z"));
    let at = new Date("2026-01-21T23:30:00.000Z");
    const h = harness(db, { now: () => at });
    h.provider.behavior = { code: "rate_limited", retryable: true };
    for (let attempt = 1; attempt <= DEFERRED_MAX_ATTEMPTS; attempt++) {
      const result = await replayDeferred({ ...h.deps, maxRows: 50 });
      expect(result.claimed, `attempt ${attempt}`).toBe(1);
      const current = await rowOf(row.id);
      if (attempt < DEFERRED_MAX_ATTEMPTS) {
        expect(current).toMatchObject({ status: "queued", attempt_count: attempt });
        expect(Date.parse(String(current?.next_attempt_at)) - at.getTime()).toBeGreaterThanOrEqual(deferredBackoffMs(attempt));
        at = new Date(Date.parse(String(current?.next_attempt_at)) + 60_000);
      } else {
        expect(current).toMatchObject({ status: "failed", attempt_count: DEFERRED_MAX_ATTEMPTS });
      }
    }
    expect(h.operator.messages.filter((m) => m.text.startsWith("Deferred sends failed"))).toHaveLength(1);
  });

  it("claims a row for one replay only, even when two run at once", async () => {
    const contact = await insertContact(db, { timezone: "Asia/Tokyo" });
    const row = await queue(contact, new Date("2026-01-28T17:00:00.000Z"));
    const at = new Date("2026-01-28T23:30:00.000Z");
    const a = harness(db, { now: () => at });
    const b = harness(db, { now: () => at });
    const results = await Promise.all([replayDeferred({ ...a.deps, maxRows: 50 }), replayDeferred({ ...b.deps, maxRows: 50 })]);
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(a.provider.messages().length + b.provider.messages().length).toBe(1);
    expect(await rowOf(row.id)).toMatchObject({ status: "sent" });
  });

  it("cancels a row whose message was already sent under the same key", async () => {
    const contact = await insertContact(db, { timezone: "Asia/Tokyo" });
    const key = uid("same-key");
    const row = await queue(contact, new Date("2026-02-04T17:00:00.000Z"), { idempotencyKey: key });
    // The same message goes out directly once the window is open, then the replay finds it.
    const direct = harness(db, { now: () => new Date("2026-02-04T23:10:00.000Z") });
    expect((await createOutreachSender(direct.deps)([coldItem(contact, { idempotencyKey: key })]))[0]?.status).toBe("sent");
    const h = harness(db, { now: () => new Date("2026-02-04T23:30:00.000Z") });
    await replayDeferred({ ...h.deps, maxRows: 50 });
    expect(await rowOf(row.id)).toMatchObject({ status: "cancelled" });
    expect(h.provider.batches).toHaveLength(0);
  });
});
