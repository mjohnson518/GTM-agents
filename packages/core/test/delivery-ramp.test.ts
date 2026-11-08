// GTM-agents: tests for the warm-up ramp: reading the level, today's cold volume, and the ramp job's
// decisions on delivery evidence.
//
// Each test that reads the send ledger runs on its own dates in 2025, so it sees only its own rows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { COLD_PAUSE_CRITICAL_KEY, COLD_PAUSE_KEY } from "../src/sending/kill-switch.ts";
import { COLD_VOLUME_HARD_MAX, rampAdvanceVerdict, rampStepDownVerdict, readColdVolume, readRamp, runRampJob } from "../src/sending/ramp.ts";
import { uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;

/** Insert `count` cold sends at `sentAt`, with optional delivery, hard bounce and complaint times. */
async function insertSends(count: number, at: { sent: Date; delivered?: Date; bounced?: Date; complained?: Date }): Promise<void> {
  const statement = db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sent_at, delivered_at, bounced_at, complained_at) VALUES (?1, 'cold', 'test-ledger', ?2, ?3, ?4, ?5)");
  const rows = Array.from({ length: count }, () => statement.bind(uid("send"), at.sent.toISOString(), at.delivered?.toISOString() ?? null, at.bounced?.toISOString() ?? null, at.complained?.toISOString() ?? null));
  for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
}

const flagsOf = (kv: ReturnType<typeof memoryKv>) => ({ get: (key: string) => kv.get(key) });

describe("reading the ramp", () => {
  it("defaults to the quietest level and clamps out-of-range values", async () => {
    expect(await readRamp(memoryKv())).toMatchObject({ index: 0, limit: 25, degraded: false });
    expect(await readRamp(memoryKv({ [DELIVERY_FLAGS.rampLevel]: "2" }))).toMatchObject({ index: 2, limit: 100 });
    expect(await readRamp(memoryKv({ [DELIVERY_FLAGS.rampLevel]: "9" }))).toMatchObject({ index: 4, limit: 500 });
    expect(await readRamp(memoryKv({ [DELIVERY_FLAGS.rampLevel]: "-3" }))).toMatchObject({ index: 0, limit: 25 });
  });

  it("falls back to level 0 when the state is malformed or unreadable", async () => {
    expect(await readRamp(memoryKv({ [DELIVERY_FLAGS.rampLevel]: "lots" }))).toMatchObject({ index: 0, limit: 25, degraded: true });
    const failing = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "4" });
    failing.failing = true;
    expect(await readRamp(failing)).toMatchObject({ index: 0, limit: 25, degraded: true });
    expect(await readRamp(undefined)).toMatchObject({ limit: 25, degraded: true });
  });
});

describe("today's cold volume", () => {
  it("is the ramp level, lowered by the operator limit and the domain cap, never above the hard maximum", async () => {
    const at = (values: Record<string, string>) => {
      const kv = memoryKv(values);
      return readColdVolume({ kv, flags: flagsOf(kv) });
    };
    expect((await at({ [DELIVERY_FLAGS.rampLevel]: "2" })).volume).toBe(100);
    expect(await at({ [DELIVERY_FLAGS.rampLevel]: "2", [DELIVERY_FLAGS.coldDailyLimit]: "40" })).toMatchObject({ volume: 40, operatorLimit: 40 });
    expect((await at({ [DELIVERY_FLAGS.rampLevel]: "1", [DELIVERY_FLAGS.coldDailyLimit]: "400" })).volume).toBe(50);
    expect((await at({ [DELIVERY_FLAGS.rampLevel]: "4", [DELIVERY_FLAGS.domainDailyCap]: "30" })).volume).toBe(30);
    expect((await at({ [DELIVERY_FLAGS.rampLevel]: "4", [DELIVERY_FLAGS.domainDailyCap]: "10000" })).volume).toBeLessThanOrEqual(COLD_VOLUME_HARD_MAX);
  });

  it("allows nothing when the operator limit cannot be read or parsed", async () => {
    const bad = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "2", [DELIVERY_FLAGS.coldDailyLimit]: "some" });
    expect((await readColdVolume({ kv: bad, flags: flagsOf(bad) })).volume).toBe(0);
    const kv = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "2" });
    const flags = { get: (key: string) => (key === DELIVERY_FLAGS.coldDailyLimit ? Promise.reject(new Error("kv unavailable")) : kv.get(key)) };
    expect((await readColdVolume({ kv, flags })).volume).toBe(0);
  });
});

describe("the ramp verdicts", () => {
  const evidence = { sends: 60, delivered: 50, peakDayDelivered: 40, hardBounced: 0, complained: 0 };

  it("advances only on enough delivered mail with low bounces and complaints", () => {
    expect(rampAdvanceVerdict(evidence, 50).ok).toBe(true);
    expect(rampAdvanceVerdict({ ...evidence, sends: 0 }, 50).ok).toBe(false);
    expect(rampAdvanceVerdict({ ...evidence, delivered: 0, peakDayDelivered: 0 }, 50).ok).toBe(false);
    expect(rampAdvanceVerdict({ ...evidence, peakDayDelivered: 34 }, 50).ok).toBe(false);
    expect(rampAdvanceVerdict({ ...evidence, hardBounced: 2 }, 50).ok).toBe(false);
    expect(rampAdvanceVerdict({ ...evidence, delivered: 2000, peakDayDelivered: 400, complained: 2 }, 50).ok).toBe(false);
  });

  it("steps down at 0.3% complaints with 20 or more delivered", () => {
    expect(rampStepDownVerdict({ ...evidence, delivered: 300, complained: 1 }).ok).toBe(true);
    expect(rampStepDownVerdict({ ...evidence, delivered: 400, complained: 1 }).ok).toBe(false);
    expect(rampStepDownVerdict({ ...evidence, delivered: 19, complained: 5 }).ok).toBe(false);
  });
});

describe("the ramp job", () => {
  it("advances one level on a week of good delivery evidence, and announces it", async () => {
    const now = new Date("2025-03-12T09:30:00.000Z");
    const kv = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "1", [DELIVERY_FLAGS.rampChangedAt]: new Date(now.getTime() - 8 * DAY).toISOString() });
    const day = new Date(now.getTime() - 2 * DAY);
    await insertSends(36, { sent: day, delivered: day });
    await insertSends(4, { sent: day });
    const operator = recordingOperator();
    const result = await runRampJob({ db, kv, operator: operator.channel, now });
    expect(result).toMatchObject({ action: "advanced", from: 50, to: 100 });
    expect(kv.map.get(DELIVERY_FLAGS.rampLevel)).toBe("2");
    expect(kv.map.get(DELIVERY_FLAGS.rampChangedAt)).toBe(now.toISOString());
    expect(operator.messages.some((m) => m.text.includes("advanced to 100"))).toBe(true);
  });

  it("holds within 7 days of the last change, and when the best day used too little of the level", async () => {
    const now = new Date("2025-04-09T09:30:00.000Z");
    const day = new Date(now.getTime() - DAY);
    await insertSends(40, { sent: day, delivered: day });
    const recent = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "1", [DELIVERY_FLAGS.rampChangedAt]: new Date(now.getTime() - 3 * DAY).toISOString() });
    expect((await runRampJob({ db, kv: recent, now })).action).toBe("held");
    const higher = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "2", [DELIVERY_FLAGS.rampChangedAt]: new Date(now.getTime() - 30 * DAY).toISOString() });
    const underused = await runRampJob({ db, kv: higher, now });
    expect(underused.action).toBe("held");
    expect(underused.reason).toContain("best day");
  });

  it("steps down on complaints, counting only evidence since the last change", async () => {
    const now = new Date("2025-05-14T09:30:00.000Z");
    const day = new Date(now.getTime() - DAY);
    await insertSends(24, { sent: day, delivered: day });
    await insertSends(1, { sent: day, delivered: day, complained: day });
    const kv = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "2", [DELIVERY_FLAGS.rampChangedAt]: new Date(now.getTime() - 20 * DAY).toISOString() });
    expect(await runRampJob({ db, kv, now })).toMatchObject({ action: "stepped_down", from: 100, to: 50 });
    // The same complaint never moves the level twice.
    expect((await runRampJob({ db, kv, now: new Date(now.getTime() + 60_000) })).action).toBe("held");
  });

  it("steps down once for a warning pause and holds under a critical one", async () => {
    const now = new Date("2025-06-11T09:30:00.000Z");
    const kv = memoryKv({
      [DELIVERY_FLAGS.rampLevel]: "3",
      [DELIVERY_FLAGS.rampChangedAt]: new Date(now.getTime() - 20 * DAY).toISOString(),
      [COLD_PAUSE_KEY]: JSON.stringify({ reason: "bounce spike", source: "bounce-monitor", since: new Date(now.getTime() - DAY).toISOString() }),
    });
    expect(await runRampJob({ db, kv, now })).toMatchObject({ action: "stepped_down", from: 250, to: 100 });
    expect((await runRampJob({ db, kv, now: new Date(now.getTime() + DAY) })).action).toBe("held");
    kv.map.set(COLD_PAUSE_CRITICAL_KEY, JSON.stringify({ reason: "operator", source: "operator", since: now.toISOString() }));
    const critical = await runRampJob({ db, kv, now: new Date(now.getTime() + 2 * DAY) });
    expect(critical.action).toBe("held");
    expect(critical.reason).toContain("critical");
  });

  it("never moves on unreadable state", async () => {
    const kv = memoryKv({ [DELIVERY_FLAGS.rampLevel]: "2" });
    kv.failing = true;
    expect((await runRampJob({ db, kv, now: new Date("2025-07-09T09:30:00.000Z") })).action).toBe("held");
    expect((await runRampJob({ db, kv: memoryKv({ [DELIVERY_FLAGS.rampLevel]: "x" }), now: new Date("2025-07-09T09:30:00.000Z") })).action).toBe("held");
  });
});
