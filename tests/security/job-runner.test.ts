// GTM-agents: the job runner leaves a run row for every job, holds jobs while halted, over budget or
// flagged off, and pages a failure at most once per job per day.
import { jobCapKey, recordCost } from "@gtm-agents/core/budget";
import { defineJob, runOneJob, type JobContext, type JobDefinition, type RegisteredJob } from "@gtm-agents/core/jobs";
import { createJobRunner, failureStats, notifyWithin, type RunnerEnv } from "@gtm-agents/core/runtime";
import { HALT_KEY } from "@gtm-agents/core/security";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, failingDb, flagsOf, silentLog, uid } from "./helpers.ts";
import { fakeOperator, type FakeOperator } from "./operator.ts";

interface Harness {
  kv: MemoryKv;
  operator: FakeOperator;
  db: D1Database;
  run(job: RegisteredJob<RunnerEnv>, overrides?: Partial<JobContext<RunnerEnv>>): ReturnType<typeof runOneJob<RunnerEnv>>;
}

function harness(db: D1Database = env.DB, kv: MemoryKv = new MemoryKv()): Harness {
  const operator = fakeOperator();
  const runner = createJobRunner<RunnerEnv>({ operator: () => operator.channel });
  return {
    kv,
    operator,
    db,
    run: (job, overrides = {}) =>
      runOneJob<RunnerEnv>(
        job,
        (j, signal) => ({
          env: { DB: db, KV: kv },
          config: {} as JobContext<RunnerEnv>["config"],
          job: j.name,
          now: new Date(),
          signal,
          ceilings: j.ceilings,
          flags: flagsOf(kv),
          log: silentLog,
          ...overrides,
        }),
        runner,
      ),
  };
}

function job(name: string, run: JobDefinition<RunnerEnv>["run"], extra: Partial<JobDefinition<RunnerEnv>> = {}): RegisteredJob<RunnerEnv> {
  return defineJob<RunnerEnv>({ name, schedule: "0 9 * * *", ceilings: { maxDurationMs: 2000 }, run, ...extra });
}

async function rows(name: string) {
  const { results } = await env.DB.prepare("SELECT id, status, summary, error, error_class, trigger FROM execution_runs WHERE task_name = ?1 ORDER BY started_at")
    .bind(name)
    .all<{ id: string; status: string; summary: string | null; error: string | null; error_class: string | null; trigger: string }>();
  return results;
}

const fail = (message: string) => () => Promise.reject(new Error(message));

describe("the job runner", () => {
  it("leaves a failed row and exactly one page that day, even after two failures", async () => {
    const h = harness();
    const name = uid("flaky");
    const flaky = job(name, fail("upstream returned an unexpected shape"));
    expect((await h.run(flaky)).status).toBe("failed");
    expect((await h.run(flaky)).status).toBe("failed");
    const written = await rows(name);
    expect(written.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(written[0]?.error_class).toBe("unknown");
    expect(h.operator.sent).toHaveLength(1);
    expect(h.operator.sent[0]).toContain(`Job failed: ${name}`);
  });

  it("escalates once on the third failure of the day", async () => {
    const h = harness();
    const name = uid("flaky");
    const flaky = job(name, fail("upstream returned an unexpected shape"));
    for (let i = 0; i < 5; i++) await h.run(flaky);
    expect(h.operator.sent).toHaveLength(2);
    expect(h.operator.sent[1]).toContain(`Job escalated: ${name}`);
    expect(h.operator.sent[1]).toContain("3 failures today");
  });

  it("escalates a configuration error at once, and only once", async () => {
    const h = harness();
    const name = uid("misconfigured");
    const broken = job(name, fail("provider answered 401 Unauthorized"));
    await h.run(broken);
    await h.run(broken);
    expect(h.operator.sent).toHaveLength(1);
    expect(h.operator.sent[0]).toContain("Job escalated");
    expect((await rows(name))[0]?.error_class).toBe("config");
  });

  it("escalates a job that has failed three days in a row", async () => {
    const h = harness();
    const name = uid("daily");
    const day = 86_400_000;
    for (const back of [2, 1]) {
      const at = new Date(Date.now() - back * day).toISOString();
      await env.DB.prepare("INSERT INTO execution_runs (id, task_name, trigger, status, started_at, created_at) VALUES (?1, ?2, 'cron', 'failed', ?3, ?3)")
        .bind(crypto.randomUUID(), name, at)
        .run();
    }
    // The streak counts consecutive days ending today, so it starts when today fails.
    expect(await failureStats(env.DB, name, new Date())).toEqual({ today: 0, streak: 0 });
    await h.run(job(name, fail("upstream returned an unexpected shape")));
    expect(await failureStats(env.DB, name, new Date())).toEqual({ today: 1, streak: 3 });
    expect(h.operator.sent).toHaveLength(1);
    expect(h.operator.sent[0]).toContain("failing 3 days in a row");
  });

  it("releases the page when the operator channel fails, so the next failure pages", async () => {
    const h = harness();
    h.operator.failNext = 1;
    const name = uid("flaky");
    const flaky = job(name, fail("upstream returned an unexpected shape"));
    await h.run(flaky);
    expect(h.operator.sent).toHaveLength(0);
    await h.run(flaky);
    expect(h.operator.sent).toHaveLength(1);
  });

  it("stores sanitized errors only", async () => {
    const h = harness();
    const name = uid("leaky");
    await h.run(job(name, fail("GET https://api.vendor.example/v1?key=abc failed for jane.doe@acme.example with Bearer abc.def")));
    const [row] = await rows(name);
    expect(row?.error).toBe("GET [url] failed for [email] with Bearer [redacted]");
    expect(h.operator.sent[0]).not.toContain("acme.example");
  });

  it("does not run a job while the system is halted, and records why", async () => {
    const h = harness();
    await h.kv.put(HALT_KEY, JSON.stringify({ reason: "maintenance", by: "operator" }));
    let ran = false;
    const name = uid("held");
    const outcome = await h.run(
      job(name, () => {
        ran = true;
        return Promise.resolve();
      }),
    );
    expect(outcome).toMatchObject({ status: "skipped", summary: "halted" });
    expect(ran).toBe(false);
    expect((await rows(name)).map((r) => [r.status, r.summary])).toEqual([["skipped", "halted"]]);
  });

  it("treats an unreadable halt flag as halted", async () => {
    const h = harness();
    h.kv.failing = true;
    let ran = false;
    const outcome = await h.run(
      job(uid("held"), () => {
        ran = true;
        return Promise.resolve();
      }),
    );
    expect(outcome.summary).toBe("halt flag unreadable");
    expect(ran).toBe(false);
  });

  it("skips a job whose flag is off or unreadable", async () => {
    const h = harness();
    const name = uid("flagged");
    const flagged = job(name, () => Promise.resolve(), { flag: "test:feature_enabled" });
    expect((await h.run(flagged)).summary).toBe("flag off");
    await h.kv.put("test:feature_enabled", "true");
    expect((await h.run(flagged)).status).toBe("completed");
    const unreadable: MemoryKv["get"] = (key) => (key === "test:feature_enabled" ? Promise.reject(new Error("kv unavailable")) : h.kv.get(key));
    expect((await h.run(flagged, { flags: { get: unreadable } })).summary).toBe("flag unreadable");
  });

  it("skips a spending job that has reached its daily cap", async () => {
    const h = harness();
    const name = uid("spender");
    expect(await recordCost(env.DB, { provider: "data-vendor", capability: "lookup", costMicroCents: 60_000, job: name })).toBe(true);
    let ran = false;
    const spender = job(
      name,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { ceilings: { maxDurationMs: 2000, maxSpendCents: 5 } },
    );
    expect(await h.run(spender)).toMatchObject({ status: "skipped", summary: "budget: job_cap" });
    expect(ran).toBe(false);
  });

  it("enforces a job cap set only by flag", async () => {
    const h = harness();
    const name = uid("flag_capped");
    await recordCost(env.DB, { provider: "data-vendor", capability: "lookup", costMicroCents: 500_000, job: name });
    await h.kv.put(jobCapKey(name), "10");
    let ran = false;
    const outcome = await h.run(
      job(name, () => {
        ran = true;
        return Promise.resolve();
      }),
    );
    expect(outcome).toMatchObject({ status: "skipped", summary: "budget: job_cap" });
    expect(ran).toBe(false);
  });

  it("records the run even when the first row write fails", async () => {
    let failedOnce = false;
    const flaky = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key) as unknown;
        return (sql: string) => {
          if (!failedOnce && sql.includes("INSERT INTO execution_runs") && !sql.includes("ON CONFLICT")) {
            failedOnce = true;
            throw new Error("D1_ERROR: busy");
          }
          return target.prepare(sql);
        };
      },
    });
    const h = harness(flaky);
    const name = uid("recorded");
    expect((await h.run(job(name, () => Promise.resolve({ summary: "done" })))).status).toBe("completed");
    expect(failedOnce).toBe(true);
    expect((await rows(name)).map((r) => [r.status, r.summary])).toEqual([["completed", "done"]]);
  });

  it("does not page twice in a day when the database comes back after an outage", async () => {
    const kv = new MemoryKv();
    const name = uid("recovering");
    const down = harness(failingDb(), kv);
    await down.run(job(name, fail("D1_ERROR: database unavailable")));
    expect(down.operator.sent).toHaveLength(1);
    const up = harness(env.DB, kv);
    await up.run(job(name, fail("upstream returned an unexpected shape")));
    expect(up.operator.sent).toHaveLength(0);
  });

  it("hands the runner's own promise to the caller, so a slow page outlives the loop's give-up", async () => {
    let settle: () => void = () => {};
    const slowRunner = () => new Promise<never>((_, reject) => {
      settle = () => reject(new Error("finished late"));
    });
    const tracked: Array<Promise<unknown>> = [];
    const quick = defineJob<RunnerEnv>({ name: uid("tracked"), schedule: "0 9 * * *", ceilings: { maxDurationMs: 10 }, run: () => Promise.resolve() });
    const outcome = await runOneJob<RunnerEnv>(quick, () => ({}) as JobContext<RunnerEnv>, slowRunner, (p) => tracked.push(p));
    expect(outcome.status).toBe("failed");
    expect(tracked).toHaveLength(1);
    settle();
    await expect(tracked[0]).resolves.toBeUndefined();
  });

  it("requires a whole number of cents for a job's spend ceiling", () => {
    for (const maxSpendCents of [2.5, Number.POSITIVE_INFINITY, -1, Number.NaN]) {
      expect(() => defineJob({ name: "bad_ceiling", schedule: "0 9 * * *", ceilings: { maxDurationMs: 1000, maxSpendCents }, run: () => Promise.resolve() }), String(maxSpendCents)).toThrow(/whole number/);
    }
  });

  it("gives up on a page that hangs, so its claim can be released", async () => {
    const hanging = { notify: () => new Promise<never>(() => {}) } as unknown as Parameters<typeof notifyWithin>[0];
    expect(await notifyWithin(hanging, "text", 20)).toBe(false);
  });

  it("never turns a successful job into a failed one because bookkeeping failed", async () => {
    const h = harness(failingDb());
    let ran = false;
    const outcome = await h.run(
      job(uid("steady"), () => {
        ran = true;
        return Promise.resolve({ summary: "done" });
      }),
    );
    expect(ran).toBe(true);
    expect(outcome).toMatchObject({ status: "completed", summary: "done" });
    const odd = await h.run(job(uid("odd_summary"), () => Promise.resolve({ summary: 42 as unknown as string })));
    expect(odd.status).toBe("completed");
  });

  it("still pages once a day when the database is down", async () => {
    const h = harness(failingDb());
    const flaky = job(uid("outage"), fail("D1_ERROR: database unavailable"));
    await h.run(flaky);
    await h.run(flaky);
    expect(h.operator.sent).toHaveLength(1);
  });

  it("hands the job its run id and records a time-out as a transient failure", async () => {
    const h = harness();
    const name = uid("slow");
    let seen: string | undefined;
    await h.run(
      job(name, (ctx) => {
        seen = ctx.runId;
        return Promise.resolve();
      }),
    );
    expect((await rows(name))[0]?.id).toBe(seen);

    const slowName = uid("slow");
    const slow = defineJob<RunnerEnv>({ name: slowName, schedule: "0 9 * * *", ceilings: { maxDurationMs: 50 }, run: () => new Promise(() => {}) });
    expect((await h.run(slow)).status).toBe("failed");
    expect((await rows(slowName))[0]).toMatchObject({ status: "failed", error_class: "transient" });
  });
});
