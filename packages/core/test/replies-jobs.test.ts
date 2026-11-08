// GTM-agents: the reply jobs: names, schedules, flags and ceilings; every flag registered and off by
// default; a model-calling schedule refused when it runs more often than every 15 minutes; a job
// whose flag is off does nothing. Every value is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findFlag } from "../src/flags/registry.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { REPLY_FLAGS } from "../src/replies/flags.ts";
import { createReplyJobs } from "../src/replies/jobs.ts";
import { replyModel, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, triageAnswer } from "../src/replies/testing.ts";

describe("the reply jobs", () => {
  it("register four jobs behind their flags, with ceilings", () => {
    const jobs = createReplyJobs({});
    expect(jobs.map((j) => [j.name, j.schedule, j.flag])).toEqual([
      ["replies_triage", "*/15 * * * *", "replies:triage_enabled"],
      ["replies_mirror", "*/15 * * * *", "replies:mirror_enabled"],
      ["replies_send", "*/5 * * * *", "replies:send_enabled"],
      ["replies_reminders", "*/5 * * * *", "replies:reminders_enabled"],
    ]);
    for (const job of jobs) expect(job.ceilings.maxRows).toBeGreaterThan(0);
    expect(jobs[0]?.ceilings.maxSpendCents).toBe(100);
  });

  it("refuse a triage schedule that would call models more often than every 15 minutes", () => {
    expect(() => createReplyJobs({ options: { triageSchedule: "*/5 * * * *" } })).toThrow(/at most every 15 minutes/);
    expect(() => createReplyJobs({ options: { triageSchedule: "0,10 * * * *" } })).toThrow(/at most every 15 minutes/);
    expect(() => createReplyJobs({ options: { triageSchedule: "7,37 * * * *" } })).not.toThrow();
  });

  it("are listed in the flag registry, every one off by default", () => {
    for (const key of Object.values(REPLY_FLAGS)) expect(findFlag(key), key).toMatchObject({ kind: "boolean", default: "false" });
  });

  it("do nothing while their flag is off, even when run directly", async () => {
    await resetReplyTables(env.DB);
    const contact = await seedReplyContact(env.DB, { email: "jane@globex.example" });
    await seedInbound(env.DB, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Can we talk?" });
    const model = replyModel({ triage: triageAnswer({ intent: "interested" }) });
    const [triage] = createReplyJobs({ model: () => model });
    const config = replyTestConfig();
    const result = await triage?.run({ env: { DB: env.DB, KV: env.KV, BUCKET: env.BUCKET }, config, job: "replies_triage", now: REPLY_TEST_NOW, signal: new AbortController().signal, ceilings: triage.ceilings, flags: flagReader({}), log: silentLogger });
    expect(result).toEqual({ summary: "flag off" });
    expect(model.requests).toHaveLength(0);
    const on = await triage?.run({ env: { DB: env.DB, KV: env.KV, BUCKET: env.BUCKET }, config, job: "replies_triage", now: REPLY_TEST_NOW, signal: new AbortController().signal, ceilings: triage.ceilings, flags: flagReader({ "replies:triage_enabled": "true" }), log: silentLogger });
    expect(on?.summary).toMatch(/triaged 1/);
  });
});
