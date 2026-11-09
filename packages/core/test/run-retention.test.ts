// GTM-agents: tests for run-row retention: what it deletes, the newest row of each job and status it
// always keeps (the cron health check and the follow-up intake gate read them), the tables it never
// touches, its row ceiling and abort, and the job behind ops:retention_enabled. Every row is
// synthetic. All tests share one clock, so a row one test keeps never becomes deletable in another.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findFlag } from "../src/flags/registry.ts";
import { POLL_LISTED_MARK } from "../src/inbox/jobs.ts";
import { createJobRegistry, defineJob, type FlagReader, type JobContext } from "../src/jobs/registry.ts";
import { checkCronHealth } from "../src/runtime/cron-health.ts";
import { RUN_RETENTION_FLAG, RUN_RETENTION_JOB, createRetentionJob, pruneRunRows } from "../src/runtime/retention.ts";
import { checkReplyIntake } from "../src/sequences/intake.ts";
import { acmeConfig } from "./fixtures.ts";
import { defineConfig } from "../src/config/index.ts";
import { uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const NOW = new Date("2019-06-30T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };
/** A unique job name the registry accepts (snake_case). */
const jobName = (base: string) => uid(base).replace(/-/g, "_");

async function run(task: string, status: string, startedAt: string, summary: string | null = null): Promise<string> {
  const id = uid("run");
  await db
    .prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, finished_at, summary, created_at) VALUES (?1, ?2, 'cron', ?3, ?4, ?5, ?6, ?4)")
    .bind(id, task, status, startedAt, status === "running" ? null : startedAt, summary)
    .run();
  return id;
}

async function left(task: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT status, started_at FROM execution_runs WHERE task_name = ?1 ORDER BY started_at DESC").bind(task).all<{ status: string; started_at: string }>();
  return results.map((r) => `${r.status} ${Math.round((NOW.getTime() - Date.parse(r.started_at)) / DAY)}d`);
}

describe("pruning run rows", () => {
  it("deletes skipped rows after 7 days, completed after 30 and failed after 90, and never a running row", async () => {
    const busy = uid("busy_job");
    for (const d of [1, 6, 8, 20]) await run(busy, "skipped", ago(d));
    for (const d of [2, 29, 31, 45]) await run(busy, "completed", ago(d));
    for (const d of [10, 89, 91, 120]) await run(busy, "failed", ago(d));
    await run(busy, "running", ago(200));
    const result = await pruneRunRows(db, { now: NOW, maxRows: 1_000 });
    expect(result.complete).toBe(true);
    expect(result.deleted.skipped + result.deleted.completed + result.deleted.failed).toBe(result.total);
    expect(result.total).toBeGreaterThanOrEqual(6);
    expect(await left(busy)).toEqual(["skipped 1d", "completed 2d", "skipped 6d", "failed 10d", "completed 29d", "failed 89d", "running 200d"]);
  });

  it("always keeps the newest row of each job and status, however old", async () => {
    const rare = uid("rare_job");
    await run(rare, "skipped", ago(15));
    await run(rare, "completed", ago(40));
    await run(rare, "completed", ago(70));
    await run(rare, "failed", ago(100));
    await run(rare, "failed", ago(150));
    await pruneRunRows(db, { now: NOW, maxRows: 1_000 });
    expect(await left(rare)).toEqual(["skipped 15d", "completed 40d", "failed 100d"]);
    // What is left is all newest rows, so the next pass finds nothing to do for this job.
    expect(await pruneRunRows(db, { now: NOW, maxRows: 1_000 })).toMatchObject({ total: 0, complete: true });
  });

  it("leaves the cron health check reading the same verdict for a job that fires once a year", async () => {
    const yearly = jobName("yearly_job");
    const held = jobName("yearly_held");
    // The last expected fire was March 15, 107 days before NOW: older than any retention period.
    await run(yearly, "completed", "2019-03-15T09:00:02.000Z");
    await run(yearly, "completed", "2018-03-15T09:00:02.000Z");
    await run(held, "skipped", "2019-03-15T09:00:02.000Z", "flag off");
    await run(held, "skipped", "2018-03-15T09:00:02.000Z", "flag off");
    const job = (name: string) => defineJob({ name, schedule: "0 9 15 3 *", critical: true, rerunnable: true, ceilings: { maxDurationMs: 60_000 }, run: async () => {} });
    const registry = createJobRegistry([job(yearly), job(held)]);
    const before = await checkCronHealth({ registry, db, now: NOW });
    await pruneRunRows(db, { now: NOW, maxRows: 1_000 });
    const after = await checkCronHealth({ registry, db, now: NOW });
    expect(after.map((f) => [f.job, f.status])).toEqual([
      [yearly, "ok"],
      [held, "skipped"],
    ]);
    expect(after).toEqual(before);
    expect(await left(yearly)).toEqual(["completed 107d"]);
  });

  it("leaves the follow-up intake gate reading the same newest inbox_poll run", async () => {
    await db.prepare("DELETE FROM execution_runs WHERE task_name = 'inbox_poll'").run();
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    for (const d of [40, 60]) await run("inbox_poll", "completed", ago(d), `${POLL_LISTED_MARK} pages 1, recorded 0`);
    for (const d of [8, 9]) await run("inbox_poll", "skipped", ago(d), "flag off");
    await run("inbox_poll", "failed", ago(95));
    await run("inbox_poll", "completed", minutesAgo(3), `${POLL_LISTED_MARK} pages 1, recorded 0`);
    await run("inbox_poll", "running", minutesAgo(1));
    const on: FlagReader = { get: (key) => Promise.resolve(key === "inbox:enabled" ? "true" : null) };
    expect(await checkReplyIntake(db, on, NOW)).toEqual({ ok: true });
    await pruneRunRows(db, { now: NOW, maxRows: 1_000 });
    expect(await checkReplyIntake(db, on, NOW)).toEqual({ ok: true });
    expect(await left("inbox_poll")).toEqual(["running 0d", "completed 0d", "skipped 8d", "failed 95d"]);
  });

  it("never touches idempotency claims or the cost ledger", async () => {
    const task = uid("ledger_job");
    const old = ago(400);
    await run(task, "completed", old);
    await run(task, "completed", ago(1));
    const event = uid("evt");
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, 'retention_probe', ?2)").bind(event, old).run();
    await db.prepare("INSERT INTO cost_events (provider, capability, cost_micro_cents, job, created_at) VALUES ('probe', 'call', 1, ?1, ?2)").bind(task, old).run();
    await pruneRunRows(db, { now: NOW, maxRows: 1_000 });
    expect(await left(task)).toEqual(["completed 1d"]);
    expect(await db.prepare("SELECT 1 AS hit FROM event_effects WHERE event_id = ?1").bind(event).first()).toEqual({ hit: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM cost_events WHERE job = ?1").bind(task).first()).toEqual({ n: 1 });
  });

  it("stops at its row ceiling and when aborted, and the next pass carries on", async () => {
    const backlog = uid("backlog_job");
    await run(backlog, "skipped", ago(1));
    for (let d = 10; d < 17; d++) await run(backlog, "skipped", ago(d));
    const aborted = new AbortController();
    aborted.abort();
    expect(await pruneRunRows(db, { now: NOW, maxRows: 1_000, signal: aborted.signal })).toMatchObject({ total: 0, complete: false });
    const first = await pruneRunRows(db, { now: NOW, maxRows: 3, batchRows: 2 });
    expect(first).toMatchObject({ total: 3, complete: false, deleted: { skipped: 3 } });
    expect(await left(backlog)).toHaveLength(5);
    const second = await pruneRunRows(db, { now: NOW, maxRows: 1_000, batchRows: 2 });
    expect(second).toMatchObject({ total: 4, complete: true });
    expect(await left(backlog)).toEqual(["skipped 1d"]);
  });
});

describe("the run_retention job", () => {
  const config = defineConfig(acmeConfig);
  const context = (flags: FlagReader, maxRows = 1_000): JobContext<{ DB: D1Database }> => ({
    env: { DB: db },
    config,
    job: RUN_RETENTION_JOB,
    now: NOW,
    signal: new AbortController().signal,
    ceilings: { maxDurationMs: 120_000, maxRows },
    flags,
    log: quietLog,
  });

  it("is registered off by default, runs daily with ceilings, and is safe to rerun", () => {
    const job = createRetentionJob();
    expect(findFlag(RUN_RETENTION_FLAG)).toMatchObject({ kind: "boolean", default: "false" });
    expect(job).toMatchObject({ name: RUN_RETENTION_JOB, schedule: "40 3 * * *", flag: RUN_RETENTION_FLAG, rerunnable: true });
    expect(job.ceilings).toEqual({ maxDurationMs: 120_000, maxRows: 20_000 });
    expect(job.critical).toBeUndefined();
  });

  it("deletes nothing while its flag is off or unreadable, and prunes once a person turns it on", async () => {
    const task = uid("job_target");
    await run(task, "skipped", ago(1));
    await run(task, "skipped", ago(30));
    const job = createRetentionJob<{ DB: D1Database }>();
    expect(await job.run(context({ get: () => Promise.resolve(null) }))).toEqual({ summary: "flag off" });
    expect(await job.run(context({ get: () => Promise.reject(new Error("KV unavailable")) }))).toEqual({ summary: "flag off" });
    expect(await left(task)).toHaveLength(2);
    const result = await job.run(context({ get: (key) => Promise.resolve(key === RUN_RETENTION_FLAG ? "true" : null) }));
    expect(result).toEqual({ summary: "deleted 1 run rows (1 skipped, 0 completed, 0 failed)", rows: 1 });
    expect(await left(task)).toEqual(["skipped 1d"]);
  });
});
