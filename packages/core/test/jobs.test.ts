// GTM-agents: tests for the cron parser, the job registry and the scheduled loop.
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { CronError, cronMatches, parseCron, previousFire } from "../src/jobs/cron.ts";
import { defaultRunner, runScheduledJobs } from "../src/jobs/loop.ts";
import { createJobRegistry, defineJob, type JobContext, type RegisteredJob } from "../src/jobs/registry.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function context(job: RegisteredJob, signal: AbortSignal, flags: Record<string, string | null> = {}, flagsThrow = false): JobContext {
  return {
    env: {},
    config,
    job: job.name,
    now: new Date("2026-11-02T13:00:00Z"),
    signal,
    ceilings: job.ceilings,
    flags: { get: async (key) => (flagsThrow ? Promise.reject(new Error("store down")) : (flags[key] ?? null)) },
    log: quietLog,
  };
}

describe("cron", () => {
  it("parses named days, ranges, steps and lists", () => {
    const s = parseCron("*/15 9-17 * JAN,JUL MON-FRI");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect(s.hours.has(9) && s.hours.has(17) && !s.hours.has(18)).toBe(true);
    expect([...s.months]).toEqual([1, 7]);
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects numeric day-of-week, because Cloudflare counts 1 as Sunday", () => {
    expect(() => parseCron("0 9 * * 1-5")).toThrow(/day names/);
  });

  it("rejects non-standard tokens, bad ranges and the wrong field count", () => {
    expect(() => parseCron("0 9 L * *")).toThrow(CronError);
    expect(() => parseCron("0 17-9 * * *")).toThrow(/backwards/);
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 9 * * *")).toThrow(/outside/);
  });

  it("matches the right minutes in UTC", () => {
    const s = parseCron("0 13 * * MON-THU");
    expect(cronMatches(s, new Date("2026-11-02T13:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches(s, new Date("2026-11-06T13:00:00Z"))).toBe(false); // a Friday
    expect(cronMatches(s, new Date("2026-11-02T13:01:00Z"))).toBe(false);
  });

  it("uses OR semantics when both day-of-month and day-of-week are restricted", () => {
    const s = parseCron("0 0 1 * MON");
    expect(cronMatches(s, new Date("2026-11-01T00:00:00Z"))).toBe(true); // the 1st (a Sunday)
    expect(cronMatches(s, new Date("2026-11-02T00:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches(s, new Date("2026-11-03T00:00:00Z"))).toBe(false);
  });

  it("finds the previous fire time across days", () => {
    const s = parseCron("30 9 * * MON-FRI");
    expect(previousFire(s, new Date("2026-11-02T10:00:00Z"))?.toISOString()).toBe("2026-11-02T09:30:00.000Z");
    expect(previousFire(s, new Date("2026-11-02T09:00:00Z"))?.toISOString()).toBe("2026-10-30T09:30:00.000Z"); // the Friday before
    expect(previousFire(s, new Date("2026-11-02T09:30:00Z"))?.toISOString()).toBe("2026-11-02T09:30:00.000Z");
  });
});

describe("job registry", () => {
  const job = (name: string, schedule: string, run: RegisteredJob["run"] = async () => {}) =>
    defineJob({ name, schedule, ceilings: { maxDurationMs: 1000 }, run });

  it("validates names, schedules and ceilings when a job is defined", () => {
    expect(() => job("Bad-Name", "0 9 * * *")).toThrow(/snake_case/);
    expect(() => job("ok_name", "0 9 * * 1")).toThrow(/day names/);
    expect(() => defineJob({ name: "unbounded", schedule: "0 9 * * *", ceilings: { maxDurationMs: 0 }, run: async () => {} })).toThrow(/maxDurationMs/);
  });

  it("refuses duplicate job names", () => {
    expect(() => createJobRegistry([job("a_job", "0 9 * * *"), job("a_job", "0 10 * * *")])).toThrow(/twice/);
  });

  it("finds jobs by cron, whatever the spacing or case, and lists distinct schedules", () => {
    const registry = createJobRegistry([job("first", "0 9 * * mon-fri"), job("second", "0 9 * * MON-FRI"), job("third", "*/5 * * * *")]);
    expect(registry.forCron("0  9 * * MON-FRI").map((j) => j.name)).toEqual(["first", "second"]);
    expect(registry.schedules()).toEqual(["*/5 * * * *", "0 9 * * MON-FRI"]);
  });
});

describe("scheduled loop", () => {
  it("runs matching jobs in order, and a failing job does not stop the next one", async () => {
    const ran: string[] = [];
    const registry = createJobRegistry([
      defineJob({ name: "breaks", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1000 }, run: async () => { ran.push("breaks"); throw new Error("boom"); } }),
      defineJob({ name: "works", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1000 }, run: async () => { ran.push("works"); return { summary: "done" }; } }),
      defineJob({ name: "other_time", schedule: "0 10 * * *", ceilings: { maxDurationMs: 1000 }, run: async () => { ran.push("other_time"); } }),
    ]);
    const outcomes = await runScheduledJobs(registry, "0 9 * * *", (j, signal) => context(j, signal));
    expect(ran).toEqual(["breaks", "works"]);
    expect(outcomes.map((o) => [o.job, o.status])).toEqual([["breaks", "failed"], ["works", "completed"]]);
    expect(outcomes[0]?.error).toBe("boom");
  });

  it("fails a job that exceeds its duration ceiling", async () => {
    const registry = createJobRegistry([
      defineJob({ name: "slow", schedule: "0 9 * * *", ceilings: { maxDurationMs: 20 }, run: () => new Promise((r) => setTimeout(r, 500)) }),
    ]);
    const [outcome] = await runScheduledJobs(registry, "0 9 * * *", (j, signal) => context(j, signal));
    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toMatch(/ceiling/);
  });

  it("skips a flagged job while its flag is off, and when the flag cannot be read", async () => {
    let runs = 0;
    const flagged = defineJob({ name: "flagged", schedule: "0 9 * * *", flag: "cold_batch:enabled", ceilings: { maxDurationMs: 1000 }, run: async () => { runs++; } });
    const signal = new AbortController().signal;
    expect((await defaultRunner(flagged, context(flagged, signal))).status).toBe("skipped");
    expect((await defaultRunner(flagged, context(flagged, signal, { "cold_batch:enabled": "false" }))).status).toBe("skipped");
    expect((await defaultRunner(flagged, context(flagged, signal, {}, true))).status).toBe("skipped");
    expect(runs).toBe(0);
    expect((await defaultRunner(flagged, context(flagged, signal, { "cold_batch:enabled": "true" }))).status).toBe("completed");
    expect(runs).toBe(1);
  });
});
