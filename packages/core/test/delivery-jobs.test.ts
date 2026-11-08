// GTM-agents: tests for the delivery jobs (schedules, flags, ceilings, flag-off behavior) and the
// liveness check.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { createJobRegistry, type JobContext } from "../src/jobs/registry.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { BOUNCE_MONITOR_JOB, LIVENESS_JOB, RAMP_JOB, REPLAY_JOB, createDeliveryJobs, type DeliveryEnv } from "../src/sending/jobs.ts";
import { runLiveness } from "../src/sending/liveness.ts";
import { COLD_PAUSE_KEY } from "../src/sending/kill-switch.ts";
import { fakeEmailProvider } from "../src/sending/testing.ts";
import { config, uid } from "./delivery-fakes.ts";

const db = env.DB;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function ctx(kv: ReturnType<typeof memoryKv>, job: string, now: Date): JobContext<DeliveryEnv> {
  return { env: { DB: db, KV: kv }, config, job, now, signal: new AbortController().signal, ceilings: { maxDurationMs: 60_000, maxRows: 100 }, flags: { get: (k) => kv.get(k) }, log: silent };
}

describe("the delivery jobs", () => {
  const jobs = createDeliveryJobs<DeliveryEnv>({ email: () => fakeEmailProvider({ name: uid("esp") }) });

  it("declares four jobs with named-day schedules, flags that default off and ceilings", () => {
    const registry = createJobRegistry(jobs);
    expect(jobs.map((j) => [j.name, j.schedule, j.flag])).toEqual([
      [REPLAY_JOB, "0 0,8,13,20 * * MON-FRI", "delivery:enabled"],
      [BOUNCE_MONITOR_JOB, "0 9 * * SUN-SAT", "delivery:enabled"],
      [RAMP_JOB, "30 9 * * MON-FRI", "outreach:ramp_auto"],
      [LIVENESS_JOB, "0 21 * * MON-FRI", "cold_batch:enabled"],
    ]);
    for (const job of jobs) {
      expect(job.ceilings.maxDurationMs).toBeGreaterThan(0);
      expect(job.ceilings.maxRows).toBeGreaterThan(0);
      expect(job.schedule).not.toMatch(/\s[0-6](?:[-,]\d)*$/);
    }
    expect(registry.schedules()).toHaveLength(4);
  });

  it("does nothing when run directly with its flag off", async () => {
    const kv = memoryKv();
    for (const job of jobs) expect(await job.run(ctx(kv, job.name, new Date("2025-02-05T09:00:00.000Z")))).toEqual({ summary: "flag off" });
  });

  it("runs each job when its flag is on", async () => {
    const now = new Date("2025-02-12T09:00:00.000Z");
    const kv = memoryKv({ [DELIVERY_FLAGS.enabled]: "true", [DELIVERY_FLAGS.rampAuto]: "true", [DELIVERY_FLAGS.coldBatchEnabled]: "true" });
    const [replay, bounce, ramp, liveness] = jobs;
    expect((await replay?.run(ctx(kv, REPLAY_JOB, now)))?.summary).toMatch(/^due \d+/);
    expect((await bounce?.run(ctx(kv, BOUNCE_MONITOR_JOB, now)))?.summary).toMatch(/no_data|low_volume|healthy/);
    expect((await ramp?.run(ctx(kv, RAMP_JOB, now)))?.summary).toMatch(/^held/);
    expect((await liveness?.run(ctx(kv, LIVENESS_JOB, now)))?.summary).toMatch(/^quiet/);
  });

  it("refuses an out-of-range replay ceiling", () => {
    expect(() => createDeliveryJobs({ email: () => undefined, options: { replayMaxRows: 0 } })).toThrow(/replayMaxRows/);
  });
});

describe("the liveness check", () => {
  it("pages once a day, with a diagnosis, when nothing went out in 3 days", async () => {
    const now = new Date("2025-01-15T21:00:00.000Z");
    const kv = memoryKv({ [COLD_PAUSE_KEY]: JSON.stringify({ reason: "spike", source: "bounce-monitor", since: "2025-01-14T09:00:00.000Z" }) });
    const operator = recordingOperator();
    const deps = { db, kv, flags: { get: (k: string) => kv.get(k) }, config, operator: operator.channel, now };
    const first = await runLiveness(deps);
    expect(first).toMatchObject({ quiet: true, sentLast3Days: 0, paged: true });
    expect(first.diagnosis).toEqual(expect.arrayContaining([expect.stringContaining("cold outreach is paused (warning)"), "delivery:enabled is off", "cold_batch:enabled is off"]));
    expect((await runLiveness({ ...deps, now: new Date(now.getTime() + 60_000) })).paged).toBe(false);
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain("No outbound mail in the last 3 days");
  });

  it("stays quiet when mail went out today", async () => {
    const now = new Date("2025-01-22T21:00:00.000Z");
    await db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sent_at) VALUES (?1, 'cold', 'test-ledger', ?2)").bind(uid("send"), new Date(now.getTime() - 3_600_000).toISOString()).run();
    const kv = memoryKv();
    const result = await runLiveness({ db, kv, flags: { get: (k: string) => kv.get(k) }, config, now });
    expect(result).toMatchObject({ quiet: false, sentToday: 1, paged: false });
  });
});
