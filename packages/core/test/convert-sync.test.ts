// GTM-agents: calendar sync: which events are bookings, the attribution order, ambiguity, moves,
// cancellations and declines, and what is stored. Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { classifyEvent, meetingCode } from "../src/convert/state.ts";
import { runCalendarSync, syncWindow, type SyncDeps } from "../src/convert/sync.ts";
import { calendarEvent, fakeCalendar, resetConvertTables, type FakeCalendar } from "../src/convert/testing.ts";
import { AdapterError } from "../src/ports/types.ts";
import { seedContact, silentLogger } from "../src/outreach/testing.ts";
import { addressHash } from "../src/sending/suppression.ts";
import { seedFirstTouch } from "../src/sequences/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 86_400_000;
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["4249001"], allowedUserIds: ["4249001"] } });
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

let calendar: FakeCalendar;
let operator: ReturnType<typeof recordingOperator>;
const sync = (now = NOW, extra: Partial<SyncDeps> = {}) =>
  runCalendarSync({ db, calendar, config, operator: operator.channel, shown: memoryKv(), chatId: "4249001", now, log: silentLogger, maxRows: 100, ...extra });
const meetingOf = (id: string) => db.prepare("SELECT contact_id, attribution, status, outcome, starts_at, first_seen_at, reminded_24h_at FROM calendar_meetings WHERE event_id = ?1").bind(id).first<Record<string, unknown>>();
const eventOf = (id: string) => db.prepare("SELECT state, status, noticed_at, attendee_hashes, attendee_domains, operator_organized FROM calendar_events WHERE event_id = ?1").bind(id).first<Record<string, unknown>>();

beforeEach(async () => {
  await resetConvertTables(db);
  calendar = fakeCalendar();
  operator = recordingOperator();
});

describe("which events are bookings", () => {
  const classify = (input: Parameters<typeof calendarEvent>[0]) => classifyEvent(calendarEvent(input), config);

  it("needs a timed event with an outside person who accepted, or an invite the operator organized", () => {
    expect(classify({ id: "a", start: inDays(1), attendees: [{ email: "jane@globex.example" }] }).booking).toBe(true);
    expect(classify({ id: "b", start: inDays(1), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane@globex.example" }] }).booking).toBe(false);
    expect(classify({ id: "c", start: inDays(1), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane@globex.example", response: "accepted" }] }).booking).toBe(true);
    expect(classify({ id: "d", start: inDays(1), allDay: true, attendees: [{ email: "jane@globex.example", response: "accepted" }] })).toMatchObject({ timed: false, booking: false });
    expect(classify({ id: "e", start: inDays(1), status: "cancelled", attendees: [{ email: "jane@globex.example", response: "accepted" }] }).booking).toBe(false);
    expect(classify({ id: "f", start: inDays(1), operatorResponse: "declined", organizedByOperator: false, attendees: [{ email: "jane@globex.example", response: "accepted" }] }).booking).toBe(false);
  });

  it("counts no internal address, calendar resource, declined attendee or crowd", () => {
    const c = classify({
      id: "g",
      start: inDays(1),
      attendees: [
        { email: "pat@acme.example", response: "accepted" },
        { email: "ops@eu.acme.example", response: "accepted" },
        { email: "bot@outreach.acme.example", response: "accepted" },
        { email: "room-4@resource.calendar.google.com", response: "accepted" },
        { email: "kim@globex.example", response: "declined" },
        { email: "Jane@Globex.example", response: "tentative" },
      ],
    });
    expect(c.outside).toEqual([{ email: "jane@globex.example", accepted: false }]);
    expect(c.operatorOrganized).toBe(true);
    const crowd = classify({ id: "h", start: inDays(1), organizedByOperator: false, operatorResponse: "accepted", attendees: Array.from({ length: 11 }, (_, i) => ({ email: `p${i}@initech.example`, response: "accepted" as const })) });
    expect(crowd.booking).toBe(false);
  });

  it("gives each event a stable short code", async () => {
    expect(await meetingCode("evcode")).toMatch(/^mg[0-9a-f]{10}$/);
    expect(await meetingCode("evcode")).toBe(await meetingCode("evcode"));
    expect(await meetingCode("evcode")).not.toBe(await meetingCode("evcode2"));
  });
});

describe("attribution", () => {
  it("1. an accepted attendee who is a known contact, even on an invite from outside", async () => {
    const jane = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    calendar.events.push(calendarEvent({ id: "ev1", start: inDays(2), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane+cal@globex.example", response: "accepted" }] }));
    expect(await sync()).toMatchObject({ booked: 1 });
    expect(await meetingOf("ev1")).toMatchObject({ contact_id: jane, attribution: "accepted_contact" });
  });

  it("an invite from outside that no one accepted does nothing", async () => {
    await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    calendar.events.push(calendarEvent({ id: "ev2", start: inDays(2), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane@globex.example" }] }));
    expect(await sync()).toMatchObject({ handled: 0, booked: 0 });
    expect(await eventOf("ev2")).toBeNull();
    expect(operator.messages).toHaveLength(0);
  });

  it("2. the operator organized it and an invitee is a known contact", async () => {
    const ada = await seedContact(db, { first: "Ada", email: "ada@northwind.example" });
    calendar.events.push(calendarEvent({ id: "ev3", start: inDays(2), attendees: [{ email: "ada@northwind.example" }] }));
    await sync();
    expect(await meetingOf("ev3")).toMatchObject({ contact_id: ada, attribution: "organized_contact" });
  });

  it("3. exactly one contact written to at the attendee's company, only on the operator's own invite", async () => {
    const bob = await seedContact(db, { first: "Bob", email: "bob@initech.example" });
    await seedFirstTouch(db, { campaignId: "cb1", contactId: bob, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 20 * DAY) });
    // From outside, the same attendee is not attributed by domain.
    calendar.events.push(calendarEvent({ id: "ev4", start: inDays(2), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "cto@initech.example", response: "accepted" }] }));
    calendar.events.push(calendarEvent({ id: "ev5", start: inDays(3), attendees: [{ email: "cto@initech.example" }] }));
    expect(await sync()).toMatchObject({ booked: 1, unmatched: 1 });
    expect(await eventOf("ev4")).toMatchObject({ state: "unmatched" });
    expect(await meetingOf("ev5")).toMatchObject({ contact_id: bob, attribution: "domain_contacted" });
  });

  it("never matches by domain for personal mail, and not for a contact written to over 60 days ago", async () => {
    const old = await seedContact(db, { first: "Old", email: "old@hooli.example" });
    await seedFirstTouch(db, { campaignId: "cb2", contactId: old, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 70 * DAY) });
    calendar.events.push(calendarEvent({ id: "ev6", start: inDays(2), attendees: [{ email: "someone@gmail.com" }] }));
    calendar.events.push(calendarEvent({ id: "ev7", start: inDays(2), attendees: [{ email: "vp@hooli.example" }] }));
    expect(await sync()).toMatchObject({ booked: 0, unmatched: 2 });
  });

  it("two candidates make it ambiguous: one notice with the link command, then nothing until linked", async () => {
    for (const email of ["bob@initech.example", "eve@initech.example"]) {
      const id = await seedContact(db, { first: email.slice(0, 3), email });
      await seedFirstTouch(db, { campaignId: "cb3", contactId: id, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 5 * DAY), sendId: `os_${id}` });
    }
    calendar.events.push(calendarEvent({ id: "ev8", start: inDays(2), attendees: [{ email: "cto@initech.example" }] }));
    expect(await sync()).toMatchObject({ ambiguous: 1, booked: 0 });
    const code = await meetingCode("ev8");
    expect(await meetingOf("ev8")).toBeNull();
    expect(await eventOf("ev8")).toMatchObject({ state: "ambiguous" });
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain(`meeting-link-${code} <contact id>`);
    expect(operator.messages[0]?.text).toContain("Outside attendees at: initech.example");
    expect(operator.messages[0]?.text).not.toContain("cto@initech.example");
    expect(operator.messages[0]?.text).toContain("bob@initech.example");
    await sync(new Date(NOW.getTime() + 15 * 60_000));
    expect(operator.messages).toHaveLength(1);
    // Outreach is untouched while it is ambiguous.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM campaign_contacts WHERE sequence_active = 1").first()).toEqual({ n: 2 });
  });

  it("attributes an unmatched booking later, keeping when it was first seen", async () => {
    calendar.events.push(calendarEvent({ id: "ev9", start: inDays(5), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "max@umbrella.example", response: "accepted" }] }));
    await sync();
    expect(await eventOf("ev9")).toMatchObject({ state: "unmatched" });
    const max = await seedContact(db, { first: "Max", email: "max@umbrella.example" });
    await sync(new Date(NOW.getTime() + DAY));
    expect(await meetingOf("ev9")).toMatchObject({ contact_id: max, attribution: "accepted_contact", first_seen_at: NOW.toISOString() });
  });
});

describe("review cases", () => {
  it("an organizer at the company domain is not the operator: that field can be forged", async () => {
    await seedContact(db, { first: "Ada", email: "ada@northwind.example" });
    calendar.events.push(calendarEvent({ id: "evforge", start: inDays(2), organizedByOperator: false, operatorResponse: "accepted", organizer: "ceo@acme.example", attendees: [{ email: "ada@northwind.example" }] }));
    expect(await sync()).toMatchObject({ booked: 0, handled: 0 });
  });

  it("the domain rule looks back from when the booking was first seen, not from now", async () => {
    calendar.events.push(calendarEvent({ id: "evlate", start: inDays(5), attendees: [{ email: "stranger@initech.example" }] }));
    await sync();
    expect(await eventOf("evlate")).toMatchObject({ state: "unmatched" });
    const bob = await seedContact(db, { first: "Bob", email: "bob@initech.example" });
    await seedFirstTouch(db, { campaignId: "cb9", contactId: bob, provider: "fake-esp", sentAt: new Date(NOW.getTime() + 3_600_000) });
    await sync(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(await eventOf("evlate")).toMatchObject({ state: "unmatched" });
    expect(await meetingOf("evlate")).toBeNull();
  });

  it("a recurring series counts as one booking: its first instance", async () => {
    const jane = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    for (let week = 0; week < 4; week++) {
      calendar.events.push(calendarEvent({ id: `evweekly_${week}`, seriesId: "evweekly", start: inDays(1 + 7 * week), attendees: [{ email: "jane@globex.example", response: "accepted" }] }));
    }
    expect(await sync()).toMatchObject({ booked: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM calendar_meetings").first()).toEqual({ n: 1 });
    expect(await meetingOf("evweekly_0")).toMatchObject({ contact_id: jane });
    expect(operator.messages.filter((m) => m.text.includes("Meeting booked"))).toHaveLength(1);
    calendar.events.push(calendarEvent({ id: "evweekly_4", seriesId: "evweekly", start: inDays(29), attendees: [{ email: "jane@globex.example", response: "accepted" }] }));
    expect(await sync(new Date(NOW.getTime() + 7 * DAY))).toMatchObject({ booked: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM calendar_events").first()).toEqual({ n: 1 });
  });

  it("a forged acceptance on an invite from outside does nothing until the operator accepts it", async () => {
    const jane = await seedContact(db, { first: "Jane", email: "jane@prospect.example" });
    const forged = (response: "needsAction" | "accepted") =>
      calendarEvent({ id: "evforged", start: inDays(2), organizedByOperator: false, organizer: "mallory@evil.example", operatorResponse: response, attendees: [{ email: "jane@prospect.example", response: "accepted" }] });
    calendar.events = [forged("needsAction")];
    expect(await sync()).toMatchObject({ handled: 0, booked: 0 });
    expect(await eventOf("evforged")).toBeNull();
    expect(await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(jane).first()).toEqual({ warmth: "cold" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deals").first()).toEqual({ n: 0 });
    calendar.events = [forged("accepted")];
    expect(await sync()).toMatchObject({ booked: 1 });
    expect(await meetingOf("evforged")).toMatchObject({ contact_id: jane, attribution: "accepted_contact" });
  });

  it("a cancelled first instance lets a later live instance become the series' booking", async () => {
    const jane = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    const instance = (week: number, status: "confirmed" | "cancelled" = "confirmed") =>
      calendarEvent({ id: `evser_${week}`, seriesId: "evser", status, start: inDays(1 + 7 * week), attendees: [{ email: "jane@globex.example", response: "accepted" }] });
    calendar.events = [instance(0), instance(1), instance(2)];
    expect(await sync()).toMatchObject({ booked: 1 });
    calendar.events = [{ ...instance(0, "cancelled"), start: null, end: null }, instance(1), instance(2)];
    expect(await sync(new Date(NOW.getTime() + 3_600_000))).toMatchObject({ cancelled: 1, booked: 1 });
    expect(await meetingOf("evser_1")).toMatchObject({ contact_id: jane, status: "confirmed" });
    expect(await meetingOf("evser_2")).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM calendar_meetings WHERE status <> 'cancelled'").first()).toEqual({ n: 1 });
  });

  it("instances of a series that stay unmatched are each considered, so a later one can be booked once someone matches", async () => {
    const instance = (week: number) =>
      calendarEvent({ id: `evun_${week}`, seriesId: "evun", start: inDays(1 + 7 * week), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "max@umbrella.example", response: "accepted" }] });
    calendar.events = [instance(0), instance(1)];
    expect(await sync()).toMatchObject({ unmatched: 2, booked: 0 });
    // The first instance ends and, 3 days later, is forgotten; Max has become a contact meanwhile.
    const max = await seedContact(db, { first: "Max", email: "max@umbrella.example" });
    calendar.events = [instance(1)];
    const later = new Date(NOW.getTime() + 5 * DAY);
    expect(await sync(later)).toMatchObject({ booked: 1 });
    expect(await eventOf("evun_0")).toBeNull();
    expect(await meetingOf("evun_1")).toMatchObject({ contact_id: max, first_seen_at: NOW.toISOString() });
  });

  it("a change of answer to maybe does not cancel a booked meeting", async () => {
    await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    calendar.events = [calendarEvent({ id: "evmaybe", start: inDays(3), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane@globex.example", response: "accepted" }] })];
    await sync();
    calendar.events = [calendarEvent({ id: "evmaybe", start: inDays(3), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane@globex.example", response: "tentative" }] })];
    expect(await sync()).toMatchObject({ cancelled: 0 });
    expect(await meetingOf("evmaybe")).toMatchObject({ status: "confirmed" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM drafts").first()).toEqual({ n: 0 });
  });

  it("a booking stops outreach to every attributed contact and their accounts", async () => {
    const jane = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    const kim = await seedContact(db, { first: "Kim", email: "kim@initech.example" });
    await db.prepare("INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status) VALUES ('dr_cold_kim', ?1, 'cold_intro', 'kim@initech.example', 's', 'b', 'pending_approval')").bind(kim).run();
    calendar.events.push(calendarEvent({ id: "evtwo", start: inDays(2), attendees: [{ email: "jane@globex.example", response: "accepted" }, { email: "kim@initech.example" }] }));
    await sync();
    expect(await meetingOf("evtwo")).toMatchObject({ contact_id: jane });
    expect(await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(kim).first()).toEqual({ warmth: "hot" });
    expect(await db.prepare("SELECT status FROM drafts WHERE id = 'dr_cold_kim'").first()).toEqual({ status: "rejected" });
    const { loadAccountState } = await import("../src/outreach/select.ts");
    const live = (await loadAccountState(db, NOW)).live;
    expect(live.has("globex.example") && live.has("initech.example")).toBe(true);
  });
});

describe("what is stored", () => {
  it("keeps attendee hashes and domains, never an address or a title", async () => {
    await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    const event = { ...calendarEvent({ id: "ev10", start: inDays(1), attendees: [{ email: "jane@globex.example", response: "accepted" }, { email: "kim+x@globex.example" }] }), summary: "Secret pricing call", description: "agenda" };
    calendar.events.push(event);
    await sync();
    const row = await eventOf("ev10");
    expect(JSON.parse(String(row?.attendee_hashes))).toEqual(expect.arrayContaining([await addressHash("jane@globex.example"), await addressHash("kim+x@globex.example"), await addressHash("kim@globex.example")]));
    expect(JSON.parse(String(row?.attendee_domains))).toEqual(["globex.example"]);
    for (const table of ["calendar_events", "calendar_meetings", "deal_handoffs"]) {
      const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
      const text = JSON.stringify(results);
      expect(text, table).not.toContain("Secret pricing call");
      expect(text, table).not.toContain("kim+x@globex.example");
      if (table !== "deal_handoffs") expect(text, table).not.toContain("jane@globex.example");
    }
    expect(operator.texts().join("\n")).not.toContain("Secret pricing call");
  });

  it("reads 3 days back to 60 days ahead, and fails the run when the calendar cannot be read", async () => {
    await sync();
    expect(calendar.windows[0]).toEqual(syncWindow(NOW));
    expect(calendar.windows[0]).toEqual({ start: "2026-11-06T12:00:00.000Z", end: "2027-01-08T12:00:00.000Z" });
    calendar.failWith = new AdapterError("event list failed with HTTP 403 (forbidden)", "auth", false);
    await expect(sync()).rejects.toThrow(/403/);
  });

  it("handles at most maxRows events per run, in start order", async () => {
    for (let i = 0; i < 3; i++) calendar.events.push(calendarEvent({ id: `evr${i}`, start: inDays(3 - i), attendees: [{ email: `p${i}@umbrella.example`, response: "accepted" }] }));
    const result = await sync(NOW, { maxRows: 2 });
    expect(result).toMatchObject({ listed: 3, handled: 2, truncated: true });
    expect(await eventOf("evr0")).toBeNull();
  });

  it("forgets unmatched events once they ended 3 days ago", async () => {
    calendar.events.push(calendarEvent({ id: "evold", start: inDays(1), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "max@umbrella.example", response: "accepted" }] }));
    await sync();
    calendar.events = [];
    await sync(new Date(NOW.getTime() + 5 * DAY));
    expect(await eventOf("evold")).toBeNull();
  });
});

describe("moves, cancellations and declines", () => {
  async function booked(id = "evm", start = inDays(3)) {
    const jane = await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    await seedFirstTouch(db, { campaignId: "cb4", contactId: jane, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 4 * DAY) });
    calendar.events = [calendarEvent({ id, start, attendees: [{ email: "jane@globex.example", response: "accepted" }] })];
    await sync();
    operator.messages.length = 0;
    return jane;
  }

  it("a moved meeting resets its reminders and tells the operator once", async () => {
    await booked();
    await db.prepare("UPDATE calendar_meetings SET reminded_24h_at = ?1 WHERE event_id = 'evm'").bind(NOW.toISOString()).run();
    calendar.events = [calendarEvent({ id: "evm", start: inDays(4), attendees: [{ email: "jane@globex.example", response: "accepted" }] })];
    expect(await sync()).toMatchObject({ moved: 1 });
    expect(await meetingOf("evm")).toMatchObject({ starts_at: inDays(4), reminded_24h_at: null, status: "confirmed" });
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain("moved to 2026-11-13 12:00 UTC");
    await sync();
    expect(operator.messages).toHaveLength(1);
  });

  it("a cancelled meeting stops counting, withdraws its credit and drafts a rebook for approval", async () => {
    const jane = await booked();
    expect(await db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(jane).first()).toEqual({ positive_reply_at: NOW.toISOString() });
    calendar.events = [{ id: "evm", status: "cancelled", start: null, end: null, allDay: false, seriesId: null, organizer: null, attendees: [] }];
    const later = new Date(NOW.getTime() + DAY);
    expect(await sync(later)).toMatchObject({ cancelled: 1 });
    expect(await meetingOf("evm")).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    expect(await db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(jane).first()).toEqual({ positive_reply_at: null });
    const draft = await db.prepare("SELECT kind, status, action_class, recipient_email, body FROM drafts").first<Record<string, string>>();
    expect(draft).toMatchObject({ kind: "check_in", status: "pending_approval", action_class: "rebook", recipient_email: "jane@globex.example" });
    expect(draft?.body).toContain("was cancelled");
    expect(operator.approvals).toHaveLength(1);
    expect(operator.messages.at(-1)?.text).toContain("was cancelled. A rebook draft is waiting for your approval.");
    // Nothing more on the next run.
    await sync(new Date(later.getTime() + 15 * 60_000));
    expect(operator.messages.filter((m) => m.text.includes("cancelled"))).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM drafts").first()).toEqual({ n: 1 });
  });

  it("an outside person who declines after accepting cancels it too", async () => {
    await booked();
    calendar.events = [calendarEvent({ id: "evm", start: inDays(3), organizedByOperator: false, operatorResponse: "accepted", attendees: [{ email: "jane@globex.example", response: "declined" }] })];
    expect(await sync()).toMatchObject({ cancelled: 1 });
    expect(operator.messages.at(-1)?.text).toContain("was declined");
  });

  it("the contact it is attributed to by address leaving the invite cancels it, even if someone else accepted", async () => {
    await booked();
    calendar.events = [calendarEvent({ id: "evm", start: inDays(3), attendees: [{ email: "kim@globex.example", response: "accepted" }] })];
    expect(await sync()).toMatchObject({ cancelled: 1 });
    expect(await meetingOf("evm")).toMatchObject({ status: "cancelled" });
    expect(operator.messages.at(-1)?.text).toContain("was declined");
  });

  it("leaves a meeting removed after it ended as it was", async () => {
    await booked("evp", inDays(-1));
    calendar.events = [{ id: "evp", status: "cancelled", start: null, end: null, allDay: false, seriesId: null, organizer: null, attendees: [] }];
    expect(await sync()).toMatchObject({ cancelled: 0 });
    expect(await meetingOf("evp")).toMatchObject({ status: "confirmed" });
  });

  it("leaves an inert meeting alone", async () => {
    await booked();
    await db.batch([db.prepare("UPDATE calendar_events SET state = 'inert' WHERE event_id = 'evm'"), db.prepare("DELETE FROM calendar_meetings WHERE event_id = 'evm'")]);
    calendar.events = [calendarEvent({ id: "evm", start: inDays(5), attendees: [{ email: "jane@globex.example", response: "accepted" }] })];
    expect(await sync()).toMatchObject({ booked: 0, moved: 0 });
    expect(await meetingOf("evm")).toBeNull();
    expect(operator.messages).toHaveLength(0);
  });
});
