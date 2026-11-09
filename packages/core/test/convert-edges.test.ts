// GTM-agents: calendar sync's edge cases: a meeting that drops out of the listing is never reminded
// on its stale time, a move withdraws drafts that name the old day and drafts them again, the
// first sync after calendar sync is turned on does not count meetings that had already started as
// new bookings, and a credit withdrawal that failed is retried. Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { withdrawPendingKey } from "../src/convert/booked.ts";
import { runConvertCommand } from "../src/convert/commands.ts";
import { runMeetingFollowups, staleTime } from "../src/convert/followups.ts";
import { meetingCode } from "../src/convert/state.ts";
import { baselineAt, runCalendarSync, type SyncDeps } from "../src/convert/sync.ts";
import { calendarEvent, fakeCalendar, resetConvertTables, type FakeCalendar } from "../src/convert/testing.ts";
import { countMeetings } from "../src/metrics/meetings.ts";
import { flagReader, seedContact, silentLogger } from "../src/outreach/testing.ts";
import { seedFirstTouch } from "../src/sequences/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["4249001"], allowedUserIds: ["4249001"] } });
const at = (ms: number) => new Date(NOW.getTime() + ms);
const iso = (ms: number) => at(ms).toISOString();

let calendar: FakeCalendar;
let operator: ReturnType<typeof recordingOperator>;
const sync = (now = NOW, extra: Partial<SyncDeps> = {}) =>
  runCalendarSync({ db, calendar, config, operator: operator.channel, shown: memoryKv(), chatId: "4249001", now, log: silentLogger, maxRows: 100, ...extra });
const followups = (now: Date) =>
  runMeetingFollowups({ db, config, flags: flagReader({ "convert:calendar_enabled": "true" }), operator: operator.channel, shown: memoryKv(), chatId: "4249001", now, log: silentLogger, maxRows: 50 });
const janeEvent = (id: string, start: Date) => calendarEvent({ id, start: start.toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] });
const recap = (code: string) => db.prepare("SELECT status, body FROM drafts WHERE idempotency_key = ?1").bind(`convert:${code}:recap`).first<{ status: string; body: string }>();
const positiveAt = (contactId: string) => db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(contactId).first<{ positive_reply_at: string | null }>().then((r) => r?.positive_reply_at ?? null);

/** A D1 database whose statements matching `pattern` fail while `broken.on` is true. */
function flaky(pattern: string) {
  const broken = { on: true };
  const proxy = {
    prepare: (sql: string) => {
      if (broken.on && sql.includes(pattern)) throw new Error("D1_ERROR: database unavailable");
      return db.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  } as unknown as D1Database;
  return { db: proxy, broken };
}

let jane: string;

beforeEach(async () => {
  await resetConvertTables(db);
  calendar = fakeCalendar();
  operator = recordingOperator();
  jane = await seedContact(db, { first: "Jane", last: "Doe", email: "jane@globex.example", accountName: "Globex Corporation" });
});

describe("a meeting that drops out of the listing", () => {
  it("is not reminded on its stale time, the operator is told once, and reminders resume when it is listed again", async () => {
    const start = at(20 * HOUR);
    calendar.events = [janeEvent("evgone", start)];
    await sync();
    const code = await meetingCode("evgone");
    // Moved beyond 60 days, or deleted without a cancelled marker: the listing no longer has it.
    calendar.events = [];
    const later = at(15 * 60_000);
    expect(await sync(later)).toMatchObject({ missing: 1 });
    await sync(at(30 * 60_000));
    const missingNotices = operator.messages.filter((m) => m.text.includes("no longer in the calendar"));
    expect(missingNotices).toHaveLength(1);
    expect(missingNotices[0]?.text).toContain(`meeting-unlink-${code}`);
    operator.messages.length = 0;
    // 24 hours before the stored start: no reminder on a time the calendar no longer confirms.
    const result = await followups(at(31 * 60_000));
    expect(result).toMatchObject({ stale: 1, reminders: 0 });
    expect(operator.messages).toHaveLength(0);
    // Listed again: the reminder goes out.
    calendar.events = [janeEvent("evgone", start)];
    await sync(at(45 * 60_000));
    expect(await followups(at(46 * 60_000))).toMatchObject({ stale: 0, reminders: 1 });
  });

  it("judges staleness against the last listing that still covered the meeting, and keeps it stale until it is listed again", () => {
    const synced = NOW.toISOString();
    expect(staleTime({ ends_at: iso(DAY), last_seen_at: synced, last_synced_at: synced })).toBe(false);
    expect(staleTime({ ends_at: iso(DAY), last_seen_at: iso(-HOUR), last_synced_at: synced })).toBe(true);
    // Ended 4 days ago: listings stopped covering it about a day ago. Seen by the last of them, it is fine...
    expect(staleTime({ ends_at: iso(-4 * DAY), last_seen_at: iso(-DAY), last_synced_at: synced })).toBe(false);
    // ...but one that dropped out before then stays stale after the window has passed it.
    expect(staleTime({ ends_at: iso(-4 * DAY), last_seen_at: iso(-5 * DAY), last_synced_at: synced })).toBe(true);
    expect(staleTime({ ends_at: iso(DAY), last_seen_at: iso(-HOUR), last_synced_at: null })).toBe(false);
  });

  it("never asks whether a deleted meeting was held, even once its old time has left the sync window", async () => {
    calendar.events = [janeEvent("evdeleted", at(20 * HOUR))];
    await sync();
    calendar.events = [];
    await sync(at(HOUR));
    operator.messages.length = 0;
    // Four days after its old end, still syncing every so often: no held question.
    const later = at(5 * DAY);
    await sync(later);
    expect(await followups(new Date(later.getTime() + 60_000))).toMatchObject({ stale: 1, asked: 0 });
    expect(operator.messages.filter((m) => m.text.includes("take place"))).toHaveLength(0);
  });
});

describe("a moved meeting's drafts", () => {
  /** A meeting that ended two hours ago, asked about, and recapped 24 hours later without an answer. */
  async function recapped() {
    calendar.events = [janeEvent("evmove", at(-2 * HOUR))];
    await sync();
    const code = await meetingCode("evmove");
    await followups(NOW);
    await sync(at(25 * HOUR));
    await followups(at(25 * HOUR + 60_000));
    expect(await recap(code)).toMatchObject({ status: "pending_approval" });
    expect((await recap(code))?.body).toContain("Monday 9 November");
    return code;
  }

  it("a recap waiting for approval is withdrawn and drafted again with the new day when the meeting moved to another past time", async () => {
    const code = await recapped();
    calendar.events = [janeEvent("evmove", at(-DAY - 2 * HOUR))];
    expect(await sync(at(26 * HOUR))).toMatchObject({ moved: 1 });
    const again = await recap(code);
    expect(again?.status).toBe("pending_approval");
    expect(again?.body).toContain("Sunday 8 November");
    expect(again?.body).not.toContain("Monday 9 November");
    expect(operator.messages.at(-1)?.text).toContain("withdrawn and will be drafted again for the new time");
  });

  it("a recap is withdrawn when the meeting moved to a later day, and drafted again after the new meeting", async () => {
    const code = await recapped();
    calendar.events = [janeEvent("evmove", at(3 * DAY))];
    await sync(at(26 * HOUR));
    expect(await recap(code)).toMatchObject({ status: "rejected" });
    expect(await db.prepare("SELECT sequence_step, held_asked_at, outcome FROM calendar_meetings WHERE event_id = 'evmove'").first()).toEqual({ sequence_step: null, held_asked_at: null, outcome: null });
  });

  it("a move within the same day leaves the drafts alone", async () => {
    const code = await recapped();
    calendar.events = [janeEvent("evmove", at(-3 * HOUR))];
    expect(await sync(at(26 * HOUR))).toMatchObject({ moved: 1 });
    expect(await recap(code)).toMatchObject({ status: "pending_approval" });
  });

  it("an approved recap was sent from the mail client already, so a move leaves it as it is", async () => {
    const code = await recapped();
    await db.prepare("UPDATE drafts SET status = 'approved', approved_digest = ?2 WHERE idempotency_key = ?1").bind(`convert:${code}:recap`, "b".repeat(64)).run();
    calendar.events = [janeEvent("evmove", at(-DAY - 2 * HOUR))];
    await sync(at(26 * HOUR));
    expect(await recap(code)).toMatchObject({ status: "approved" });
  });
});

describe("the first sync after calendar sync is turned on", () => {
  it("does not count meetings that had already started as new bookings, but counts later ones", async () => {
    await seedFirstTouch(db, { campaignId: "cb", contactId: jane, provider: "fake-esp", sentAt: at(-20 * DAY) });
    const sam = await seedContact(db, { first: "Sam", email: "sam@initech.example" });
    calendar.events = [
      janeEvent("evpast", at(-DAY)),
      calendarEvent({ id: "evsoon", start: at(DAY).toISOString(), attendees: [{ email: "sam@initech.example", response: "accepted" }] }),
    ];
    expect(await sync()).toMatchObject({ booked: 2 });
    const flags = await db.prepare("SELECT event_id, before_baseline FROM calendar_meetings ORDER BY event_id").all();
    expect(flags.results).toEqual([
      { event_id: "evpast", before_baseline: 1 },
      { event_id: "evsoon", before_baseline: 0 },
    ]);
    const week = { from: iso(-7 * DAY), to: iso(DAY) };
    expect(await countMeetings(db, week)).toMatchObject({ booked: 1 });
    // It still stops outreach, but credits no positive reply: its first sighting is not a booking time.
    expect(await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(jane).first()).toEqual({ warmth: "hot" });
    expect(await positiveAt(jane)).toBeNull();
    expect(sam).toBeTruthy();

    // A meeting first seen later that had started after the baseline (logged after the fact) counts.
    await seedContact(db, { first: "Lena", email: "lena@umbrella.example" });
    calendar.events.push(calendarEvent({ id: "evlogged", start: at(5 * 60_000).toISOString(), attendees: [{ email: "lena@umbrella.example", response: "accepted" }] }));
    await sync(at(15 * 60_000));
    expect(await db.prepare("SELECT before_baseline FROM calendar_meetings WHERE event_id = 'evlogged'").first()).toEqual({ before_baseline: 0 });
  });

  it("sets the baseline once, on the first sync, and keeps it through a gap in syncing", () => {
    const state = { baseline_at: iso(-DAY), last_synced_at: iso(-15 * 60_000) };
    expect(baselineAt(null, NOW)).toBe(NOW.toISOString());
    expect(baselineAt(state, NOW)).toBe(iso(-DAY));
    expect(baselineAt({ ...state, last_synced_at: iso(-3 * DAY) }, NOW)).toBe(iso(-DAY));
  });

  it("a meeting from before the baseline that the operator links credits no send", async () => {
    await seedFirstTouch(db, { campaignId: "cb", contactId: jane, provider: "fake-esp", sentAt: at(-20 * DAY) });
    // Nobody on the invite is a contact, so the first sync keeps it unmatched; then it is linked by hand.
    calendar.events = [calendarEvent({ id: "evlinkpast", start: at(-DAY).toISOString(), attendees: [{ email: "someone@hooli.example", response: "accepted" }] })];
    await sync();
    const code = await meetingCode("evlinkpast");
    const reply = await runConvertCommand(
      { db, flags: flagReader({ "convert:calendar_enabled": "true" }), config, operator: operator.channel, shown: memoryKv(), chatId: "4249001", userId: "4249001", now: () => at(HOUR), log: silentLogger },
      { kind: "link", code, contact: jane },
    );
    expect(reply).toContain("Linked meeting");
    expect(await db.prepare("SELECT before_baseline FROM calendar_meetings WHERE event_id = 'evlinkpast'").first()).toEqual({ before_baseline: 1 });
    expect(await positiveAt(jane)).toBeNull();
  });
});

describe("a booked meeting's credit", () => {
  it("is withdrawn on a later sync when the withdrawal failed, and the retry record is cleared", async () => {
    await seedFirstTouch(db, { campaignId: "cb", contactId: jane, provider: "fake-esp", sentAt: at(-4 * DAY) });
    calendar.events = [janeEvent("evcredit", at(3 * DAY))];
    await sync();
    const code = await meetingCode("evcredit");
    expect(await positiveAt(jane)).toBe(NOW.toISOString());
    // The cancellation lands, but taking the credit back fails.
    const { db: broken } = flaky("UPDATE outreach_sends SET positive_reply_at = ?3");
    calendar.events = [{ id: "evcredit", status: "cancelled", start: null, end: null, allDay: false, seriesId: null, organizer: null, attendees: [] }];
    expect(await sync(at(HOUR), { db: broken })).toMatchObject({ cancelled: 1 });
    expect(await positiveAt(jane)).toBe(NOW.toISOString());
    expect(await db.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE event_id = ?1").bind(withdrawPendingKey(code, jane)).first()).toEqual({ n: 1 });
    // The next sync retries it.
    await sync(at(HOUR + 15 * 60_000));
    expect(await positiveAt(jane)).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE event_id = ?1").bind(withdrawPendingKey(code, jane)).first()).toEqual({ n: 0 });
  });

  it("is kept when the meeting counts again before the retry", async () => {
    await seedFirstTouch(db, { campaignId: "cb", contactId: jane, provider: "fake-esp", sentAt: at(-4 * DAY) });
    calendar.events = [janeEvent("evback", at(3 * DAY))];
    await sync();
    const code = await meetingCode("evback");
    const { db: broken } = flaky("UPDATE outreach_sends SET positive_reply_at = ?3");
    calendar.events = [{ id: "evback", status: "cancelled", start: null, end: null, allDay: false, seriesId: null, organizer: null, attendees: [] }];
    await sync(at(HOUR), { db: broken });
    // Restored before the next sync: it counts again, so its credit stays.
    calendar.events = [janeEvent("evback", at(3 * DAY))];
    await sync(at(HOUR + 15 * 60_000));
    expect(await positiveAt(jane)).toBe(NOW.toISOString());
    expect(await db.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE event_id = ?1").bind(withdrawPendingKey(code, jane)).first()).toEqual({ n: 0 });
  });
});
