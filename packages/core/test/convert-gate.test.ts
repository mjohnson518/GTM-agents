// GTM-agents: the convert milestone's gate: a booked meeting stops outreach and creates a prep brief.
//
// One calendar sync sees a meeting the operator organized and a contact accepted. It must stop the
// contact's and the account's cold sequences and queued sends, make the account count as in a
// conversation for the cold batch, move warmth and the deal forward, credit the meeting to the first
// touch, write the prep brief and tell the operator, all once, and send nothing to anyone else.
// Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { runCalendarSync } from "../src/convert/sync.ts";
import { calendarEvent, fakeCalendar, resetConvertTables } from "../src/convert/testing.ts";
import { countMeetings, countReplies } from "../src/metrics/index.ts";
import { loadAccountState, selectCandidates } from "../src/outreach/select.ts";
import { seedContact, silentLogger } from "../src/outreach/testing.ts";
import { seedFirstTouch } from "../src/sequences/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 86_400_000;
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["4249001"], allowedUserIds: ["4249001"] } });

async function seedAccount() {
  const jane = await seedContact(db, { first: "Jane", last: "Doe", email: "jane@globex.example", accountName: "Globex Corporation", title: "VP Engineering" });
  const sam = await seedContact(db, { first: "Sam", email: "sam@globex.example", accountName: "Globex Corporation" });
  const lee = await seedContact(db, { first: "Lee", email: "lee@globex.example", accountName: "Globex Corporation" });
  await db.prepare("INSERT INTO templates (id, kind, status, step, body_sha256) VALUES ('cold-intro', 'cold_intro', 'approved', 1, ?1)").bind("a".repeat(64)).run();
  await seedFirstTouch(db, { campaignId: "cb20261028", contactId: jane, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 10 * DAY) });
  await seedFirstTouch(db, { campaignId: "cb20261028", contactId: sam, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 9 * DAY), sendId: "os_sam_1" });
  await db
    .prepare(
      `INSERT INTO deferred_sends (id, contact_id, campaign_id, send_path, recipient_email, subject, body, defer_reason, next_attempt_at, status)
       VALUES ('ds-sam', ?1, 'cb20261028', 'sequence', 'sam@globex.example', 'Re: Flaky builds', 'A follow-up.', 'window', ?2, 'queued')`,
    )
    .bind(sam, new Date(NOW.getTime() + 3_600_000).toISOString())
    .run();
  return { jane, sam, lee };
}

describe("the convert gate", () => {
  beforeEach(async () => {
    await resetConvertTables(db);
  });

  it("a booked meeting stops outreach to the account and creates a prep brief, once", async () => {
    const { jane, sam, lee } = await seedAccount();
    expect((await loadAccountState(db, NOW)).live.has("globex.example")).toBe(false);
    expect((await selectCandidates(db, { limit: 10, offset: 0, floor: "medium", now: NOW })).map((r) => r.id)).toContain(lee);

    const calendar = fakeCalendar([
      calendarEvent({ id: "evgate1", start: new Date(NOW.getTime() + 2 * DAY).toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] }),
    ]);
    const operator = recordingOperator();
    const shown = memoryKv();
    const deps = { db, calendar, config, operator: operator.channel, shown, chatId: "4249001", now: NOW, log: silentLogger, maxRows: 100 };
    const first = await runCalendarSync(deps);
    expect(first).toMatchObject({ listed: 1, booked: 1, ambiguous: 0, failed: 0 });

    // The meeting is recorded and attributed, with no title anywhere.
    const meeting = await db.prepare("SELECT contact_id, attribution, status, first_seen_at FROM calendar_meetings WHERE event_id = 'evgate1'").first();
    expect(meeting).toEqual({ contact_id: jane, attribution: "accepted_contact", status: "confirmed", first_seen_at: NOW.toISOString() });

    // Outreach stops: the contact's and the colleague's sequences end as converted, the queued step is cancelled.
    const { results: rows } = await db.prepare("SELECT contact_id, status, sequence_active, next_send_at FROM campaign_contacts ORDER BY contact_id").all();
    expect(rows).toEqual(expect.arrayContaining([
      { contact_id: jane, status: "converted", sequence_active: 0, next_send_at: null },
      { contact_id: sam, status: "converted", sequence_active: 0, next_send_at: null },
    ]));
    expect(await db.prepare("SELECT status FROM deferred_sends WHERE id = 'ds-sam'").first()).toEqual({ status: "cancelled" });
    // The account is in a conversation, so the cold batch skips everyone there.
    expect((await loadAccountState(db, NOW)).live.has("globex.example")).toBe(true);
    expect(await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(jane).first()).toEqual({ warmth: "hot" });

    // The deal is created and stepped to demo_scheduled, with its history.
    const deal = await db.prepare("SELECT id, stage, contact_id, name FROM deals").first<{ id: string; stage: string; contact_id: string; name: string }>();
    expect(deal).toMatchObject({ stage: "demo_scheduled", contact_id: jane, name: "Globex Corporation" });
    expect(await db.prepare("SELECT from_stage, to_stage FROM deal_stage_history WHERE deal_id = ?1").bind(deal?.id).first()).toEqual({ from_stage: "prospecting", to_stage: "demo_scheduled" });

    // The meeting counts as positive for the first touch that earned it. No second counter is kept on the template.
    expect(await db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(jane).first()).toEqual({ positive_reply_at: NOW.toISOString() });
    expect(await db.prepare("SELECT times_meeting FROM templates WHERE id = 'cold-intro'").first()).toEqual({ times_meeting: 0 });
    const week = { from: new Date(NOW.getTime() - 7 * DAY).toISOString(), to: new Date(NOW.getTime() + DAY).toISOString() };
    expect(await countMeetings(db, week)).toEqual({ booked: 1, bookedAfterOutreach: 1, held: 0, heldAfterOutreach: 0, noShows: 0, cancelled: 0 });
    expect((await countReplies(db, week)).positiveReplies).toBe(1);

    // The prep brief is stored and sent to the operator with the booking notice.
    const brief = await db.prepare("SELECT trigger, brief_markdown, notified_at FROM deal_handoffs").first<{ trigger: string; brief_markdown: string; notified_at: string }>();
    expect(brief?.trigger).toMatch(/^meeting_booked:mg[0-9a-f]{10}$/);
    expect(brief?.brief_markdown).toContain("Prep brief: Jane Doe");
    expect(brief?.brief_markdown).toContain("Account: Globex Corporation");
    expect(brief?.notified_at).toBe(NOW.toISOString());
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain("Meeting booked with Jane Doe, 2026-11-11 12:00 UTC");
    expect(operator.messages[0]?.text).toContain("Prep brief: Jane Doe");

    // Nothing was sent or drafted for anyone, and nothing was asked for approval.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM outreach_sends").first()).toEqual({ n: 2 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM drafts").first()).toEqual({ n: 0 });
    expect(operator.approvals).toHaveLength(0);

    // A second sync repeats nothing.
    const second = await runCalendarSync(deps);
    expect(second).toMatchObject({ booked: 0, failed: 0 });
    expect(operator.messages).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deals").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deal_handoffs").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT times_meeting FROM templates WHERE id = 'cold-intro'").first()).toEqual({ times_meeting: 0 });
  });

  it("retries a booked step that failed, on the next sync", async () => {
    const { jane } = await seedAccount();
    const calendar = fakeCalendar([
      calendarEvent({ id: "evgate2", start: new Date(NOW.getTime() + DAY).toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] }),
    ]);
    const broken = recordingOperator();
    broken.channel.notify = () => Promise.reject(new Error("channel down"));
    await runCalendarSync({ db, calendar, config, operator: broken.channel, now: NOW, log: silentLogger, maxRows: 100 });
    // Everything but the notice happened; the notice is retried.
    expect(await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(jane).first()).toEqual({ warmth: "hot" });
    const operator = recordingOperator();
    await runCalendarSync({ db, calendar, config, operator: operator.channel, now: new Date(NOW.getTime() + 15 * 60_000), log: silentLogger, maxRows: 100 });
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain("Meeting booked with Jane Doe");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deal_handoffs").first()).toEqual({ n: 1 });
  });
});
