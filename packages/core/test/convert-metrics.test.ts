// GTM-agents: the one definition of a meeting booked, its place in the positive-reply definition,
// crediting and withdrawing it on the send ledger, and the scorecard's meeting lines. Every person,
// company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { creditMeeting, withdrawMeetingCredit } from "../src/convert/ledger.ts";
import { resetConvertTables } from "../src/convert/testing.ts";
import { countMeetings, isMeetingBooked, meetingEvidence, perHundred } from "../src/metrics/meetings.ts";
import { isPositiveReply, positiveReplyAt } from "../src/metrics/positive-reply.ts";
import { flagReader, seedContact } from "../src/outreach/testing.ts";
import { loadScorecard, renderScorecard } from "../src/reports/scorecard.ts";
import { seedFirstTouch } from "../src/sequences/testing.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

async function meeting(id: string, contactId: string, opts: { firstSeen: string; start?: string; status?: string; attribution?: string | null; outcome?: string | null }) {
  const start = opts.start ?? opts.firstSeen;
  await db
    .prepare("INSERT INTO calendar_meetings (event_id, contact_id, starts_at, ends_at, status, attribution, outcome, first_seen_at) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, contactId, start, opts.status ?? "confirmed", opts.attribution === undefined ? "accepted_contact" : opts.attribution, opts.outcome ?? null, opts.firstSeen)
    .run();
  return { event_id: id, status: opts.status ?? "confirmed", attribution: opts.attribution === undefined ? "accepted_contact" : opts.attribution, first_seen_at: opts.firstSeen };
}

const positiveAt = (contactId: string) => db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(contactId).first<{ positive_reply_at: string | null }>().then((r) => r?.positive_reply_at ?? null);

beforeEach(async () => {
  await resetConvertTables(db);
});

describe("a meeting booked", () => {
  it("is attributed and not cancelled; it counts as positive only when first seen after the send", () => {
    expect(isMeetingBooked({ status: "confirmed", attribution: "accepted_contact" })).toBe(true);
    expect(isMeetingBooked({ status: "tentative", attribution: "domain_contacted" })).toBe(true);
    expect(isMeetingBooked({ status: "cancelled", attribution: "accepted_contact" })).toBe(false);
    expect(isMeetingBooked({ status: "confirmed", attribution: null })).toBe(false);
    expect(isMeetingBooked({ status: "confirmed", attribution: "clicked_link" })).toBe(false);
    const row = { status: "confirmed", attribution: "operator_link", first_seen_at: iso(0) };
    expect(isPositiveReply({ meeting: meetingEvidence(row), sentAt: iso(-1) })).toBe(true);
    expect(isPositiveReply({ meeting: meetingEvidence(row), sentAt: iso(1) })).toBe(false);
    expect(isPositiveReply({ meeting: meetingEvidence({ ...row, attribution: null }), sentAt: iso(-1) })).toBe(false);
    expect(positiveReplyAt({ intent: "question", classification: "reply", receivedAt: iso(-0.5), meeting: meetingEvidence(row), sentAt: iso(-1) })).toBe(iso(-0.5));
    expect(perHundred(3, 40)).toBe(7.5);
    expect(perHundred(1, 0)).toBeNull();
  });

  it("counts booked by first sighting, and held, no-shows and cancellations by start", async () => {
    const c = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await meeting("m1", c, { firstSeen: iso(-3), start: iso(2) });
    await meeting("m2", c, { firstSeen: iso(-20), start: iso(-2), outcome: "held" });
    await meeting("m3", c, { firstSeen: iso(-4), start: iso(-1), outcome: "no_show" });
    await meeting("m4", c, { firstSeen: iso(-2), start: iso(-1), status: "cancelled", outcome: "cancelled" });
    await meeting("m5", c, { firstSeen: iso(-1), attribution: null });
    expect(await countMeetings(db, { from: iso(-7), to: iso(0) })).toEqual({ booked: 2, bookedAfterOutreach: 0, held: 1, heldAfterOutreach: 0, noShows: 1, cancelled: 1 });
  });

  it("counts every attributed booking as booked, and only those first seen after a first touch in 60 days as after outreach", async () => {
    const prospect = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    const customer = await seedContact(db, { first: "Omar", email: "omar@initech.example" });
    const stale = await seedContact(db, { first: "Lena", email: "lena@umbrella.example" });
    await seedFirstTouch(db, { campaignId: "cb", contactId: prospect, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 10 * DAY) });
    await seedFirstTouch(db, { campaignId: "cb", contactId: stale, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 70 * DAY) });
    await meeting("m-prospect", prospect, { firstSeen: iso(-2), start: iso(-1), outcome: "held" });
    // A call with an existing customer nobody wrote to, and one first seen 70 days after the send.
    await meeting("m-customer", customer, { firstSeen: iso(-2), start: iso(-1), outcome: "held" });
    await meeting("m-stale", stale, { firstSeen: iso(-2), start: iso(-1) });
    // A meeting first seen before the send it would follow.
    await meeting("m-before-send", prospect, { firstSeen: iso(-11), start: iso(-1) });
    const counts = await countMeetings(db, { from: iso(-30), to: iso(0) });
    expect(counts).toMatchObject({ booked: 4, bookedAfterOutreach: 1, held: 2, heldAfterOutreach: 1 });
  });

  it("does not count a meeting that had already started when calendar sync began watching as booked, or as positive", async () => {
    const c = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await seedFirstTouch(db, { campaignId: "cb", contactId: c, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 10 * DAY) });
    const m = await meeting("m-pre", c, { firstSeen: iso(-1), start: iso(-2) });
    await db.prepare("UPDATE calendar_meetings SET before_baseline = 1 WHERE event_id = 'm-pre'").run();
    expect(await countMeetings(db, { from: iso(-7), to: iso(0) })).toMatchObject({ booked: 0, bookedAfterOutreach: 0 });
    expect(isMeetingBooked({ ...m, before_baseline: 1 })).toBe(false);
    expect(await creditMeeting(db, c, { ...m, before_baseline: 1 })).toBeNull();
  });
});

describe("the ledger credit", () => {
  it("credits the latest first touch in the 60 days before the meeting was first seen, keeping an earlier positive reply", async () => {
    const c = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await seedFirstTouch(db, { campaignId: "cb", contactId: c, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 10 * DAY) });
    const m = await meeting("m1", c, { firstSeen: iso(0) });
    expect(await creditMeeting(db, c, m)).toBe(`os_${c}_1`);
    expect(await positiveAt(c)).toBe(iso(0));
    // A positive reply credited earlier wins and is never touched by a withdrawal.
    await db.prepare("UPDATE outreach_sends SET positive_reply_at = ?2 WHERE contact_id = ?1").bind(c, iso(-1)).run();
    await creditMeeting(db, c, m);
    expect(await positiveAt(c)).toBe(iso(-1));
    await db.prepare("UPDATE calendar_meetings SET status = 'cancelled' WHERE event_id = 'm1'").run();
    expect(await withdrawMeetingCredit(db, c, m)).toBe(false);
    expect(await positiveAt(c)).toBe(iso(-1));
  });

  it("does not credit a meeting seen before the send, or one with no first touch in 60 days", async () => {
    const c = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await seedFirstTouch(db, { campaignId: "cb", contactId: c, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 70 * DAY) });
    expect(await creditMeeting(db, c, await meeting("m1", c, { firstSeen: iso(0) }))).toBeNull();
    expect(await positiveAt(c)).toBeNull();
  });

  it("on withdrawal, falls back to a later positive reply or another booked meeting, else clears", async () => {
    const c = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await seedFirstTouch(db, { campaignId: "cb", contactId: c, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 10 * DAY) });
    const first = await meeting("m1", c, { firstSeen: iso(-5) });
    await creditMeeting(db, c, first);
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification, intent, contact_id) VALUES ('in-1', 'fake', 'pm-1', 'jane@globex.example', ?2, 'reply', 'interested', ?1)")
      .bind(c, iso(-2))
      .run();
    const second = await meeting("m2", c, { firstSeen: iso(-3) });
    await creditMeeting(db, c, second);
    expect(await positiveAt(c)).toBe(iso(-5));
    await db.prepare("UPDATE calendar_meetings SET status = 'cancelled' WHERE event_id = 'm1'").run();
    expect(await withdrawMeetingCredit(db, c, first)).toBe(true);
    expect(await positiveAt(c)).toBe(iso(-3));
    await db.prepare("DELETE FROM calendar_meetings WHERE event_id = 'm2'").run();
    expect(await withdrawMeetingCredit(db, c, second)).toBe(true);
    expect(await positiveAt(c)).toBe(iso(-2));
    await db.prepare("UPDATE inbound_emails SET intent = 'objection' WHERE id = 'in-1'").run();
    await db.prepare("UPDATE outreach_sends SET positive_reply_at = ?2 WHERE contact_id = ?1").bind(c, iso(-3)).run();
    await meeting("m3", c, { firstSeen: iso(-3), status: "cancelled" });
    expect(await withdrawMeetingCredit(db, c, { event_id: "m3", first_seen_at: iso(-3) })).toBe(true);
    expect(await positiveAt(c)).toBeNull();
  });
});

describe("the scorecard's meeting lines", () => {
  it("say not measured yet while calendar sync is off, and show the counts once it is on", async () => {
    const c = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await seedFirstTouch(db, { campaignId: "cb", contactId: c, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 10 * DAY) });
    await meeting("m1", c, { firstSeen: iso(-0.1), start: iso(1) });
    await meeting("m2", c, { firstSeen: iso(-9), start: iso(-3), outcome: "held" });
    const off = renderScorecard(await loadScorecard(db, flagReader({}), NOW));
    expect(off).toContain("meetings and quotas: not measured yet.");
    expect(off).toContain("Convert, 30 days: meetings booked and held, sign-ups, activations and paid: not measured yet");
    const on = renderScorecard(await loadScorecard(db, flagReader({ "convert:calendar_enabled": "true" }), NOW));
    expect(on).toContain("0 first touches, 0 positive replies, 1 meeting booked (1 after outreach). Sign-ups, activations, new paying customers and quotas: not measured yet.");
    expect(on).toContain("Convert, 30 days: 1 meeting booked (1 after outreach), 1 held (1 after outreach), 0 no-shows, 0 cancelled; held after outreach per 100 first touches: 100. Sign-ups, activations and paid: not measured yet");
    const unreadable = renderScorecard(await loadScorecard(db, flagReader({}, ["convert:calendar_enabled"]), NOW));
    expect(unreadable).toContain("- the meetings section could not be read");
  });
});
