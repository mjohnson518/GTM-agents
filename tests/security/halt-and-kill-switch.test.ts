// GTM-agents: the system halt and the cold outreach kill switch fail closed, and only the operator
// lifts a critical pause.
import { COLD_PAUSE_CRITICAL_KEY, COLD_PAUSE_KEY, checkSendGates, pauseColdOutreach, readColdPause, resumeColdOutreach } from "@gtm-agents/core/sending";
import { HALT_KEY, clearHalt, readHalt, setHalt } from "@gtm-agents/core/security";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv } from "./helpers.ts";

const recipients = ["new.contact@prospect.example"];

describe("the system halt", () => {
  it("reads as running only when the key is absent", async () => {
    const kv = new MemoryKv();
    expect(await readHalt(kv)).toEqual({ halted: false });
    for (const value of ["1", "", "{}", "not json", "[1]", JSON.stringify({ reason: "incident", by: "operator", since: "2026-11-04T10:00:00.000Z" })]) {
      kv.map.set(HALT_KEY, value);
      expect((await readHalt(kv)).halted, value).toBe(true);
    }
    expect(await readHalt(kv)).toEqual({ halted: true, reason: "incident", by: "operator", since: "2026-11-04T10:00:00.000Z" });
  });

  it("fails closed when KV throws or the binding is missing", async () => {
    const kv = new MemoryKv();
    kv.failing = true;
    expect((await readHalt(kv)).halted).toBe(true);
    expect((await readHalt(undefined)).halted).toBe(true);
  });

  it("is set and cleared by the operator path", async () => {
    const kv = new MemoryKv();
    await setHalt(kv, { reason: "deliverability incident", by: "operator" }, new Date("2026-11-04T10:00:00.000Z"));
    expect(await readHalt(kv)).toMatchObject({ halted: true, reason: "deliverability incident", since: "2026-11-04T10:00:00.000Z" });
    await clearHalt(kv);
    expect((await readHalt(kv)).halted).toBe(false);
  });
});

describe("the cold outreach kill switch", () => {
  it("reads absent as running, and anything unreadable as a critical pause", async () => {
    const kv = new MemoryKv();
    expect(await readColdPause(kv)).toEqual({ paused: false });
    kv.map.set(COLD_PAUSE_KEY, "not json");
    expect(await readColdPause(kv)).toMatchObject({ paused: true, severity: "critical", source: "fail-closed" });
    kv.map.set(COLD_PAUSE_KEY, JSON.stringify({ reason: "bounce spike" }));
    expect(await readColdPause(kv)).toMatchObject({ paused: true, severity: "warning", reason: "bounce spike" });
    kv.map.set(COLD_PAUSE_CRITICAL_KEY, "[]");
    expect(await readColdPause(kv)).toMatchObject({ paused: true, severity: "critical", source: "fail-closed" });
    kv.failing = true;
    expect(await readColdPause(kv)).toMatchObject({ paused: true, severity: "critical" });
    expect(await readColdPause(undefined)).toMatchObject({ paused: true, severity: "critical" });
  });

  it("blocks cold sends when the kill switch read throws, even though the halt reads fine", async () => {
    const kv = new MemoryKv();
    kv.failingKeys.add(COLD_PAUSE_CRITICAL_KEY);
    expect(await checkSendGates({ kv, db: env.DB }, { path: "cold", recipients })).toMatchObject({ ok: false, reason: "cold_paused" });
    expect((await checkSendGates({ kv, db: env.DB }, { path: "reply", recipients })).ok).toBe(true);
  });

  it("keeps a critical pause when automation later pauses at warning or tries to resume", async () => {
    const kv = new MemoryKv();
    await pauseColdOutreach(kv, { reason: "operator pause", source: "operator" });
    expect((await pauseColdOutreach(kv, { reason: "bounce warning", source: "bounce-monitor", severity: "warning" })).severity).toBe("critical");
    expect(await resumeColdOutreach(kv)).toMatchObject({ ok: false, refused: "a critical pause is lifted only by the operator" });
    expect(kv.map.has(COLD_PAUSE_CRITICAL_KEY)).toBe(true);
  });

  it("lifts a critical pause only for the operator, and a warning pause for automation", async () => {
    const kv = new MemoryKv();
    await pauseColdOutreach(kv, { reason: "operator pause", source: "operator" });
    expect((await readColdPause(kv)).paused).toBe(true);
    expect((await resumeColdOutreach(kv, { liftCritical: true })).ok).toBe(true);
    expect((await readColdPause(kv)).paused).toBe(false);

    await pauseColdOutreach(kv, { reason: "bounce warning", source: "bounce-monitor", severity: "warning" });
    expect((await resumeColdOutreach(kv)).ok).toBe(true);
    expect((await readColdPause(kv)).paused).toBe(false);
  });
});

describe("the send gates", () => {
  it("block every path while the system is halted, replies included", async () => {
    const kv = new MemoryKv();
    await setHalt(kv, { reason: "incident", by: "operator" });
    for (const path of ["cold", "sequence", "reply", "lifecycle"] as const) {
      const result = await checkSendGates({ kv, db: env.DB }, { path, recipients });
      expect(result, path).toMatchObject({ ok: false, reason: "halted" });
      if (!result.ok) expect(result.message.startsWith("[SEND BLOCKED:halted]")).toBe(true);
    }
  });

  it("hold cold and sequence sends while cold outreach is paused, and let replies and lifecycle mail through", async () => {
    const kv = new MemoryKv();
    await pauseColdOutreach(kv, { reason: "bounce spike", source: "bounce-monitor" });
    expect(await checkSendGates({ kv, db: env.DB }, { path: "cold", recipients })).toMatchObject({ ok: false, reason: "cold_paused" });
    expect(await checkSendGates({ kv, db: env.DB }, { path: "sequence", recipients })).toMatchObject({ ok: false, reason: "cold_paused" });
    expect(await checkSendGates({ kv, db: env.DB }, { path: "reply", recipients })).toEqual({ ok: true, recipients });
    expect(await checkSendGates({ kv, db: env.DB }, { path: "lifecycle", recipients })).toEqual({ ok: true, recipients });
    expect(await checkSendGates({ kv, db: env.DB }, { path: "unknown" as never, recipients })).toMatchObject({ ok: false, reason: "cold_paused" });
  });

  it("refuse a send with no recipients", async () => {
    expect(await checkSendGates({ kv: new MemoryKv(), db: env.DB }, { path: "reply", recipients: [] })).toMatchObject({ ok: false, reason: "no_recipients" });
  });
});
