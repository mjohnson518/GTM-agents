// GTM-agents: the meeting commands: parsing, the flag, link and unlink, held, notes, the prep brief
// and the meeting list, routed by the chat consumer once per message and never to the model. Every
// person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { parseConvertCommand } from "../src/convert/commands.ts";
import { meetingCode } from "../src/convert/state.ts";
import { runCalendarSync } from "../src/convert/sync.ts";
import { calendarEvent, fakeCalendar, resetConvertTables } from "../src/convert/testing.ts";
import type { Env } from "../src/env.ts";
import { helpText } from "../src/operator/commands.ts";
import { processChatMessage, type OperatorAgentOptions } from "../src/operator/chat.ts";
import { seedContact, silentLogger } from "../src/outreach/testing.ts";
import { seedFirstTouch } from "../src/sequences/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 86_400_000;
const OPERATOR = "4249001";
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] } });

describe("parsing", () => {
  it("reads each command form, with or without a leading slash, and nothing else", () => {
    expect(parseConvertCommand("meeting-held-mg0123456789")).toEqual({ kind: "held", code: "mg0123456789" });
    expect(parseConvertCommand("/meeting-NOSHOW-MG0123456789")).toEqual({ kind: "noshow", code: "mg0123456789" });
    expect(parseConvertCommand("meeting-unlink-mg0123456789")).toEqual({ kind: "unlink", code: "mg0123456789" });
    expect(parseConvertCommand("meeting-link-mg0123456789 jane@globex.example")).toEqual({ kind: "link", code: "mg0123456789", contact: "jane@globex.example" });
    expect(parseConvertCommand("meeting-notes-mg0123456789 Wants SSO.\nBudget in Q1.")).toEqual({ kind: "notes", code: "mg0123456789", notes: "Wants SSO.\nBudget in Q1." });
    expect(parseConvertCommand("prep-ct_abc123")).toEqual({ kind: "prep", contact: "ct_abc123" });
    expect(parseConvertCommand("/meetings")).toEqual({ kind: "list" });
    for (const text of ["meeting-held-mg01234", "meeting-held-xx0123456789", "meeting-link-mg0123456789", "meeting-notes-mg0123456789", `meeting-notes-mg0123456789 ${"x".repeat(2001)}`, "please prep-me a brief", "meetings", "/meeting held"]) {
      expect(parseConvertCommand(text), text).toBeNull();
    }
  });

  it("lists the commands in /help", () => {
    const help = helpText("Avery");
    expect(help).toContain("meeting-held-<code> / meeting-noshow-<code>");
    expect(help).toContain("prep-<contact id or email>");
  });
});

describe("meeting commands in the operator chat", () => {
  let operator: ReturnType<typeof recordingOperator>;
  let options: OperatorAgentOptions;
  let chatEnv: Env;
  let updates = 0;
  let jane: string;
  let bob: string;

  const say = async (text: string, updateId = `u-cv-${(updates += 1)}`, now = NOW) => {
    await processChatMessage({ ...options, now: () => now }, chatEnv, { updateId, chatId: OPERATOR, userId: OPERATOR, sessionKey: `s-${OPERATOR}`, text });
    return operator.messages.at(-1)?.text ?? "";
  };

  beforeEach(async () => {
    await resetConvertTables(db);
    await env.KV.put("operator:agent_enabled", "true");
    await env.KV.put("convert:calendar_enabled", "true");
    await env.KV.delete("convert:post_demo_enabled");
    operator = recordingOperator();
    chatEnv = env as unknown as Env;
    options = {
      config,
      operator: () => operator.channel,
      model: () => {
        throw new Error("the model must never see a meeting command");
      },
      now: () => NOW,
    };
    jane = await seedContact(db, { first: "Jane", last: "Doe", email: "jane@globex.example", accountName: "Globex Corporation", title: "VP Engineering" });
    bob = await seedContact(db, { first: "Bob", email: "bob@globex.example", accountName: "Globex Corporation" });
    await seedFirstTouch(db, { campaignId: "cb1", contactId: jane, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 5 * DAY) });
    await seedFirstTouch(db, { campaignId: "cb1", contactId: bob, provider: "fake-esp", sentAt: new Date(NOW.getTime() - 5 * DAY), sendId: "os_bob" });
  });

  async function ambiguousMeeting(id = "evc", start = NOW.getTime() + DAY) {
    const calendar = fakeCalendar([calendarEvent({ id, start: new Date(start).toISOString(), attendees: [{ email: "cto@globex.example" }] })]);
    await runCalendarSync({ db, calendar, config, operator: operator.channel, now: NOW, log: silentLogger, maxRows: 10 });
    return meetingCode(id);
  }

  it("links an ambiguous booking to the contact the operator names, runs the booked effects and answers with the brief, once", async () => {
    const code = await ambiguousMeeting();
    expect(operator.messages.at(-1)?.text).toContain(`meeting-link-${code}`);
    const updateId = "u-link-1";
    const reply = await say(`meeting-link-${code} jane@globex.example`, updateId);
    expect(reply).toContain(`Linked meeting ${code} (2026-11-10 12:00 UTC) to Jane Doe.`);
    // Jane is at the attendee's company domain, so no warning that she is not on the invite.
    expect(reply).not.toContain("not on the invite");
    expect(reply).toContain("Prep brief: Jane Doe");
    expect(await db.prepare("SELECT contact_id, attribution, first_seen_at FROM calendar_meetings").first()).toEqual({ contact_id: jane, attribution: "operator_link", first_seen_at: NOW.toISOString() });
    expect(await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(jane).first()).toEqual({ warmth: "hot" });
    expect(await db.prepare("SELECT stage FROM deals").first()).toEqual({ stage: "demo_scheduled" });
    // A redelivered message is not run again.
    const before = operator.messages.length;
    await say(`meeting-link-${code} jane@globex.example`, updateId);
    expect(operator.messages).toHaveLength(before);
    // Linking again is refused until it is unlinked.
    expect(await say(`meeting-link-${code} ${bob}`)).toContain("already linked");
  });

  it("unlinks a meeting: inert, credit and drafts withdrawn, and calendar sync leaves it alone", async () => {
    // Calendar sync has been running for a day, so a meeting that started an hour ago is a real booking.
    await db.prepare("INSERT INTO calendar_sync_state (id, baseline_at, last_synced_at) VALUES ('calendar', ?1, ?1)").bind(new Date(NOW.getTime() - 86_400_000).toISOString()).run();
    const code = await ambiguousMeeting("evu", NOW.getTime() - 3_600_000);
    await say(`meeting-link-${code} ${jane}`);
    expect(await db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(jane).first()).toEqual({ positive_reply_at: NOW.toISOString() });
    await say(`meeting-held-${code}`);
    expect(await db.prepare("SELECT status FROM drafts").first()).toEqual({ status: "pending_approval" });
    const reply = await say(`meeting-unlink-${code}`);
    expect(reply).toContain(`Meeting ${code} is inert`);
    expect(reply).toContain("1 open draft was withdrawn");
    expect(await db.prepare("SELECT state FROM calendar_events").first()).toEqual({ state: "inert" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM calendar_meetings").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT status FROM drafts").first()).toEqual({ status: "rejected" });
    expect(await db.prepare("SELECT positive_reply_at FROM outreach_sends WHERE contact_id = ?1").bind(jane).first()).toEqual({ positive_reply_at: null });
    const calendar = fakeCalendar([calendarEvent({ id: "evu", start: new Date(NOW.getTime() - 3_600_000).toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] })]);
    await runCalendarSync({ db, calendar, config, operator: operator.channel, now: NOW, log: silentLogger, maxRows: 10 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM calendar_meetings").first()).toEqual({ n: 0 });
    expect(await say(`meeting-unlink-${code}`)).toContain("already inert");
  });

  it("keeps notes with the contact the meeting is linked to, across a relink", async () => {
    const code = await ambiguousMeeting();
    await say(`meeting-link-${code} ${jane}`);
    await say(`meeting-notes-${code} About Jane.`);
    await say(`meeting-unlink-${code}`);
    await say(`meeting-link-${code} ${bob}`);
    await say(`meeting-notes-${code} About Bob.`);
    const { results } = await db.prepare("SELECT contact_id, summary FROM meetings ORDER BY contact_id").all<{ contact_id: string; summary: string }>();
    expect(results.find((r) => r.contact_id === jane)?.summary).toBe("2026-11-09: About Jane.");
    expect(results.find((r) => r.contact_id === bob)?.summary).toBe("2026-11-09: About Bob.");
  });

  it("drafts the recap again when a no-show is corrected to held", async () => {
    const code = await ambiguousMeeting("evfix", NOW.getTime() - 3_600_000);
    await say(`meeting-link-${code} ${jane}`);
    await say(`meeting-held-${code}`);
    await say(`meeting-noshow-${code}`);
    expect(await say(`meeting-held-${code}`)).toContain("A recap draft is waiting for your approval.");
    const { results } = await db.prepare("SELECT kind, status FROM drafts ORDER BY kind").all();
    expect(results).toEqual([
      { kind: "check_in", status: "rejected" },
      { kind: "recap", status: "pending_approval" },
    ]);
  });

  it("refuses held before the meeting ends, and on an unlinked booking", async () => {
    const code = await ambiguousMeeting();
    expect(await say(`meeting-held-${code}`)).toContain("is not linked to a contact");
    await say(`meeting-link-${code} ${jane}`);
    expect(await say(`meeting-held-${code}`)).toContain("has not ended yet");
    expect(await say("meeting-held-mg0000000000")).toContain("There is no booking mg0000000000");
  });

  it("keeps notes, which show in later briefs and only there", async () => {
    const code = await ambiguousMeeting();
    await say(`meeting-link-${code} ${jane}`);
    expect(await say(`meeting-notes-${code} Wants SSO before a trial.`)).toContain(`Notes saved on meeting ${code}`);
    await say(`meeting-notes-${code} Budget owner is the CFO.`);
    expect(await db.prepare("SELECT summary FROM meetings").first()).toEqual({ summary: "2026-11-09: Wants SSO before a trial.\n\n2026-11-09: Budget owner is the CFO." });
    const brief = await say(`prep-${jane}`);
    expect(brief).toContain("Prep brief: Jane Doe");
    expect(brief).toContain(`Meeting ${code}: 2026-11-10 12:00 UTC`);
    expect(brief).toContain("Your notes (2026-11-10): 2026-11-09: Wants SSO before a trial. 2026-11-09: Budget owner is the CFO.");
  });

  it("builds a prep brief on any contact by id or address, and lists meetings, with no flag", async () => {
    await env.KV.put("convert:calendar_enabled", "false");
    const brief = await say("prep-bob@globex.example");
    expect(brief).toContain("Prep brief: Bob");
    expect(brief).toContain("Account: Globex Corporation");
    expect(brief).toContain("Others at the account: 1 in your contacts");
    expect(brief).not.toContain("jane@globex.example");
    expect(await say("prep-nobody@globex.example")).toContain("No contact matches nobody@globex.example.");
    expect(await say("/meetings")).toContain("none in the next 60 days");
    expect(await say("meeting-held-mg0123456789")).toContain("Calendar sync is off (convert:calendar_enabled)");
  });

  it("lists linked meetings and unlinked bookings with their codes", async () => {
    const code = await ambiguousMeeting();
    const list = await say("/meetings");
    expect(list).toContain(`[${code}] ambiguous, attendees at globex.example`);
    await say(`meeting-link-${code} ${jane}`);
    expect(await say("/meetings")).toContain(`2026-11-10 12:00 UTC [${code}] Jane Doe <jane@globex.example>`);
  });
});
