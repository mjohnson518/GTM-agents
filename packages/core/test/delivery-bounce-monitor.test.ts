// GTM-agents: tests for the bounce monitor: levels, automatic pauses, escalation, the warning pause
// lifting itself after clean days, and the daily reminder of a critical pause.
//
// Each test that reads the send ledger runs on its own dates in 2025, so it sees only its own rows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { bounceLevel, pauseSeverityFor, runBounceMonitor, worseLevel } from "../src/sending/bounce-monitor.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { COLD_PAUSE_CRITICAL_KEY, COLD_PAUSE_KEY, readColdPause } from "../src/sending/kill-switch.ts";
import { uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;

async function insertSends(count: number, sent: Date, bounced?: Date): Promise<void> {
  const statement = db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sent_at, bounced_at) VALUES (?1, 'cold', 'test-ledger', ?2, ?3)");
  const rows = Array.from({ length: count }, () => statement.bind(uid("send"), sent.toISOString(), bounced?.toISOString() ?? null));
  for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
}

describe("bounce levels", () => {
  it("reads low volume, healthy, warn and critical", () => {
    expect(bounceLevel(0, 0)).toBe("no_data");
    expect(bounceLevel(19, 5)).toBe("low_volume");
    expect(bounceLevel(100, 1)).toBe("healthy");
    expect(bounceLevel(100, 2)).toBe("warn");
    expect(bounceLevel(100, 5)).toBe("critical");
    expect(worseLevel("healthy", "critical")).toBe("critical");
  });

  it("gives a warning pause only to a spike the 7-day window does not confirm", () => {
    expect(pauseSeverityFor("healthy", "critical")).toBe("warning");
    expect(pauseSeverityFor("warn", "critical")).toBe("critical");
    expect(pauseSeverityFor("critical", "no_data")).toBe("critical");
  });
});

describe("the bounce monitor", () => {
  it("pauses at critical when the 7-day window is critical, and pages", async () => {
    const now = new Date("2025-08-06T09:00:00.000Z");
    await insertSends(94, new Date(now.getTime() - 3 * DAY));
    await insertSends(6, new Date(now.getTime() - 3 * DAY), new Date(now.getTime() - 3 * DAY));
    const kv = memoryKv();
    const operator = recordingOperator();
    const result = await runBounceMonitor({ db, kv, operator: operator.channel, now });
    expect(result).toMatchObject({ overall: "critical", action: "paused (critical)" });
    expect(kv.map.has(COLD_PAUSE_CRITICAL_KEY)).toBe(true);
    expect(operator.messages.some((m) => m.text.startsWith("Cold outreach paused (critical)"))).toBe(true);
  });

  it("gives a one-day spike a warning pause, and escalates a repeat within 14 days of an automatic lift", async () => {
    const now = new Date("2025-09-10T09:00:00.000Z");
    await insertSends(360, new Date(now.getTime() - 4 * DAY));
    await insertSends(37, new Date(now.getTime() - 3_600_000));
    await insertSends(3, new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 1_800_000));
    const first = memoryKv();
    expect(await runBounceMonitor({ db, kv: first, now })).toMatchObject({ action: "paused (warning)" });
    expect((await readColdPause(first)).severity).toBe("warning");
    const repeat = memoryKv({ [DELIVERY_FLAGS.lastAutoResume]: new Date(now.getTime() - 5 * DAY).toISOString() });
    expect(await runBounceMonitor({ db, kv: repeat, now })).toMatchObject({ action: "paused (critical)" });
  });

  it("lifts a warning pause after 3 clean days, stepping the ramp down once", async () => {
    const now = new Date("2025-10-08T09:00:00.000Z");
    const since = new Date(now.getTime() - 4 * DAY).toISOString();
    const kv = memoryKv({
      [COLD_PAUSE_KEY]: JSON.stringify({ reason: "spike", source: "bounce-monitor", since }),
      [DELIVERY_FLAGS.rampLevel]: "2",
      [DELIVERY_FLAGS.rampChangedAt]: new Date(now.getTime() - 30 * DAY).toISOString(),
    });
    const operator = recordingOperator();
    expect(await runBounceMonitor({ db, kv, operator: operator.channel, now })).toMatchObject({ action: "warning pause lifted" });
    expect((await readColdPause(kv)).paused).toBe(false);
    expect(kv.map.get(DELIVERY_FLAGS.rampLevel)).toBe("1");
    expect(kv.map.get(DELIVERY_FLAGS.lastAutoResume)).toBe(now.toISOString());
    expect(operator.messages.some((m) => m.text.startsWith("Cold outreach resumed"))).toBe(true);
  });

  it("keeps a warning pause that is too recent or whose last days were not clean", async () => {
    const now = new Date("2025-11-05T09:00:00.000Z");
    const recent = memoryKv({ [COLD_PAUSE_KEY]: JSON.stringify({ reason: "spike", source: "bounce-monitor", since: new Date(now.getTime() - DAY).toISOString() }) });
    expect((await runBounceMonitor({ db, kv: recent, now })).action).toContain("too recent");
    await insertSends(2, new Date(now.getTime() - 10 * DAY), new Date(now.getTime() - DAY));
    const dirty = memoryKv({ [COLD_PAUSE_KEY]: JSON.stringify({ reason: "spike", source: "bounce-monitor", since: new Date(now.getTime() - 5 * DAY).toISOString() }) });
    expect((await runBounceMonitor({ db, kv: dirty, now })).action).toContain("not clean");
    expect((await readColdPause(dirty)).paused).toBe(true);
  });

  it("never lifts a critical pause, and reminds the operator once a day", async () => {
    const now = new Date("2025-12-03T09:00:00.000Z");
    const kv = memoryKv({ [COLD_PAUSE_CRITICAL_KEY]: JSON.stringify({ reason: "operator hold", source: "operator", since: new Date(now.getTime() - 10 * DAY).toISOString() }) });
    const operator = recordingOperator();
    await runBounceMonitor({ db, kv, operator: operator.channel, now });
    await runBounceMonitor({ db, kv, operator: operator.channel, now: new Date(now.getTime() + 3_600_000) });
    expect(operator.messages.filter((m) => m.text.startsWith("Cold outreach is still paused"))).toHaveLength(1);
    await runBounceMonitor({ db, kv, operator: operator.channel, now: new Date(now.getTime() + DAY) });
    expect(operator.messages.filter((m) => m.text.startsWith("Cold outreach is still paused"))).toHaveLength(2);
    expect(kv.map.has(COLD_PAUSE_CRITICAL_KEY)).toBe(true);
  });

  it("never overwrites an operator's critical pause", async () => {
    const now = new Date("2025-08-20T09:00:00.000Z");
    await insertSends(90, new Date(now.getTime() - 2 * DAY));
    await insertSends(10, new Date(now.getTime() - 2 * DAY), new Date(now.getTime() - 2 * DAY));
    const record = JSON.stringify({ reason: "operator hold", source: "operator", since: "2025-08-01T00:00:00.000Z" });
    const kv = memoryKv({ [COLD_PAUSE_CRITICAL_KEY]: record });
    await runBounceMonitor({ db, kv, now });
    expect(kv.map.get(COLD_PAUSE_CRITICAL_KEY)).toBe(record);
  });
});
