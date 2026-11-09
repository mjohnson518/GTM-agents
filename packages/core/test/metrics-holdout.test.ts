// GTM-agents: tests for holdout lift: held against treated contacts, outcomes measured the same way
// for both, bounded by the attribution window, sign-ups only once product events exist, and the
// verdict. Every contact and message is synthetic, on *.example domains.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIN_HELD, holdoutLift, judgeHealth, liftVerdict, metricWindow } from "../src/metrics/index.ts";
import { insertContact, uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const base = Date.parse("2022-03-01T00:00:00.000Z");
const at = (days: number) => new Date(base + days * DAY).toISOString();

async function held(days: number): Promise<string> {
  const c = await insertContact(db);
  await db.prepare("INSERT INTO outreach_holdout (contact_id, cohort, held_at) VALUES (?1, ?2, ?3)").bind(c.id, at(days).slice(0, 10), at(days)).run();
  return c.id;
}

async function treated(days: number, step = 1): Promise<string> {
  const c = await insertContact(db);
  await db.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sequence_step, sent_at) VALUES (?1, ?2, 'cold', 'test-ledger', ?3, ?4)").bind(uid("os"), c.id, step, at(days)).run();
  return c.id;
}

async function reply(contactId: string, days: number, intent: string, classification = "reply"): Promise<void> {
  await db
    .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, intent, classification, contact_id) VALUES (?1, 'test', ?2, 'x@prospect.example', ?3, ?4, ?5, ?6)")
    .bind(uid("in"), uid("msg"), at(days), intent, classification, contactId)
    .run();
}

describe("holdout lift", () => {
  it("compares positive reply rates of held and treated contacts entering in the window", async () => {
    const window = metricWindow(new Date(at(0)), new Date(at(20)));
    const now = new Date(at(120));
    const h1 = await held(1);
    const h2 = await held(2);
    await held(3);
    await held(4);
    await held(25);
    await reply(h1, 5, "interested");
    await reply(h2, 70, "question");
    const t1 = await treated(1);
    const t2 = await treated(2);
    const t3 = await treated(3);
    await treated(4);
    await treated(30);
    await reply(t1, 3, "referral");
    await reply(t2, 6, "interested", "auto_reply");
    await reply(t3, 0, "interested");
    await reply(t3, 9, "warm");

    const lift = await holdoutLift(db, window, now, { measureSignups: false });
    expect(lift.held).toEqual({ contacts: 4, positives: 1, positiveRate: 0.25, signups: null, signupRate: null });
    expect(lift.treated).toEqual({ contacts: 4, positives: 1, positiveRate: 0.25, signups: null, signupRate: null });
    expect(lift.positiveLift).toBe(0);
    expect(lift.signupLift).toBeNull();
  });

  it("measures sign-ups within 30 days only when asked to", async () => {
    const window = metricWindow(new Date(at(200)), new Date(at(210)));
    const h = await held(201);
    const t = await treated(201);
    // A sign-up is the funnel event the lifecycle writes (metrics/product.ts); one from a source that
    // is not the product bridge or billing never counts.
    const signup = (contactId: string, days: number, source = "product") =>
      db.prepare("INSERT INTO funnel_events (id, event_type, contact_id, source, occurred_at) VALUES (?1, 'signed_up', ?2, ?3, ?4)").bind(uid("fe"), contactId, source, at(days)).run();
    await signup(t, 220);
    await signup(h, 240);
    await signup(h, 215, "manual");
    const lift = await holdoutLift(db, window, new Date(at(300)), { measureSignups: true });
    expect(lift.treated).toMatchObject({ contacts: 1, signups: 1, signupRate: 1 });
    expect(lift.held).toMatchObject({ contacts: 1, signups: 0, signupRate: 0 });
    expect(lift.signupLift).toBe(1);
  });

  it("leaves a held contact out of the treated group, and counts a contact once", async () => {
    const window = metricWindow(new Date(at(400)), new Date(at(410)));
    const t = await treated(401);
    await db.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sequence_step, sent_at) VALUES (?1, ?2, 'cold', 'test-ledger', 1, ?3)").bind(uid("os"), t, at(405)).run();
    const both = await treated(402);
    await db.prepare("INSERT INTO outreach_holdout (contact_id, cohort, held_at) VALUES (?1, 'x', ?2)").bind(both, at(300)).run();
    const lift = await holdoutLift(db, window, new Date(at(500)), { measureSignups: false });
    expect(lift.treated.contacts).toBe(1);
  });

  it("is sufficient only with 100 held contacts and healthy measurement", () => {
    const healthy = judgeHealth({ ledger: { evidence: 0, matched: 0, coverage: null, ledgerRows: 0 }, bridgeUnrouted: 0, productEventsSeen: false });
    const blocked = judgeHealth({ ledger: null, bridgeUnrouted: 0, productEventsSeen: false });
    const arm = (contacts: number) => ({ contacts, positives: 1, positiveRate: 1 / contacts, signups: null, signupRate: null });
    const lift = (heldCount: number) => ({ held: arm(heldCount), treated: arm(1000), positiveLift: 0.01, signupLift: null });
    expect(liftVerdict(lift(MIN_HELD), healthy)).toMatchObject({ positiveSufficient: true, signupSufficient: false });
    expect(liftVerdict(lift(MIN_HELD - 1), healthy)).toMatchObject({ positiveSufficient: false, reasons: [`${MIN_HELD - 1} held, ${MIN_HELD} needed`] });
    expect(liftVerdict(lift(MIN_HELD), blocked).positiveSufficient).toBe(false);
    expect(liftVerdict({ ...lift(MIN_HELD), treated: arm(3) }, healthy)).toMatchObject({ positiveSufficient: false, reasons: [`3 written to, ${MIN_HELD} needed`] });
  });
});
