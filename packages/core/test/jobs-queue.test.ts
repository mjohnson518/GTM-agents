// GTM-agents: tests for scheduled jobs through the jobs queue: the scheduled handler sends one
// message per due job, the consumer runs one job per message claimed per (job, minute), a
// redelivered or duplicate message does nothing, the halt and the overlap guard still hold across
// invocations, a backed-up fire is superseded, a failed send runs its jobs in place, the dead-letter
// queue records and pages once, and without the binding the in-process path runs as before.
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import type { Env } from "../src/env.ts";
import { claimEffect } from "../src/events/effects.ts";
import { createJobRegistry, defineJob, type JobDefinition } from "../src/jobs/registry.ts";
import { JOB_MESSAGE_KIND, JOB_RUN_EFFECT, createJobsConsumer, enqueueDueJobs, firedSince, jobRunKey, minuteOf, type JobMessage, type JobQueue } from "../src/jobs/queue.ts";
import { parseCron } from "../src/jobs/cron.ts";
import { checkCronHealth } from "../src/runtime/cron-health.ts";
import { createJobRunner } from "../src/runtime/job-runner.ts";
import type { OperatorChannel } from "../src/ports/operator.ts";
import { createWorker } from "../src/worker.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);
const testEnv = env as unknown as Env;
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

// The consumer judges a fire against the real clock, so consumer tests use the current minute and
// a schedule that fires only then (once a year): no later fire can supersede it during the test.
const NOW_MINUTE = minuteOf(new Date());
const at = new Date(NOW_MINUTE);
const ONCE = `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`;

/** A JOBS_QUEUE double that records what was sent, and can be made to fail. */
function fakeQueue(fail = false): JobQueue & { sent: JobMessage[]; calls: number } {
  const queue = {
    sent: [] as JobMessage[],
    calls: 0,
    sendBatch: async (messages: Iterable<MessageSendRequest<JobMessage>>) => {
      queue.calls += 1;
      if (fail) throw new Error("Too Many Requests");
      for (const m of messages) queue.sent.push(m.body);
    },
  };
  return queue;
}

/** A KV double, so a test can set the halt flag without touching the shared namespace. */
function fakeKv(values: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(values));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace;
}

const QUEUE_ON = { "scheduler:queue_enabled": "true" };

const message = (job: string, minute: string, id = `${job}@${minute}`) => ({ id, timestamp: new Date(), attempts: 1, body: { kind: JOB_MESSAGE_KIND, job, minute } });

async function fire(worker: ReturnType<typeof createWorker>, at: string, e: Env): Promise<void> {
  const controller = createScheduledController({ cron: "* * * * *", scheduledTime: new Date(at) });
  const ctx = createExecutionContext();
  await (worker.scheduled as (c: ScheduledController, e: Env, x: ExecutionContext) => Promise<void>)(controller, e, ctx);
  await waitOnExecutionContext(ctx);
}

async function deliver(worker: ReturnType<typeof createWorker>, queue: string, messages: ReturnType<typeof message>[], e: Env = testEnv) {
  const batch = createMessageBatch(queue, messages);
  const ctx = createExecutionContext();
  await (worker.queue as (b: MessageBatch, e: Env, c: ExecutionContext) => Promise<void>)(batch, e, ctx);
  return getQueueResult(batch, ctx);
}

const rows = (job: string) => testEnv.DB.prepare("SELECT status, summary, error FROM execution_runs WHERE task_name = ?1 ORDER BY started_at").bind(job).all<{ status: string; summary: string | null; error: string | null }>().then((r) => r.results);

function counting(name: string, schedule: string, counter: Map<string, number>, extra: Partial<JobDefinition<Env>> = {}): JobDefinition<Env> {
  return {
    name,
    schedule,
    ceilings: { maxDurationMs: 5_000 },
    run: async () => {
      counter.set(name, (counter.get(name) ?? 0) + 1);
      return { summary: "ran" };
    },
    ...extra,
  };
}

describe("the scheduled handler with a jobs queue", () => {
  it("sends one message per due job in a busy minute, and runs none of them itself", async () => {
    const ran = new Map<string, number>();
    const due = Array.from({ length: 12 }, (_v, i) => counting(`q_busy_${i}`, "0 9 * * MON-FRI", ran));
    const worker = createWorker(config, { jobs: [...due, counting("q_not_due", "30 9 * * MON-FRI", ran)] });
    const queue = fakeQueue();
    await fire(worker, "2026-11-02T09:00:00Z", { ...testEnv, KV: fakeKv(QUEUE_ON), JOBS_QUEUE: queue as unknown as Queue<JobMessage> });
    expect(queue.sent.map((m) => m.job).sort()).toEqual(due.map((j) => j.name).sort());
    expect(new Set(queue.sent.map((m) => m.minute))).toEqual(new Set(["2026-11-02T09:00:00.000Z"]));
    expect(ran.size).toBe(0);
    expect(await rows("q_busy_0")).toEqual([]);
  });

  it("sends more than one batch when more jobs are due than one sendBatch takes", async () => {
    const jobs = Array.from({ length: 130 }, (_v, i) => defineJob({ name: `q_many_${i}`, schedule: "* * * * *", ceilings: { maxDurationMs: 1_000 }, run: async () => {} }));
    const queue = fakeQueue();
    const result = await enqueueDueJobs(queue, jobs, new Date("2026-11-02T09:00:30Z"));
    expect(queue.calls).toBe(2);
    expect(queue.sent).toHaveLength(130);
    expect(result.failed).toEqual([]);
    expect(queue.sent[0]?.minute).toBe("2026-11-02T09:00:00.000Z");
  });

  it("runs the jobs itself, once, when the queue will not take them, and a late copy of the message then does nothing", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_send_fails", "0 9 * * MON-FRI", ran)] });
    await fire(worker, "2026-11-02T09:00:00Z", { ...testEnv, KV: fakeKv(QUEUE_ON), JOBS_QUEUE: fakeQueue(true) as unknown as Queue<JobMessage> });
    expect(ran.get("q_send_fails")).toBe(1);
    expect(await rows("q_send_fails")).toMatchObject([{ status: "completed" }]);
    const result = await deliver(worker, "gtm-jobs", [message("q_send_fails", "2026-11-02T09:00:00.000Z")]);
    expect(ran.get("q_send_fails")).toBe(1);
    expect(result.explicitAcks).toEqual(["q_send_fails@2026-11-02T09:00:00.000Z"]);
  });

  it("with the binding but scheduler:queue_enabled off (the default), runs the due jobs in the scheduled invocation", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_flag_off", "0 9 * * MON-FRI", ran)] });
    const queue = fakeQueue();
    await fire(worker, "2026-11-02T09:00:00Z", { ...testEnv, KV: fakeKv(), JOBS_QUEUE: queue as unknown as Queue<JobMessage> });
    expect(queue.sent).toEqual([]);
    expect(ran.get("q_flag_off")).toBe(1);
  });

  it("without the binding, runs the due jobs in the scheduled invocation as before", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_inline", "0 9 * * MON-FRI", ran)] });
    await fire(worker, "2026-11-02T09:00:00Z", testEnv);
    expect(ran.get("q_inline")).toBe(1);
    expect(await rows("q_inline")).toMatchObject([{ status: "completed", summary: "ran" }]);
  });
});

describe("the jobs queue consumer", () => {
  it("runs exactly the one job its message names, and acknowledges it", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_one", ONCE, ran), counting("q_other", ONCE, ran)] });
    const result = await deliver(worker, "gtm-jobs", [message("q_one", NOW_MINUTE)]);
    expect(ran.get("q_one")).toBe(1);
    expect(ran.has("q_other")).toBe(false);
    expect(await rows("q_one")).toMatchObject([{ status: "completed" }]);
    expect(result.explicitAcks).toEqual([`q_one@${NOW_MINUTE}`]);
    expect(result.retryMessages).toEqual([]);
  });

  it("does nothing for a redelivered message or a second copy of the same fire", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_redelivered", ONCE, ran)] });
    const minute = NOW_MINUTE;
    await deliver(worker, "gtm-jobs", [message("q_redelivered", minute, "m-1")]);
    const again = await deliver(worker, "gtm-jobs", [{ ...message("q_redelivered", minute, "m-1"), attempts: 2 }]);
    const copy = await deliver(worker, "gtm-jobs", [message("q_redelivered", minute, "m-2")]);
    expect(ran.get("q_redelivered")).toBe(1);
    expect(await rows("q_redelivered")).toHaveLength(1);
    expect(again.explicitAcks).toEqual(["m-1"]);
    expect(copy.explicitAcks).toEqual(["m-2"]);
  });

  it("records a failed run row when a redelivered fire was claimed by an invocation that ended before writing one", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_crashed", ONCE, ran)] });
    // The first invocation claimed the fire and was cut off before the runner wrote a row.
    await claimEffect(testEnv.DB, jobRunKey("q_crashed", NOW_MINUTE), JOB_RUN_EFFECT);
    const result = await deliver(worker, "gtm-jobs", [{ ...message("q_crashed", NOW_MINUTE), attempts: 2 }]);
    expect(ran.has("q_crashed")).toBe(false);
    expect(await rows("q_crashed")).toMatchObject([{ status: "failed" }]);
    expect((await rows("q_crashed"))[0]?.error).toContain("ended before it recorded a result");
    expect(result.explicitAcks).toHaveLength(1);
  });

  it("records a skipped run row when the system is halted, and does not run the job", async () => {
    const ran = new Map<string, number>();
    const worker = createWorker(config, { jobs: [counting("q_halted", ONCE, ran)] });
    await deliver(worker, "gtm-jobs", [message("q_halted", NOW_MINUTE)], { ...testEnv, KV: fakeKv({ "system:halt": "maintenance" }) });
    expect(ran.has("q_halted")).toBe(false);
    expect(await rows("q_halted")).toMatchObject([{ status: "skipped", summary: "halted" }]);
  });

  it("keeps the overlap guard across invocations: a fire delivered while the previous one runs is skipped", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const job = defineJob<Env>({ name: "q_overlap", schedule: "*/5 * * * *", ceilings: { maxDurationMs: 600_000 }, run: async () => {
      runs += 1;
      await gate;
    } });
    const registry = createJobRegistry<Env>([job]);
    const runner = createJobRunner<Env>();
    const consumerAt = (iso: string) =>
      createJobsConsumer<Env>({
        registry,
        runner,
        db: (e) => e.DB,
        makeContext: (e, at) => (j, signal) => ({ env: e, config, job: j.name, now: at, signal, ceilings: j.ceilings, flags: { get: async () => null }, log: quietLog }),
        log: quietLog,
        clock: () => Date.parse(iso) + 10_000,
      });
    const first = consumerAt("2026-11-02T09:00:00.000Z")(createMessageBatch("gtm-jobs", [message("q_overlap", "2026-11-02T09:00:00.000Z")]), testEnv, createExecutionContext());
    await new Promise((r) => setTimeout(r, 50));
    await consumerAt("2026-11-02T09:05:00.000Z")(createMessageBatch("gtm-jobs", [message("q_overlap", "2026-11-02T09:05:00.000Z")]), testEnv, createExecutionContext());
    release();
    await first;
    expect(runs).toBe(1);
    const statuses = (await rows("q_overlap")).map((r) => r.status).sort();
    expect(statuses).toEqual(["completed", "skipped"]);
    expect((await rows("q_overlap")).find((r) => r.status === "skipped")?.summary).toContain("previous run is still going");
  });

  it("records a fire as superseded, without running it, once a later fire of the job has been claimed", async () => {
    let runs = 0;
    const job = defineJob<Env>({ name: "q_superseded", schedule: "* * * * *", ceilings: { maxDurationMs: 5_000 }, run: async () => void (runs += 1) });
    const consumer = createJobsConsumer<Env>({
      registry: createJobRegistry<Env>([job]),
      runner: createJobRunner<Env>(),
      db: (e) => e.DB,
      makeContext: (e, at) => (j, signal) => ({ env: e, config, job: j.name, now: at, signal, ceilings: j.ceilings, flags: { get: async () => null }, log: quietLog }),
      log: quietLog,
      clock: () => Date.parse("2026-11-02T09:03:20Z"),
    });
    // A fire that only waited for a consumer still runs.
    await consumer(createMessageBatch("gtm-jobs", [message("q_superseded", "2026-11-02T08:58:00.000Z")]), testEnv, createExecutionContext());
    expect(runs).toBe(1);
    await claimEffect(testEnv.DB, jobRunKey("q_superseded", "2026-11-02T09:02:00.000Z"), JOB_RUN_EFFECT);
    await consumer(createMessageBatch("gtm-jobs", [message("q_superseded", "2026-11-02T09:00:00.000Z")]), testEnv, createExecutionContext());
    expect(runs).toBe(1);
    const row = (await rows("q_superseded")).at(-1);
    expect(row?.status).toBe("skipped");
    expect(row?.summary).toContain("superseded");
    expect(firedSince(parseCron("0 9 * * MON-FRI"), new Date("2026-11-02T09:00:00Z"), new Date("2026-11-02T18:00:00Z"))).toBeNull();
  });

  it("retries a message whose claim cannot be written, and never runs its job unclaimed", async () => {
    let runs = 0;
    const job = defineJob<Env>({ name: "q_claim_fails", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 5_000 }, run: async () => void (runs += 1) });
    const broken = { prepare: () => {
      throw new Error("D1_ERROR: database unavailable");
    } } as unknown as D1Database;
    const consumer = createJobsConsumer<Env>({
      registry: createJobRegistry<Env>([job]),
      runner: createJobRunner<Env>(),
      db: () => broken,
      makeContext: (e, at) => (j, signal) => ({ env: e, config, job: j.name, now: at, signal, ceilings: j.ceilings, flags: { get: async () => null }, log: quietLog }),
      log: quietLog,
    });
    const batch = createMessageBatch("gtm-jobs", [message("q_claim_fails", "2026-11-02T09:00:00.000Z")]);
    const ctx = createExecutionContext();
    await consumer(batch, testEnv, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(runs).toBe(0);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["q_claim_fails@2026-11-02T09:00:00.000Z"]);
  });

  it("drops a message for a job that is no longer registered, and one that is not a job message", async () => {
    const worker = createWorker(config);
    const result = await deliver(worker, "gtm-jobs", [message("q_removed", "2026-11-02T09:00:00.000Z")]);
    expect(result.explicitAcks).toEqual(["q_removed@2026-11-02T09:00:00.000Z"]);
  });
});

describe("the jobs dead-letter queue", () => {
  it("records a failed run row for each fire that never ran, pages once a day, and leaves a fire that ran alone", async () => {
    const pages: string[] = [];
    const operator = { name: "fake", notify: async ({ text }: { text: string }) => void pages.push(text) } as unknown as OperatorChannel;
    const worker = createWorker(config, {
      jobs: [counting("q_dead", "0 9 * * MON-FRI", new Map()), counting("q_dead_ran", "0 9 * * MON-FRI", new Map())],
      operator: () => operator,
    });
    await claimEffect(testEnv.DB, jobRunKey("q_dead_ran", "2026-11-02T09:00:00.000Z"), JOB_RUN_EFFECT);
    const first = await deliver(worker, "acme-gtm-jobs-dlq", [message("q_dead", "2026-11-02T09:00:00.000Z"), message("q_dead_ran", "2026-11-02T09:00:00.000Z")]);
    await deliver(worker, "acme-gtm-jobs-dlq", [message("q_dead", "2026-11-02T09:01:00.000Z")]);
    expect(first.explicitAcks.sort()).toEqual(["q_dead@2026-11-02T09:00:00.000Z", "q_dead_ran@2026-11-02T09:00:00.000Z"]);
    const dead = await rows("q_dead");
    expect(dead.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(dead[0]?.error).toContain("dead-lettered");
    expect(await rows("q_dead_ran")).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("q_dead at 2026-11-02T09:00:00.000Z");
    // A redelivered copy of the original message cannot run the fire after it was recorded as lost.
    await deliver(worker, "gtm-jobs", [message("q_dead", "2026-11-02T09:00:00.000Z")]);
    expect((await rows("q_dead")).map((r) => r.status)).toEqual(["failed", "failed"]);
  });
});

describe("cron health and the jobs queue", () => {
  it("reports a critical job whose only run in the window was superseded as failed, not as held on purpose", async () => {
    const job = defineJob<Env>({ name: "q_health_superseded", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 60_000 }, critical: true, run: async () => {} });
    await testEnv.DB.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, finished_at, summary, created_at) VALUES (?1, ?2, 'cron', 'skipped', ?3, ?3, ?4, ?3)")
      .bind(crypto.randomUUID(), job.name, "2026-11-02T09:20:00.000Z", "superseded: this 2026-11-02T09:00:00.000Z fire was delivered after the next one")
      .run();
    const findings = await checkCronHealth<Env>({ registry: createJobRegistry<Env>([job]), db: testEnv.DB, now: new Date("2026-11-02T10:00:00Z") });
    expect(findings[0]).toMatchObject({ status: "failed" });
  });

  it("does not rerun a missed fire whose queued run has already been claimed", async () => {
    let runs = 0;
    const job = defineJob<Env>({ name: "q_health_claimed", schedule: "0 9 * * MON-FRI", ceilings: { maxDurationMs: 60_000 }, critical: true, rerunnable: true, run: async () => void (runs += 1) });
    const registry = createJobRegistry<Env>([job]);
    await claimEffect(testEnv.DB, jobRunKey("q_health_claimed", "2026-11-02T09:00:00.000Z"), JOB_RUN_EFFECT);
    const findings = await checkCronHealth<Env>({
      registry,
      db: testEnv.DB,
      now: new Date("2026-11-02T10:00:00Z"),
      rerun: {
        runner: createJobRunner<Env>(),
        makeContext: (j, signal) => ({ env: testEnv, config, job: j.name, now: new Date(), signal, ceilings: j.ceilings, flags: { get: async () => null }, log: quietLog }),
      },
    });
    expect(findings[0]).toMatchObject({ status: "missed", rerunDeferred: "its queued run for that minute was already claimed" });
    expect(runs).toBe(0);
  });
});
