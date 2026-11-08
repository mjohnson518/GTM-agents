// GTM-agents: tests for the intake gate in front of follow-ups: a step goes out only while replies
// are being recorded.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { FlagReader } from "../src/jobs/registry.ts";
import { POLL_LISTED_MARK } from "../src/inbox/jobs.ts";
import { checkReplyIntake } from "../src/sequences/intake.ts";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const flags = (values: Record<string, string>): FlagReader => ({ get: (key) => Promise.resolve(values[key] ?? null) });
const reasonOf = (verdict: Awaited<ReturnType<typeof checkReplyIntake>>): string => (verdict.ok ? "passed" : verdict.reason);
const failing: FlagReader = { get: () => Promise.reject(new Error("flag store unavailable")) };

async function poll(status: string, minutesAgo: number, id = `poll-${status}-${minutesAgo}`, summary: string | null = status === "completed" ? `${POLL_LISTED_MARK} pages 1, recorded 0` : null): Promise<void> {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, finished_at, summary) VALUES (?1, 'inbox_poll', 'cron', ?2, ?3, ?4, ?5)")
    .bind(id, status, at, status === "running" ? null : at, summary)
    .run();
}

describe("checkReplyIntake", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM execution_runs WHERE task_name = 'inbox_poll'").run();
  });

  it("passes poll intake when the latest poll completed within ten minutes", async () => {
    await poll("completed", 3);
    expect(await checkReplyIntake(env.DB, flags({ "inbox:enabled": "true" }), NOW)).toEqual({ ok: true });
  });

  it("holds poll intake when the latest poll is stale, failed, skipped or missing", async () => {
    const on = flags({ "inbox:enabled": "true" });
    expect((await checkReplyIntake(env.DB, on, NOW)).ok).toBe(false);
    await poll("completed", 30);
    expect(reasonOf(await checkReplyIntake(env.DB, on, NOW))).toMatch(/more than 10 minutes/);
    await poll("completed", 20, "older-good");
    await poll("skipped", 1);
    expect(reasonOf(await checkReplyIntake(env.DB, on, NOW))).toMatch(/skipped/);
    await poll("failed", 0);
    expect(reasonOf(await checkReplyIntake(env.DB, on, NOW))).toMatch(/failed/);
  });

  it("holds when the latest poll completed without listing the mailbox", async () => {
    const on = flags({ "inbox:enabled": "true" });
    await poll("completed", 2, "no-mailbox", "no mailbox to poll; pending 0/0");
    expect(reasonOf(await checkReplyIntake(env.DB, on, NOW))).toMatch(/did not list the mailbox/);
    await poll("completed", 1, "unsupported", "listing unsupported; pages 0, recorded 0");
    expect((await checkReplyIntake(env.DB, on, NOW)).ok).toBe(false);
  });

  it("judges by the newest finished poll, so one still running neither holds nor passes the sweep", async () => {
    const on = flags({ "inbox:enabled": "true" });
    await poll("completed", 2);
    await poll("running", 0);
    expect(await checkReplyIntake(env.DB, on, NOW)).toEqual({ ok: true });
  });

  it("needs inbox:enabled in every mode", async () => {
    await poll("completed", 1);
    expect((await checkReplyIntake(env.DB, flags({}), NOW)).ok).toBe(false);
    expect((await checkReplyIntake(env.DB, flags({ "inbox:enabled": "false", "sequences:reply_intake": "routed" }), NOW)).ok).toBe(false);
  });

  it("passes routed intake on inbox:enabled alone, and refuses an unknown mode", async () => {
    expect(await checkReplyIntake(env.DB, flags({ "inbox:enabled": "true", "sequences:reply_intake": "routed" }), NOW)).toEqual({ ok: true });
    expect((await checkReplyIntake(env.DB, flags({ "inbox:enabled": "true", "sequences:reply_intake": "anything" }), NOW)).ok).toBe(false);
  });

  it("fails closed when the flags cannot be read", async () => {
    await poll("completed", 1);
    expect((await checkReplyIntake(env.DB, failing, NOW)).ok).toBe(false);
  });
});
