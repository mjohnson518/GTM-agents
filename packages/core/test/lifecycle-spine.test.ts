// GTM-agents: the event spine: payload before row, insert-or-ignore by provider id, routing under a
// lease that goes stale after 10 minutes, at most 5 attempts then parked and audited, the 5-minute
// sweep, the queue consumer and payload retention. Every event is synthetic.
import { createMessageBatch, getQueueResult, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createEventConsumer, isEventMessage } from "../src/events/consumer.ts";
import { MAX_ROUTE_ATTEMPTS, purgeRoutedPayloads, recordEvent, routeEvent, sweepEvents, type EventRouters } from "../src/events/spine.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import type { Env } from "../src/env.ts";
import { bucket, count, db, resetLifecycle, routeContext, uid } from "./lifecycle-fixtures.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

function routers(behavior: { calls: string[]; fail?: number; flags?: string[] }): EventRouters<Env> {
  return {
    test: {
      flags: behavior.flags ?? [],
      async route(event, payload) {
        behavior.calls.push(`${event.id}:${payload}`);
        if (behavior.fail && behavior.calls.length <= behavior.fail) throw new Error("router failed");
        return { contactId: null, outcome: "ok" };
      },
    },
  };
}

async function record(providerId = uid("evt"), receivedAt = NOW): Promise<string> {
  const result = await recordEvent({ db, bucket }, { source: "test", providerId, type: "test.happened", occurredAt: receivedAt.toISOString(), receivedAt, payload: `{"n":"${providerId}"}`, taint: "structured" });
  return result.id;
}

beforeEach(resetLifecycle);

describe("recording", () => {
  it("writes the payload, then the row, and a redelivery is a duplicate that writes nothing", async () => {
    const first = await recordEvent({ db, bucket }, { source: "test", providerId: "evt_a", type: "test.happened", occurredAt: NOW.toISOString(), receivedAt: NOW, payload: '{"v":1}', taint: "full", subjectRef: "usr_1" });
    expect(first).toEqual({ id: "test:evt_a", duplicate: false });
    const row = await db.prepare("SELECT payload_key, taint, subject_ref, routed_at FROM events WHERE id = 'test:evt_a'").first<{ payload_key: string; taint: string; subject_ref: string; routed_at: string | null }>();
    expect(row).toMatchObject({ taint: "full", subject_ref: "usr_1", routed_at: null });
    expect(row?.payload_key.startsWith("events/test/")).toBe(true);
    expect(await (await bucket.get(row?.payload_key ?? ""))?.text()).toBe('{"v":1}');
    const again = await recordEvent({ db, bucket }, { source: "test", providerId: "evt_a", type: "test.happened", occurredAt: NOW.toISOString(), receivedAt: NOW, payload: '{"v":2}', taint: "full" });
    expect(again).toEqual({ id: "test:evt_a", duplicate: true });
    expect(await (await bucket.get(row?.payload_key ?? ""))?.text()).toBe('{"v":1}');
  });

  it("refuses to record without blob storage, and leaves no row", async () => {
    await expect(recordEvent({ db, bucket: null }, { source: "test", providerId: "evt_b", type: "x", occurredAt: NOW.toISOString(), receivedAt: NOW, payload: "{}", taint: "structured" })).rejects.toThrow(/BUCKET/);
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE id = 'test:evt_b'")).toBe(0);
  });
});

describe("routing", () => {
  it("routes once, and a second route of a routed event does nothing", async () => {
    const id = await record();
    const behavior = { calls: [] as string[] };
    expect(await routeEvent(routeContext({}, NOW), routers(behavior), id)).toBe("routed");
    expect(await routeEvent(routeContext({}, NOW), routers(behavior), id)).toBe("already_routed");
    expect(behavior.calls).toHaveLength(1);
    expect(await db.prepare("SELECT routed_at, route_attempts FROM events WHERE id = ?1").bind(id).first()).toEqual({ routed_at: NOW.toISOString(), route_attempts: 1 });
  });

  it("holds an event under a live lease, and takes it back once the lease is 10 minutes stale", async () => {
    const id = await record();
    await db.prepare("UPDATE events SET routing_started_at = ?2, route_attempts = 1 WHERE id = ?1").bind(id, NOW.toISOString()).run();
    const behavior = { calls: [] as string[] };
    expect(await routeEvent(routeContext({}, minutes(9)), routers(behavior), id)).toBe("leased");
    expect(behavior.calls).toHaveLength(0);
    expect(await routeEvent(routeContext({}, minutes(11)), routers(behavior), id)).toBe("routed");
  });

  it("waits while the router's flag is off or unreadable, without spending an attempt", async () => {
    const id = await record();
    const behavior = { calls: [] as string[], flags: ["lifecycle:enabled"] };
    expect(await routeEvent(routeContext({}, NOW), routers(behavior), id)).toBe("disabled");
    const unreadable = { ...routeContext({}, NOW), flags: flagReader({}, ["*"]) };
    expect(await routeEvent(unreadable, routers(behavior), id)).toBe("disabled");
    expect(await db.prepare("SELECT route_attempts FROM events WHERE id = ?1").bind(id).first()).toEqual({ route_attempts: 0 });
    expect(await routeEvent(routeContext({ "lifecycle:enabled": "true" }, NOW), routers(behavior), id)).toBe("routed");
  });

  it("parks an event after 5 failed attempts and audits it; the sweep never picks it up again", async () => {
    const id = await record(uid("evt"), minutes(-60));
    const behavior = { calls: [] as string[], fail: 99 };
    for (let attempt = 1; attempt <= MAX_ROUTE_ATTEMPTS; attempt++) {
      const outcome = await routeEvent(routeContext({}, minutes(attempt * 11)), routers(behavior), id);
      expect(outcome).toBe(attempt < MAX_ROUTE_ATTEMPTS ? "failed" : "parked");
    }
    expect(await routeEvent(routeContext({}, minutes(200)), routers(behavior), id)).toBe("parked");
    expect(behavior.calls).toHaveLength(MAX_ROUTE_ATTEMPTS);
    expect((await db.prepare("SELECT route_error FROM events WHERE id = ?1").bind(id).first<{ route_error: string }>())?.route_error).toMatch(/^parked: router failed/);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'event_parked' AND json_extract(details, '$.id') = ?1", id)).toBe(1);
    expect((await sweepEvents(routeContext({}, minutes(300)), routers(behavior), { limit: 10 })).seen).toBe(0);
  });

  it("counts a missing payload as a failed attempt", async () => {
    const id = await record();
    const key = (await db.prepare("SELECT payload_key FROM events WHERE id = ?1").bind(id).first<{ payload_key: string }>())?.payload_key ?? "";
    await bucket.delete(key);
    expect(await routeEvent(routeContext({}, NOW), routers({ calls: [] }), id)).toBe("failed");
  });
});

describe("the sweep", () => {
  it("routes only unrouted events older than 5 minutes, oldest first, within its limit", async () => {
    const old1 = await record(uid("evt"), minutes(-30));
    const old2 = await record(uid("evt"), minutes(-20));
    const fresh = await record(uid("evt"), minutes(-2));
    const behavior = { calls: [] as string[] };
    const result = await sweepEvents(routeContext({}, NOW), routers(behavior), { limit: 1 });
    expect(result).toEqual({ seen: 1, routed: 1, parked: 0 });
    expect(behavior.calls[0]?.startsWith(old1)).toBe(true);
    await sweepEvents(routeContext({}, NOW), routers(behavior), { limit: 10 });
    expect(behavior.calls.map((c) => c.split(":{")[0])).toEqual([old1, old2]);
    expect((await db.prepare("SELECT routed_at FROM events WHERE id = ?1").bind(fresh).first())?.routed_at).toBeNull();
  });
});

describe("the queue consumer", () => {
  it("acknowledges what is settled and retries only a failed attempt", async () => {
    const good = await record();
    const failing = await record();
    const consumer = createEventConsumer<Env>({
      routers: () => ({
        test: {
          flags: [],
          async route(event) {
            if (event.id === failing) throw new Error("not yet");
            return {};
          },
        },
      }),
      flags: () => flagReader({}),
      log: silentLogger,
      now: () => NOW,
    });
    const batch = createMessageBatch("gtm-events", [
      { id: "m1", timestamp: NOW, attempts: 1, body: { id: good } },
      { id: "m2", timestamp: NOW, attempts: 1, body: { id: failing } },
      { id: "m3", timestamp: NOW, attempts: 1, body: { updateId: "u1", chatId: "c1", id: "x" } },
    ]);
    const ctx = createExecutionContext();
    await consumer(batch, env as unknown as Env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m1", "m3"]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(isEventMessage({ id: "product:evt" })).toBe(true);
    expect(isEventMessage({ id: "x", updateId: "u" })).toBe(false);
  });
});

describe("payload retention", () => {
  it("deletes payloads of events routed more than 90 days ago and keeps the rows", async () => {
    const old = await record(uid("evt"), new Date("2026-06-01T00:00:00.000Z"));
    const recent = await record(uid("evt"), new Date("2026-10-01T00:00:00.000Z"));
    const unrouted = await record(uid("evt"), new Date("2026-06-01T00:00:00.000Z"));
    await db.batch([
      db.prepare("UPDATE events SET routed_at = '2026-06-01T00:10:00.000Z' WHERE id = ?1").bind(old),
      db.prepare("UPDATE events SET routed_at = '2026-10-01T00:10:00.000Z' WHERE id = ?1").bind(recent),
    ]);
    const keyOf = async (id: string) => (await db.prepare("SELECT payload_key FROM events WHERE id = ?1").bind(id).first<{ payload_key: string | null }>())?.payload_key ?? null;
    const oldKey = await keyOf(old);
    expect(await purgeRoutedPayloads({ db, bucket }, { now: NOW, days: 90, limit: 100 })).toBe(1);
    expect(await keyOf(old)).toBeNull();
    expect(await bucket.get(oldKey ?? "")).toBeNull();
    expect(await keyOf(recent)).not.toBeNull();
    expect(await keyOf(unrouted)).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE id IN (?1, ?2, ?3)", old, recent, unrouted)).toBe(3);
  });
});
