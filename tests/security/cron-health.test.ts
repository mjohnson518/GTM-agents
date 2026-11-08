// GTM-agents: the cron health check tells a job that never fired from one that failed or was held,
// and reruns a rerunnable job at most once, through the runner, so the halt still applies.
import { createJobRegistry, defineJob, type JobContext, type RegisteredJob } from "@gtm-agents/core/jobs";
import { CRON_HEALTH_JOB, checkCronHealth, createCronHealthJob, createJobRunner, type RunnerEnv } from "@gtm-agents/core/runtime";
import { HALT_KEY } from "@gtm-agents/core/security";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, failingDb, flagsOf, silentLog, uid } from "./helpers.ts";
import { fakeOperator } from "./operator.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");

function critical(name: string, run: () => Promise<void> = () => Promise.resolve(), rerunnable = false): RegisteredJob<RunnerEnv> {
  return defineJob<RunnerEnv>({ name, schedule: "0 9 * * *", critical: true, rerunnable, ceilings: { maxDurationMs: 60_000 }, run });
}

async function seed(name: string, status: string, at: string, error: string | null = null) {
  await env.DB.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, error, created_at) VALUES (?1, ?2, 'cron', ?3, ?4, ?5, ?4)")
    .bind(crypto.randomUUID(), name, status, at, error)
    .run();
}

function rerunWith(kv: MemoryKv) {
  return {
    runner: createJobRunner<RunnerEnv>(),
    makeContext: (j: RegisteredJob<RunnerEnv>, signal: AbortSignal): JobContext<RunnerEnv> => ({
      env: { DB: env.DB, KV: kv },
      config: {} as JobContext<RunnerEnv>["config"],
      job: j.name,
      now: NOW,
      signal,
      ceilings: j.ceilings,
      flags: flagsOf(kv),
      log: silentLog,
    }),
  };
}

describe("the cron health check", () => {
  it("reports each critical job as ok, skipped, failed, abandoned or missed", async () => {
    const names = { ok: uid("ok"), skipped: uid("skipped"), failed: uid("failed"), abandoned: uid("abandoned"), missed: uid("missed") };
    await seed(names.ok, "completed", "2026-11-04T09:00:02.000Z");
    await seed(names.skipped, "skipped", "2026-11-04T09:00:02.000Z");
    await seed(names.failed, "failed", "2026-11-04T09:00:02.000Z", "provider answered 503");
    await seed(names.abandoned, "running", "2026-11-04T09:00:02.000Z");
    await seed(names.missed, "completed", "2026-11-03T09:00:02.000Z");
    const quiet = defineJob<RunnerEnv>({ name: uid("not_critical"), schedule: "0 9 * * *", ceilings: { maxDurationMs: 60_000 }, run: () => Promise.resolve() });
    const registry = createJobRegistry<RunnerEnv>([...Object.values(names).map((n) => critical(n)), quiet]);
    const findings = await checkCronHealth({ registry, db: env.DB, now: NOW });
    expect(findings.map((f) => [f.job, f.status])).toEqual([
      [names.ok, "ok"],
      [names.skipped, "skipped"],
      [names.failed, "failed"],
      [names.abandoned, "abandoned"],
      [names.missed, "missed"],
    ]);
    expect(findings[2]?.error).toBe("provider answered 503");
    expect(findings.every((f) => f.expectedAt === "2026-11-04T09:00:00.000Z")).toBe(true);
  });

  it("reports a run held because state was unreadable as failed, and a run still within its time as ok", async () => {
    const held = uid("held_unreadable");
    const running = uid("still_running");
    await seed(held, "skipped", "2026-11-04T09:00:02.000Z");
    await env.DB.prepare("UPDATE execution_runs SET summary = 'halt flag unreadable' WHERE task_name = ?1").bind(held).run();
    await seed(running, "running", "2026-11-04T11:59:00.000Z");
    const registry = createJobRegistry<RunnerEnv>([critical(held), critical(running)]);
    const findings = await checkCronHealth({ registry, db: env.DB, now: NOW });
    expect(findings.map((f) => [f.status, f.error])).toEqual([
      ["failed", "held: halt flag unreadable"],
      ["ok", undefined],
    ]);
  });

  it("waits for the job's ceiling and a grace period before expecting today's run", async () => {
    const name = uid("early");
    await seed(name, "completed", "2026-11-03T09:00:02.000Z");
    const registry = createJobRegistry<RunnerEnv>([critical(name)]);
    const findings = await checkCronHealth({ registry, db: env.DB, now: new Date("2026-11-04T09:05:00.000Z") });
    expect(findings[0]).toMatchObject({ status: "ok", expectedAt: "2026-11-03T09:00:00.000Z" });
  });

  it("reruns a missed rerunnable job once, through the runner", async () => {
    let runs = 0;
    const name = uid("rerun");
    const registry = createJobRegistry<RunnerEnv>([
      critical(
        name,
        () => {
          runs += 1;
          return Promise.resolve();
        },
        true,
      ),
    ]);
    const kv = new MemoryKv();
    const first = await checkCronHealth({ registry, db: env.DB, now: NOW, rerun: rerunWith(kv) });
    expect(first[0]).toMatchObject({ status: "missed", rerun: { status: "completed" } });
    const second = await checkCronHealth({ registry, db: env.DB, now: NOW, rerun: rerunWith(kv) });
    expect(second[0]?.status).toBe("ok");
    expect(runs).toBe(1);
    const { results } = await env.DB.prepare("SELECT trigger FROM execution_runs WHERE task_name = ?1").bind(name).all<{ trigger: string }>();
    expect(results.map((r) => r.trigger)).toEqual(["rerun"]);
  });

  it("does not bypass the halt when it reruns a job", async () => {
    let runs = 0;
    const name = uid("rerun_halted");
    const registry = createJobRegistry<RunnerEnv>([
      critical(
        name,
        () => {
          runs += 1;
          return Promise.resolve();
        },
        true,
      ),
    ]);
    const kv = new MemoryKv();
    await kv.put(HALT_KEY, "{}");
    const [finding] = await checkCronHealth({ registry, db: env.DB, now: NOW, rerun: rerunWith(kv) });
    expect(finding?.rerun).toMatchObject({ status: "skipped", summary: "halted" });
    expect(runs).toBe(0);
  });
});

describe("the cron health job", () => {
  function setup(db: D1Database, jobs: RegisteredJob<RunnerEnv>[], kv = new MemoryKv()) {
    const operator = fakeOperator();
    const runner = createJobRunner<RunnerEnv>();
    let registry = createJobRegistry<RunnerEnv>([]);
    const health = createCronHealthJob<RunnerEnv>({ schedule: "30 10 * * *", registry: () => registry, runner, operator: () => operator.channel });
    registry = createJobRegistry<RunnerEnv>([...jobs, health]);
    const ctx: JobContext<RunnerEnv> = {
      env: { DB: db, KV: kv },
      config: {} as JobContext<RunnerEnv>["config"],
      job: CRON_HEALTH_JOB,
      now: new Date(),
      signal: new AbortController().signal,
      ceilings: { maxDurationMs: 120_000 },
      flags: flagsOf(kv),
      log: silentLog,
    };
    return { operator, run: () => health.run(ctx), registry };
  }

  it("pages each unhealthy job once a day, and leaves itself out", async () => {
    const missed = uid("health_missed");
    const { operator, run } = setup(env.DB, [critical(missed)]);
    const first = await run();
    await run();
    expect(operator.sent).toHaveLength(1);
    expect(operator.sent[0]).toContain(`Cron health: ${missed} is missed`);
    expect(first?.summary).toBe("1 critical job(s) checked, 1 unhealthy, 1 paged, 0 rerun");
  });

  it("releases a page the operator channel did not take, so the next check pages", async () => {
    const missed = uid("health_retry");
    const { operator, run } = setup(env.DB, [critical(missed)]);
    operator.failNext = 1;
    await run();
    expect(operator.sent).toHaveLength(0);
    await run();
    expect(operator.sent).toHaveLength(1);
  });

  it("still pages when the database is down", async () => {
    const { operator, run } = setup(failingDb(), [critical(uid("health_outage"))]);
    await run();
    await run();
    expect(operator.sent).toHaveLength(1);
    expect(operator.sent[0]).toContain("is unknown");
  });

  it("pages before rerunning, and leaves a rerun that would outlast the check for later", async () => {
    let runs = 0;
    const long = defineJob<RunnerEnv>({
      name: uid("health_long"),
      schedule: "0 9 * * *",
      critical: true,
      rerunnable: true,
      ceilings: { maxDurationMs: 600_000 },
      run: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    const { operator, run } = setup(env.DB, [long]);
    const result = await run();
    expect(operator.sent).toHaveLength(1);
    expect(runs).toBe(0);
    expect(result?.summary).toContain("0 rerun");
  });
});
