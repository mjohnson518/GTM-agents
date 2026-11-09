// GTM-agents: what follows a booked meeting: reminders at 24 hours and 1 hour, the held or no-show
// question, the recap drafted after 24 hours without an answer, the post-demo drafts and their stop
// rules, and the deal handoff brief. Nothing is sent to anyone but the operator. Every person,
// company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { runConvertCommand } from "../src/convert/commands.ts";
import { dueReminder, dueStep, runMeetingFollowups } from "../src/convert/followups.ts";
import { runDealHandoffs } from "../src/convert/handoff.ts";
import { meetingCode } from "../src/convert/state.ts";
import { runCalendarSync } from "../src/convert/sync.ts";
import { calendarEvent, fakeCalendar, resetConvertTables } from "../src/convert/testing.ts";
import { flagReader, seedContact, silentLogger } from "../src/outreach/testing.ts";
import { draftDigest } from "../src/security/approval-digest.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["4249001"], allowedUserIds: ["4249001"] } });
const at = (ms: number) => new Date(NOW.getTime() + ms);

let operator: ReturnType<typeof recordingOperator>;
let flags: ReturnType<typeof flagReader>;
let code: string;
let jane: string;

const followups = (now: Date) => runMeetingFollowups({ db, config, flags, operator: operator.channel, shown: memoryKv(), chatId: "4249001", now, log: silentLogger, maxRows: 50 });
const command = (text: Parameters<typeof runConvertCommand>[1], now: Date) =>
  runConvertCommand({ db, flags, config, operator: operator.channel, shown: memoryKv(), chatId: "4249001", userId: "4249001", now: () => now, log: silentLogger }, text);
const drafts = () => db.prepare("SELECT idempotency_key, kind, status, action_class, subject, body FROM drafts ORDER BY created_at, idempotency_key").all<Record<string, string>>().then((r) => r.results);

/** A meeting tomorrow at noon, 30 minutes, booked by Jane. */
async function bookMeeting(start = at(DAY)) {
  jane = await seedContact(db, { first: "Jane", last: "Doe", email: "jane@globex.example", accountName: "Globex Corporation", title: "VP Engineering" });
  const calendar = fakeCalendar([calendarEvent({ id: "evf", start: start.toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] })]);
  await runCalendarSync({ db, calendar, config, operator: operator.channel, now: NOW, log: silentLogger, maxRows: 10 });
  code = await meetingCode("evf");
  operator.messages.length = 0;
}

async function approve(kind: string) {
  const row = await db.prepare("SELECT id, recipient_email, subject, body FROM drafts WHERE idempotency_key = ?1").bind(`convert:${code}:${kind}`).first<{ id: string; recipient_email: string; subject: string; body: string }>();
  const digest = await draftDigest({ to: row?.recipient_email ?? null, subject: row?.subject ?? null, body: row?.body ?? null });
  await db.prepare("UPDATE drafts SET status = 'approved', approved_digest = ?2 WHERE id = ?1").bind(row?.id, digest).run();
}

beforeEach(async () => {
  await resetConvertTables(db);
  operator = recordingOperator();
  flags = flagReader({ "convert:calendar_enabled": "true" });
});

describe("reminders", () => {
  it("picks the 24-hour and the 1-hour reminder by time to start", () => {
    expect(dueReminder(at(30 * HOUR).toISOString(), NOW)).toBeNull();
    expect(dueReminder(at(20 * HOUR).toISOString(), NOW)).toBe("24h");
    expect(dueReminder(at(40 * 60_000).toISOString(), NOW)).toBe("1h");
    expect(dueReminder(at(-60_000).toISOString(), NOW)).toBeNull();
  });

  it("reminds once at 24 hours with the brief and once at 1 hour, and again after a move", async () => {
    await bookMeeting();
    await followups(at(HOUR));
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain(`Reminder: meeting with Jane Doe (VP Engineering) in about 24 hours, 2026-11-10 12:00 UTC [${code}]`);
    expect(operator.messages[0]?.text).toContain("Prep brief: Jane Doe");
    await followups(at(2 * HOUR));
    expect(operator.messages).toHaveLength(1);
    await followups(at(23 * HOUR + 30 * 60_000));
    expect(operator.messages).toHaveLength(2);
    expect(operator.messages[1]?.text).toContain("in about an hour");
    expect(operator.messages[1]?.text).toContain(`prep-${jane}`);
    await followups(at(23 * HOUR + 45 * 60_000));
    expect(operator.messages).toHaveLength(2);
    // Moved a day later: both reminders are due again for the new time.
    await db.prepare("UPDATE calendar_meetings SET starts_at = ?1, ends_at = ?2 WHERE event_id = 'evf'").bind(at(2 * DAY).toISOString(), at(2 * DAY + 30 * 60_000).toISOString()).run();
    await followups(at(DAY + HOUR));
    expect(operator.messages).toHaveLength(3);
    expect(operator.messages[2]?.text).toContain("in about 24 hours, 2026-11-11 12:00 UTC");
  });

  it("retries a reminder the channel failed to deliver", async () => {
    await bookMeeting();
    const broken = recordingOperator();
    broken.channel.notify = () => Promise.reject(new Error("down"));
    await runMeetingFollowups({ db, config, flags, operator: broken.channel, now: at(HOUR), log: silentLogger, maxRows: 50 });
    await followups(at(HOUR + 15 * 60_000));
    expect(operator.messages).toHaveLength(1);
  });
});

describe("after the meeting", () => {
  it("asks once whether it was held, then drafts the recap for review after 24 hours without an answer", async () => {
    await bookMeeting(at(-2 * HOUR));
    await followups(NOW);
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain(`meeting-held-${code} or meeting-noshow-${code}`);
    await followups(at(HOUR));
    expect(operator.messages).toHaveLength(1);
    expect(await drafts()).toHaveLength(0);
    await followups(at(25 * HOUR));
    const [recap] = await drafts();
    expect(recap).toMatchObject({ idempotency_key: `convert:${code}:recap`, kind: "recap", status: "pending_approval", action_class: "post_meeting_followup", subject: "Following up on our conversation" });
    expect(recap?.body).toContain("Hi Jane,");
    expect(recap?.body).toContain("https://acme.example/book");
    expect(recap?.body).not.toMatch(new RegExp("[\\u2013\\u2014]"));
    expect(operator.approvals).toHaveLength(1);
    expect(operator.messages.at(-1)?.text).toContain(`meeting-noshow-${code} withdraws it`);
    await followups(at(26 * HOUR));
    expect(await drafts()).toHaveLength(1);

    // A late no-show answer withdraws the recap and drafts a rebook.
    const reply = await command({ kind: "noshow", code }, at(27 * HOUR));
    expect(reply).toContain("The recap was withdrawn.");
    expect(reply).toContain("A rebook draft is waiting for your approval.");
    const all = await drafts();
    expect(all.find((d) => d.kind === "recap")?.status).toBe("rejected");
    expect(all.find((d) => d.action_class === "rebook")).toMatchObject({ status: "pending_approval", subject: "Finding another time" });
    expect(all.find((d) => d.action_class === "rebook")?.body).toContain("we missed each other");
  });

  it("says so when the meeting was matched by company domain", async () => {
    await bookMeeting(at(-2 * HOUR));
    await db.prepare("UPDATE calendar_meetings SET attribution = 'domain_contacted' WHERE event_id = 'evf'").run();
    await followups(NOW);
    expect(operator.messages[0]?.text).toContain(`matched by company domain, not by address: if it was someone else, meeting-unlink-${code} makes it inert`);
  });

  it("drafts no recap for a suppressed address", async () => {
    await bookMeeting(at(-2 * HOUR));
    await db.prepare("INSERT INTO suppression (email_sha256, email, reason, source, created_at) SELECT email_sha256, email, 'opt_out', 'test', ?2 FROM contacts WHERE id = ?1").bind(jane, NOW.toISOString()).run();
    expect(await command({ kind: "held", code }, NOW)).toContain("Their address is suppressed, so no recap draft was written.");
    expect(await drafts()).toHaveLength(0);
  });
});

describe("the post-demo follow-ups", () => {
  it("step 2 at day 4 once the recap is approved, step 3 at day 10 once step 2 is, each for approval", async () => {
    flags.values["convert:post_demo_enabled"] = "true";
    await bookMeeting(at(-HOUR));
    expect(await command({ kind: "held", code }, NOW)).toContain("A recap draft is waiting for your approval.");
    // Not approved yet: nothing at day 4.
    await followups(at(4 * DAY));
    expect((await drafts()).map((d) => d.idempotency_key)).toEqual([`convert:${code}:recap`]);
    await approve("recap");
    await followups(at(3 * DAY));
    expect(await drafts()).toHaveLength(1);
    await followups(at(4 * DAY));
    expect((await drafts()).map((d) => d.idempotency_key)).toEqual([`convert:${code}:recap`, `convert:${code}:step2`]);
    await followups(at(10 * DAY));
    expect(await drafts()).toHaveLength(2);
    await approve("step2");
    await followups(at(10 * DAY));
    const all = await drafts();
    expect(all.map((d) => d.idempotency_key)).toEqual([`convert:${code}:recap`, `convert:${code}:step2`, `convert:${code}:step3`]);
    expect(all.every((d) => d.status !== "sent")).toBe(true);
    expect(all.at(-1)).toMatchObject({ status: "pending_approval", subject: "Closing the loop" });
  });

  it("stops and withdraws open steps on mail from anyone at the account", async () => {
    flags.values["convert:post_demo_enabled"] = "true";
    await bookMeeting(at(-HOUR));
    await command({ kind: "held", code }, NOW);
    await approve("recap");
    await followups(at(4 * DAY));
    expect((await drafts()).find((d) => d.idempotency_key?.endsWith("step2"))?.status).toBe("pending_approval");
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification, account_key) VALUES ('in-1', 'fake', 'pm-1', 'kim@globex.example', ?1, 'reply', 'globex.example')")
      .bind(at(4 * DAY + HOUR).toISOString())
      .run();
    expect(await followups(at(4 * DAY + 2 * HOUR))).toMatchObject({ stopped: 1 });
    expect((await drafts()).find((d) => d.idempotency_key?.endsWith("step2"))?.status).toBe("rejected");
    await approve("step2").catch(() => undefined);
    await followups(at(10 * DAY));
    expect((await drafts()).some((d) => d.idempotency_key?.endsWith("step3"))).toBe(false);
  });

  it("stops on a newer meeting with the account, and never runs for a no-show or with the flag off", async () => {
    flags.values["convert:post_demo_enabled"] = "true";
    await bookMeeting(at(-HOUR));
    await command({ kind: "held", code }, NOW);
    await approve("recap");
    await db.prepare("INSERT INTO calendar_meetings (event_id, contact_id, starts_at, ends_at, status, attribution, first_seen_at) VALUES ('evnext', ?1, ?2, ?3, 'confirmed', 'accepted_contact', ?4)").bind(jane, at(6 * DAY).toISOString(), at(6 * DAY + HOUR).toISOString(), NOW.toISOString()).run();
    expect(await followups(at(4 * DAY))).toMatchObject({ stopped: 1, steps: 0 });

    expect(dueStep({ ends_at: NOW.toISOString(), sequence_step: 1 }, "pending_approval", null, at(5 * DAY))).toBeNull();
    expect(dueStep({ ends_at: NOW.toISOString(), sequence_step: 1 }, "approved", null, at(5 * DAY))).toBe(2);
    expect(dueStep({ ends_at: NOW.toISOString(), sequence_step: 2 }, "approved", "sent", at(9 * DAY))).toBeNull();
    expect(dueStep({ ends_at: NOW.toISOString(), sequence_step: 2 }, "approved", "sent", at(10 * DAY))).toBe(3);
  });

  it("stops once the contact signs up", async () => {
    flags.values["convert:post_demo_enabled"] = "true";
    await bookMeeting(at(-HOUR));
    await command({ kind: "held", code }, NOW);
    await approve("recap");
    // The booking already gave Jane a lifecycle row (engaged); the sign-up moves it.
    await db
      .prepare("INSERT INTO contact_lifecycle (contact_id, state, signed_up_at) VALUES (?1, 'signed_up', ?2) ON CONFLICT (contact_id) DO UPDATE SET state = excluded.state, signed_up_at = excluded.signed_up_at")
      .bind(jane, at(DAY).toISOString())
      .run();
    expect(await followups(at(4 * DAY))).toMatchObject({ stopped: 1, steps: 0 });
  });

  it("drafts nothing past the recap while convert:post_demo_enabled is off", async () => {
    await bookMeeting(at(-HOUR));
    await command({ kind: "held", code }, NOW);
    await approve("recap");
    await followups(at(4 * DAY));
    expect(await drafts()).toHaveLength(1);
  });
});

describe("the deal handoff brief", () => {
  it("is written and sent once when a deal reaches proposal, and retried when the channel fails", async () => {
    const id = await seedContact(db, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind" });
    await db.prepare("INSERT INTO deals (id, account_key, contact_id, name, stage, value_cents, currency) VALUES ('deal-1', 'northwind.example', ?1, 'Northwind', 'proposal', 480000, 'USD')").bind(id).run();
    await db.prepare("INSERT INTO deal_stage_history (id, deal_id, from_stage, to_stage) VALUES ('h1', 'deal-1', 'demo_scheduled', 'proposal')").run();
    const broken = recordingOperator();
    broken.channel.notify = () => Promise.reject(new Error("down"));
    expect(await runDealHandoffs({ db, operator: broken.channel, now: NOW, log: silentLogger, maxRows: 10 })).toMatchObject({ due: 1, written: 0, failed: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deal_handoffs").first()).toEqual({ n: 0 });
    expect(await runDealHandoffs({ db, operator: operator.channel, now: NOW, log: silentLogger, maxRows: 10 })).toMatchObject({ written: 1 });
    expect(operator.messages[0]?.text).toContain("Deal handoff: Northwind reached proposal");
    expect(operator.messages[0]?.text).toContain("Value: 4800 USD");
    expect(operator.messages[0]?.text).toContain("Pricing, offers and discounts stay with you");
    expect(await runDealHandoffs({ db, operator: operator.channel, now: NOW, log: silentLogger, maxRows: 10 })).toMatchObject({ due: 0 });
    // Negotiation is its own brief.
    await db.prepare("UPDATE deals SET stage = 'negotiation' WHERE id = 'deal-1'").run();
    expect(await runDealHandoffs({ db, operator: operator.channel, now: NOW, log: silentLogger, maxRows: 10 })).toMatchObject({ written: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM deal_handoffs").first()).toEqual({ n: 2 });
  });
});
