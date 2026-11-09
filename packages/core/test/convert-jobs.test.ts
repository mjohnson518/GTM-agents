// GTM-agents: the convert jobs: names, schedules, flags and ceilings, and what each does with its
// flag off or without a calendar. Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { CALENDAR_SYNC_JOB, DEAL_HANDOFF_JOB, MEETING_FOLLOWUPS_JOB, createConvertJobs } from "../src/convert/jobs.ts";
import { calendarEvent, fakeCalendar, resetConvertTables } from "../src/convert/testing.ts";
import { findFlag } from "../src/flags/registry.ts";
import type { JobContext, RegisteredJob } from "../src/jobs/registry.ts";
import { flagReader, seedContact, silentLogger } from "../src/outreach/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["4249001"], allowedUserIds: ["4249001"] } });
type ConvertTestEnv = { DB: D1Database };

const ctx = (job: RegisteredJob<ConvertTestEnv>, flags: Record<string, string>): JobContext<ConvertTestEnv> => ({
  env: { DB: db },
  config,
  job: job.name,
  now: NOW,
  signal: new AbortController().signal,
  ceilings: job.ceilings,
  flags: flagReader(flags),
  log: silentLogger,
});

beforeEach(async () => {
  await resetConvertTables(db);
});

describe("the convert jobs", () => {
  it("register three bounded jobs behind convert flags that default off, every 15 minutes at most often", () => {
    const jobs = createConvertJobs<ConvertTestEnv>({ calendar: () => fakeCalendar() });
    expect(jobs.map((j) => [j.name, j.schedule, j.flag])).toEqual([
      [CALENDAR_SYNC_JOB, "*/15 * * * *", "convert:calendar_enabled"],
      [MEETING_FOLLOWUPS_JOB, "5,20,35,50 * * * *", "convert:calendar_enabled"],
      [DEAL_HANDOFF_JOB, "10 * * * *", "convert:handoff_enabled"],
    ]);
    for (const job of jobs) {
      expect(job.ceilings.maxRows, job.name).toBeGreaterThan(0);
      expect(job.ceilings.maxDurationMs, job.name).toBeLessThanOrEqual(120_000);
      expect(job.ceilings.maxSpendCents, `${job.name} spends nothing`).toBeUndefined();
      expect(findFlag(job.flag ?? "")?.default, job.name).toBe("false");
      expect(job.cron.minutes.size, job.name).toBeLessThanOrEqual(4);
    }
    expect(findFlag("convert:post_demo_enabled")?.default).toBe("false");
    expect(() => createConvertJobs<ConvertTestEnv>({ calendar: () => undefined, options: { syncMaxRows: 0 } })).toThrow(/syncMaxRows/);
  });

  it("do nothing with the flag off, and calendar sync does nothing without a calendar", async () => {
    const calendar = fakeCalendar([calendarEvent({ id: "evj", start: new Date(NOW.getTime() + 86_400_000).toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] })]);
    const [sync, followups, handoffs] = createConvertJobs<ConvertTestEnv>({ calendar: () => calendar });
    if (!sync || !followups || !handoffs) throw new Error("three jobs expected");
    expect(await sync.run(ctx(sync, {}))).toEqual({ summary: "flag off" });
    expect(await followups.run(ctx(followups, {}))).toEqual({ summary: "flag off" });
    expect(await handoffs.run(ctx(handoffs, {}))).toEqual({ summary: "flag off" });
    expect(calendar.windows).toHaveLength(0);
    const [bare] = createConvertJobs<ConvertTestEnv>({
      calendar: () => {
        throw new Error("missing secret GOOGLE_CALENDAR_REFRESH_TOKEN");
      },
    });
    if (!bare) throw new Error("a job expected");
    expect(await bare.run(ctx(bare, { "convert:calendar_enabled": "true" }))).toEqual({ summary: "no calendar configured" });
  });

  it("calendar sync runs from its job with the operator channel and summarizes what it did", async () => {
    await seedContact(db, { first: "Jane", email: "jane@globex.example" });
    const calendar = fakeCalendar([calendarEvent({ id: "evj", start: new Date(NOW.getTime() + 86_400_000).toISOString(), attendees: [{ email: "jane@globex.example", response: "accepted" }] })]);
    const operator = recordingOperator();
    const [sync] = createConvertJobs<ConvertTestEnv>({ calendar: () => calendar, operator: () => operator.channel });
    if (!sync) throw new Error("a job expected");
    const result = await sync.run(ctx(sync, { "convert:calendar_enabled": "true" }));
    expect(result).toMatchObject({ rows: 1 });
    expect((result as { summary: string }).summary).toContain("booked 1");
    expect(operator.messages[0]?.chatId).toBe("4249001");
  });
});
