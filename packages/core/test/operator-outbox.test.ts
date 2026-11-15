// GTM-agents: the operator outbox: quiet hours (including windows that cross midnight), what the
// wrapped channel does with replies, pages, notices and approvals, the hourly limit, retries, never
// losing a notice to its own failures, the operator_outbox job (folding, quiet hours, the flag off,
// failures, stale and old rows), /outbox, and a chat reply that is never held.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { sessionKeyFor } from "../src/agents/sessions.ts";
import { defineConfig } from "../src/config/index.ts";
import type { ChatMessage, Env } from "../src/env.ts";
import { findFlag } from "../src/flags/registry.ts";
import type { JobContext } from "../src/jobs/registry.ts";
import { processChatRun } from "../src/operator/chat.ts";
import { runCommand } from "../src/operator/commands.ts";
import {
  OUTBOX_FOLD_MAX_CHARS,
  OUTBOX_JOB,
  createOperatorOutboxJobs,
  deliverHeldNotices,
  isHeldMessageId,
  noticesSentThisHour,
  quietHoursEnd,
  unwrapOutbox,
  withOperatorOutbox,
  type QuietHours,
} from "../src/operator/outbox.ts";
import { AdapterError } from "../src/ports/types.ts";
import type { OperatorChannel } from "../src/ports/operator.ts";
import { acmeConfig } from "./fixtures.ts";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const NIGHT: QuietHours = { start: 22, end: 7, timeZone: "UTC" };
/** 23:00 UTC on 2026-11-14, inside NIGHT; quiet hours end at 07:00 the next morning. */
const LATE = new Date("2026-11-14T23:00:00.000Z");
const MORNING = new Date("2026-11-15T07:00:00.000Z");
/** 12:20 UTC, outside NIGHT. */
const NOON = new Date("2026-11-14T12:20:00.000Z");
const ON = { "operator:outbox_enabled": "true" };

interface Row {
  id: string;
  chat_id: string | null;
  kind: string;
  text: string | null;
  silent: number;
  status: string;
  reason: string | null;
  release_at: string | null;
  attempts: number;
  delivery_id: string | null;
}
const rows = async () => (await env.DB.prepare("SELECT * FROM operator_outbox ORDER BY created_at, id").all<Row>()).results ?? [];

function world(flags: Record<string, string> = ON, at: Date = NOON, quietHours: QuietHours | undefined = NIGHT) {
  const kv = memoryKv(flags);
  const op = recordingOperator();
  const clock = { now: at };
  const channel = withOperatorOutbox(op.channel, { db: env.DB, flags: { get: (k) => kv.get(k) }, quietHours, now: () => clock.now, log: quiet });
  return { kv, op, channel, clock };
}

function failing(error: Error): OperatorChannel {
  const op = recordingOperator();
  return { ...op.channel, notify: () => Promise.reject(error) };
}

async function hold(text: string, opts: { chatId?: string; at?: Date; kind?: "page" | "notice"; reason?: string; releaseAt?: Date; silent?: boolean } = {}): Promise<string> {
  const id = `ob_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const at = (opts.at ?? new Date("2026-11-14T22:30:00.000Z")).toISOString();
  await env.DB.prepare(
    "INSERT INTO operator_outbox (id, chat_id, kind, text, silent, status, reason, release_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'held', ?6, ?7, ?8, ?8)",
  )
    .bind(id, opts.chatId ?? null, opts.kind ?? "notice", text, opts.silent ? 1 : 0, opts.reason ?? "quiet_hours", (opts.releaseAt ?? MORNING).toISOString(), at)
    .run();
  return id;
}

function job(now: Date, channel: OperatorChannel | undefined, flags: Record<string, string> = ON, quietHours: QuietHours | undefined = NIGHT, maxRows = 50) {
  const kv = memoryKv(flags);
  const config = defineConfig({ ...acmeConfig, operator: { ...acmeConfig.operator, ...(quietHours ? { quietHours } : {}) } });
  const ctx: JobContext<Env> = { env: env as unknown as Env, config, job: OUTBOX_JOB, now, signal: new AbortController().signal, ceilings: { maxDurationMs: 60_000, maxRows }, flags: { get: (k) => kv.get(k) }, log: quiet };
  return deliverHeldNotices(ctx, channel);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM operator_outbox").run();
});

describe("quiet hours", () => {
  it("cover a window that crosses midnight, in the operator's own time zone", () => {
    const ny: QuietHours = { start: 22, end: 7, timeZone: "America/New_York" };
    // 22:00 New York (EST) on the 13th is 03:00 UTC on the 14th; they end at 07:00 EST, 12:00 UTC.
    expect(quietHoursEnd(new Date("2026-11-14T03:00:00Z"), ny)?.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(quietHoursEnd(new Date("2026-11-14T11:59:00Z"), ny)?.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(quietHoursEnd(new Date("2026-11-14T12:00:00Z"), ny)).toBeNull();
    expect(quietHoursEnd(new Date("2026-11-14T02:59:00Z"), ny)).toBeNull();
    expect(quietHoursEnd(new Date("2026-11-14T03:30:00Z"), { start: 1, end: 6, timeZone: "UTC" })?.toISOString()).toBe("2026-11-14T06:00:00.000Z");
    expect(quietHoursEnd(new Date("2026-11-14T23:10:00Z"), { start: 22, end: 0, timeZone: "UTC" })?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    // Quiet hours that end at 02:00 on the night New York skips it end when the clocks show 03:00.
    expect(quietHoursEnd(new Date("2027-03-14T06:30:00Z"), { start: 22, end: 2, timeZone: "America/New_York" })?.toISOString()).toBe("2027-03-14T07:00:00.000Z");
  });

  it("are validated with the config: a known time zone, and a start that differs from the end", () => {
    const withQuiet = (quietHours: unknown) => () => defineConfig({ ...acmeConfig, operator: { ...acmeConfig.operator, quietHours } } as Parameters<typeof defineConfig>[0]);
    expect(withQuiet({ start: 22, end: 7, timeZone: "Europe/Berlin" })).not.toThrow();
    expect(withQuiet({ start: 22, end: 7, timeZone: "Mars/Olympus" })).toThrow(/IANA time zone/);
    expect(withQuiet({ start: 7, end: 7, timeZone: "UTC" })).toThrow(/must differ/);
  });
});

describe("the outbox around the channel", () => {
  it("is behind operator:outbox_enabled, registered and off by default, and passes everything through while off or unreadable", async () => {
    expect(findFlag("operator:outbox_enabled")).toMatchObject({ kind: "boolean", default: "false" });
    expect(findFlag("operator:outbox_hourly_max")).toMatchObject({ kind: "number", default: "12" });
    const off = world({}, LATE);
    expect(await off.channel.notify({ text: "Scorecard" })).toEqual({ messageId: "m1" });
    const broken = world(ON, LATE);
    broken.kv.failing = true;
    await broken.channel.notify({ text: "Funnel digest" });
    expect([...off.op.messages, ...broken.op.messages].map((m) => m.text)).toEqual(["Scorecard", "Funnel digest"]);
    expect(await rows()).toEqual([]);
  });

  it("never holds a reply to the operator, in quiet hours or over the limit", async () => {
    const w = world({ ...ON, "operator:outbox_hourly_max": "0" }, LATE);
    await w.channel.notify({ text: "Here is the summary you asked for.", chatId: "42", kind: "reply" });
    expect(w.op.messages).toEqual([{ text: "Here is the summary you asked for.", chatId: "42", kind: "reply" }]);
    expect(await rows()).toEqual([]);
  });

  it("holds a notice in quiet hours, and delivers a page and an approval request at once, silently", async () => {
    const w = world(ON, LATE);
    const held = await w.channel.notify({ text: "Scorecard for today" });
    expect(held.messageId).toMatch(/^outbox:ob_[0-9a-f]{16}$/);
    expect(isHeldMessageId(held.messageId)).toBe(true);
    expect(isHeldMessageId("m1")).toBe(false);
    await w.channel.notify({ text: "Job failed: inbox_poll", kind: "page" });
    await w.channel.requestApproval({ approvalId: "dr_1", kind: "send", digest: "a".repeat(64), summary: "Approve?", preview: "Hi", actions: ["approve"] });
    expect(w.op.messages).toEqual([{ text: "Job failed: inbox_poll", kind: "page", silent: true }]);
    expect(w.op.approvals[0]?.silent).toBe(true);
    expect(await rows()).toMatchObject([{ id: held.messageId.slice("outbox:".length), kind: "notice", text: "Scorecard for today", status: "held", reason: "quiet_hours", release_at: MORNING.toISOString() }]);

    // Outside quiet hours an approval request is not silenced.
    w.clock.now = NOON;
    await w.channel.requestApproval({ approvalId: "dr_2", kind: "send", digest: "b".repeat(64), summary: "Approve?", preview: "Hi", actions: ["approve"] });
    expect(w.op.approvals[1]).not.toHaveProperty("silent");
  });

  it("delivers up to the hourly limit per chat, then holds notices until the next hour", async () => {
    // An hourly limit that is not a whole number counts as the default, 12: it only paces notices.
    const loose = world({ ...ON, "operator:outbox_hourly_max": "lots" });
    for (let i = 0; i < 12; i += 1) await loose.channel.notify({ text: `n${i}`, chatId: "41" });
    await loose.channel.notify({ text: "thirteenth", chatId: "41" });
    expect(loose.op.messages).toHaveLength(12);
    await env.DB.prepare("DELETE FROM operator_outbox").run();
    const w = world({ ...ON, "operator:outbox_hourly_max": "2" });
    for (const text of ["one", "two", "three"]) await w.channel.notify({ text, chatId: "42" });
    await w.channel.notify({ text: "other chat", chatId: "43" });
    expect(w.op.messages.map((m) => m.text)).toEqual(["one", "two", "other chat"]);
    expect(await noticesSentThisHour(env.DB, "42", NOON)).toBe(2);
    const held = (await rows()).filter((r) => r.status === "held");
    expect(held).toMatchObject([{ text: "three", chat_id: "42", reason: "hourly_cap", release_at: "2026-11-14T13:00:00.000Z" }]);
    // Sent notices leave no text behind.
    expect((await rows()).filter((r) => r.status === "sent").every((r) => r.text === null)).toBe(true);
  });

  it("never holds a message with buttons, which the table cannot keep", async () => {
    const w = world(ON, LATE);
    await w.channel.notify({ text: "Pick one", buttons: [[{ label: "A", action: "pick", payload: "a" }]] });
    expect(w.op.messages.map((m) => m.text)).toEqual(["Pick one"]);
  });

  it("keeps a notice or page the channel refused with a retryable error, and throws any other error", async () => {
    const deps = { db: env.DB, flags: { get: (k: string) => memoryKv(ON).get(k) }, quietHours: NIGHT, now: () => NOON, log: quiet };
    const limited = withOperatorOutbox(failing(new AdapterError("telegram sendMessage failed with 429", "rate_limited", true, { retryAfterMs: 30_000 })), deps);
    expect((await limited.notify({ text: "Batch ready", chatId: "42" })).messageId).toMatch(/^outbox:/);
    await limited.notify({ text: "Job failed: sweep", kind: "page" });
    expect((await rows()).sort((a, b) => (a.text ?? "").localeCompare(b.text ?? ""))).toMatchObject([
      { text: "Batch ready", kind: "notice", reason: "channel_error", attempts: 1, release_at: "2026-11-14T12:25:00.000Z" },
      { text: "Job failed: sweep", kind: "page", reason: "channel_error" },
    ]);
    await env.DB.prepare("DELETE FROM operator_outbox").run();
    await expect(withOperatorOutbox(failing(new AdapterError("no chat to deliver to", "invalid", false)), deps).notify({ text: "x" })).rejects.toThrow(/no chat/);
    await expect(withOperatorOutbox(failing(new Error("boom")), deps).notify({ text: "x" })).rejects.toThrow("boom");
    expect(await rows()).toEqual([]);
  });

  it("delivers a notice at once when it cannot be held, so the outbox never loses one", async () => {
    const broken = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("operator_outbox")) throw new Error("outbox unavailable");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const op = recordingOperator();
    const kv = memoryKv({ ...ON, "operator:outbox_hourly_max": "0" });
    const channel = withOperatorOutbox(op.channel, { db: broken, flags: { get: (k) => kv.get(k) }, quietHours: NIGHT, now: () => LATE, log: quiet });
    await channel.notify({ text: "Held overnight, normally" });
    expect(op.messages.map((m) => m.text)).toEqual(["Held overnight, normally"]);
  });

  it("wraps a channel only once, and unwraps to the channel itself", () => {
    const op = recordingOperator();
    const deps = { db: env.DB, flags: { get: () => Promise.resolve(null) } };
    const once = withOperatorOutbox(op.channel, deps);
    const twice = withOperatorOutbox(once, deps);
    expect(unwrapOutbox(once)).toBe(op.channel);
    expect(unwrapOutbox(twice)).toBe(op.channel);
    expect(unwrapOutbox(op.channel)).toBe(op.channel);
  });
});

describe("the operator_outbox job", () => {
  it("is every five minutes with no flag, so notices held while the outbox was on still go out", () => {
    const [definition] = createOperatorOutboxJobs<Env>({ operator: () => undefined });
    expect(definition).toMatchObject({ name: "operator_outbox", schedule: "*/5 * * * *", ceilings: { maxDurationMs: 60_000, maxRows: 50 } });
    expect(definition?.flag).toBeUndefined();
  });

  it("delivers due notices folded per chat, oldest first, as one message each, and leaves the rest", async () => {
    const first = await hold("Scorecard: 4 replies", { at: new Date("2026-11-14T22:10:00Z") });
    await hold("Funnel digest", { at: new Date("2026-11-14T23:40:00Z") });
    await hold("Sequence sweep: 3 due", { chatId: "42" });
    await hold("Later", { releaseAt: new Date("2026-11-15T09:00:00Z") });
    const op = recordingOperator();
    const result = await job(MORNING, op.channel);
    expect(result).toMatchObject({ rows: 3 });
    expect(op.messages).toEqual([
      { text: "2 notices held during quiet hours, oldest first:\n\n[2026-11-14 22:10 UTC]\nScorecard: 4 replies\n\n[2026-11-14 23:40 UTC]\nFunnel digest" },
      { text: "[Held from 2026-11-14 22:30 UTC]\nSequence sweep: 3 due", chatId: "42" },
    ]);
    const after = await rows();
    expect(after.filter((r) => r.status === "held").map((r) => r.text)).toEqual(["Later"]);
    expect(after.find((r) => r.id === first)).toMatchObject({ status: "sent", text: null });
    // Two notices folded into one message count once toward the hourly limit.
    expect(await noticesSentThisHour(env.DB, undefined, MORNING)).toBe(1);
  });

  it("in quiet hours delivers only pages, silently, and notices the operator released", async () => {
    await hold("Scorecard", { releaseAt: new Date("2026-11-14T23:00:00Z"), reason: "hourly_cap" });
    await hold("Job failed: inbox_poll", { kind: "page", reason: "channel_error", releaseAt: LATE });
    const op = recordingOperator();
    await job(LATE, op.channel);
    expect(op.messages).toEqual([{ text: "Job failed: inbox_poll", silent: true }]);
    // The due notice now waits for the morning.
    expect((await rows()).find((r) => r.text === "Scorecard")).toMatchObject({ status: "held", release_at: MORNING.toISOString() });

    expect(await runCommand({ db: env.DB, agentName: "Avery", strategistModel: undefined, now: () => LATE }, { name: "outbox", args: "send" }, { sessionKey: "chat:1", chatId: "1" })).toBe(
      "Released 1 held notice. They arrive together with the next outbox run, within five minutes on the default schedule.",
    );
    await job(new Date(LATE.getTime() + 300_000), op.channel);
    expect(op.messages.at(-1)).toEqual({ text: "[Held from 2026-11-14 22:30 UTC]\nScorecard", silent: true });
  });

  it("delivers everything held at once while the outbox is off", async () => {
    await hold("Scorecard", { releaseAt: new Date("2026-11-15T07:00:00Z") });
    const op = recordingOperator();
    expect(await job(LATE, op.channel, {})).toMatchObject({ rows: 1 });
    expect(op.messages).toEqual([{ text: "[Held from 2026-11-14 22:30 UTC]\nScorecard" }]);
  });

  it("delivers through the channel itself when given the wrapped one, so nothing is held twice", async () => {
    await hold("Released overnight", { reason: "released", releaseAt: LATE });
    const op = recordingOperator();
    const wrapped = withOperatorOutbox(op.channel, { db: env.DB, flags: { get: (k) => memoryKv(ON).get(k) }, quietHours: NIGHT, now: () => LATE });
    await job(LATE, wrapped);
    expect(op.messages.map((m) => m.text)).toEqual(["[Held from 2026-11-14 22:30 UTC]\nReleased overnight"]);
    expect((await rows()).filter((r) => r.status === "held")).toEqual([]);
  });

  it("splits a chat's notices into messages that fit", async () => {
    const big = "x".repeat(OUTBOX_FOLD_MAX_CHARS - 100);
    await hold(big, { at: new Date("2026-11-14T22:10:00Z") });
    await hold(big, { at: new Date("2026-11-14T22:20:00Z") });
    const op = recordingOperator();
    await job(MORNING, op.channel);
    expect(op.messages).toHaveLength(2);
  });

  it("tries a refused delivery again with backoff, stops the run, and drops notices a day old", async () => {
    await hold("Fresh", { chatId: "42", at: new Date("2026-11-15T06:00:00Z") });
    await hold("Other chat", { chatId: "43", at: new Date("2026-11-15T06:01:00Z") });
    const down = failing(new AdapterError("telegram sendMessage failed with 503", "unavailable", true));
    const result = await job(MORNING, down);
    expect(result.summary).toContain("retried=1");
    const [fresh, other] = await rows();
    expect(fresh).toMatchObject({ status: "held", reason: "channel_error", attempts: 1, release_at: "2026-11-15T07:05:00.000Z", delivery_id: null });
    // The channel is down, so the other chat's notice was not tried in this run.
    expect(other).toMatchObject({ status: "held", attempts: 0 });

    await env.DB.prepare("DELETE FROM operator_outbox").run();
    await hold("Stale", { at: new Date("2026-11-14T06:00:00Z") });
    expect((await job(MORNING, down)).summary).toContain("dropped=1");
    expect(await rows()).toMatchObject([{ status: "dropped", text: null }]);

    // A page is kept for a week, not a day.
    await env.DB.prepare("DELETE FROM operator_outbox").run();
    await hold("Job failed: inbox_poll", { kind: "page", reason: "channel_error", at: new Date("2026-11-14T06:00:00Z") });
    await hold("Older page", { kind: "page", reason: "channel_error", at: new Date("2026-11-07T06:00:00Z") });
    expect((await job(MORNING, failing(new AdapterError("bot was blocked", "auth", false)))).summary).toContain("dropped=1");
    expect((await rows()).map((r) => [r.text, r.status])).toEqual([
      [null, "dropped"],
      ["Job failed: inbox_poll", "held"],
    ]);
  });

  it("keeps quiet hours while the flag cannot be read, instead of draining everything", async () => {
    await hold("Scorecard", { releaseAt: MORNING });
    const op = recordingOperator();
    const config = defineConfig({ ...acmeConfig, operator: { ...acmeConfig.operator, quietHours: NIGHT } });
    const ctx: JobContext<Env> = { env: env as unknown as Env, config, job: OUTBOX_JOB, now: LATE, signal: new AbortController().signal, ceilings: { maxDurationMs: 60_000, maxRows: 50 }, flags: { get: () => Promise.reject(new Error("kv unavailable")) }, log: quiet };
    expect((await deliverHeldNotices(ctx, op.channel)).summary).toContain("flag unreadable");
    expect(op.messages).toEqual([]);
  });

  it("reports a missing table while the outbox is off, so a deployment that never migrated is not paged", async () => {
    const missing = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") return () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1_ERROR: no such table: operator_outbox")) }) });
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const run = (flags: Record<string, string>) => {
      const kv = memoryKv(flags);
      const ctx: JobContext<Env> = { env: { ...(env as unknown as Env), DB: missing }, config: defineConfig(acmeConfig), job: OUTBOX_JOB, now: NOON, signal: new AbortController().signal, ceilings: { maxDurationMs: 60_000, maxRows: 50 }, flags: { get: (k) => kv.get(k) }, log: quiet };
      return deliverHeldNotices(ctx, recordingOperator().channel);
    };
    expect((await run({})).summary).toContain("apply migration 0033");
    await expect(run(ON)).rejects.toThrow(/no such table/);
  });

  it("tries rows a stopped run left sending again, and deletes sent rows after two days", async () => {
    const stuck = await hold("Stuck", { releaseAt: new Date("2026-11-15T06:00:00Z") });
    await env.DB.prepare("UPDATE operator_outbox SET status = 'sending', delivery_id = 'ob_gone', updated_at = '2026-11-15T06:30:00.000Z' WHERE id = ?1").bind(stuck).run();
    await env.DB.prepare("INSERT INTO operator_outbox (id, kind, status, delivery_id, sent_at, created_at, updated_at) VALUES ('ob_old', 'notice', 'sent', 'ob_old', '2026-11-12T07:00:00.000Z', '2026-11-12T07:00:00.000Z', '2026-11-12T07:00:00.000Z')").run();
    const op = recordingOperator();
    const result = await job(MORNING, op.channel);
    expect(op.messages.map((m) => m.text)).toEqual(["[Held from 2026-11-14 22:30 UTC]\nStuck"]);
    expect(result.summary).toContain("pruned=1");
    expect((await rows()).map((r) => r.id)).toEqual([stuck]);
  });
});

describe("/outbox", () => {
  const command = (args: string, flags: Record<string, string> = ON, quietHours: QuietHours | null = NIGHT, at: Date = LATE) => {
    const kv = memoryKv(flags);
    return runCommand({ db: env.DB, agentName: "Avery", strategistModel: undefined, flags: { get: (k) => kv.get(k) }, quietHours: quietHours ?? undefined, now: () => at }, { name: "outbox", args }, { sessionKey: "chat:1", chatId: "1" });
  };

  it("lists the held notices with why each waits, and says when the outbox is off", async () => {
    expect(await command("")).toBe("Quiet hours: 22:00 to 07:00 UTC, and it is quiet now.\nNo notices are held.");
    const id = await hold("Scorecard for today\nwith more lines");
    const text = await command("");
    expect(text).toContain("Held notices, oldest first (1):");
    expect(text).toContain(`${id}  quiet hours, due 2026-11-15 07:00 UTC: Scorecard for today`);
    expect(await command("", {})).toContain("The outbox is off (operator:outbox_enabled)");
    expect(await command("", ON, null)).toContain("No quiet hours are set");
    expect(await command("later")).toContain("/outbox send");
  });
});

describe("a chat reply", () => {
  it("reaches the operator at once through the outbox, even in quiet hours", async () => {
    const kv = memoryKv({ ...ON, "operator:agent_enabled": "true", "operator:outbox_hourly_max": "0" });
    const op = recordingOperator();
    const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["77"], allowedUserIds: ["77"], quietHours: NIGHT } });
    const testEnv = { ...(env as unknown as Env), KV: kv as unknown as KVNamespace };
    const channel = withOperatorOutbox(op.channel, { db: env.DB, flags: { get: (k) => kv.get(k) }, quietHours: NIGHT, now: () => LATE });
    const message: ChatMessage = { updateId: "u-outbox-1", chatId: "77", userId: "77", sessionKey: sessionKeyFor("77"), text: "/outbox" };
    await processChatRun({ config, operator: () => channel, now: () => LATE }, testEnv, [message]);
    expect(op.messages).toHaveLength(1);
    expect(op.messages[0]).toMatchObject({ chatId: "77", kind: "reply" });
    expect(op.messages[0]?.text).toContain("No notices are held.");
    expect(await rows()).toEqual([]);
  });
});
