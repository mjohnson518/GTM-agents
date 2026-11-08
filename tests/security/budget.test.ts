// GTM-agents: the budget gate stops spend at per-job caps (always), at hard global limits, at run and
// turn ceilings, and whenever a limit or the ledger cannot be read.
import {
  BUDGET_KEYS,
  checkBudget,
  checkRunCeiling,
  checkTurnCeiling,
  jobCapKey,
  microCentsToCents,
  recordCost,
  runSpendState,
  tokenCostMicroCents,
} from "@gtm-agents/core/budget";
import { budgetCheck, executeToolCall } from "@gtm-agents/core/runtime";
import { createToolRegistry } from "@gtm-agents/core/security";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, failingDb, flagsOf, session, spy, uid } from "./helpers.ts";

const cents = (n: number) => n * 10_000;

describe("the cost ledger", () => {
  it("prices model calls in micro-cents, with cache writes and reads at their own multipliers", () => {
    const price = { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 };
    const usage = { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 10_000 };
    // 0.3 + 0.75 + 0.75 (1.25x) + 0.3 (0.1x) cents
    expect(tokenCostMicroCents(usage, price)).toBe(21_000);
    expect(tokenCostMicroCents({ inputTokens: 1, outputTokens: 0 }, price)).toBe(3);
    expect(tokenCostMicroCents({ inputTokens: -5, outputTokens: Number.NaN }, price)).toBe(0);
  });

  it("refuses to price a model with no valid price, so it cannot run as if free", () => {
    for (const price of [undefined, { inputCentsPerMTok: Number.NaN, outputCentsPerMTok: 1 }, { inputCentsPerMTok: 1, outputCentsPerMTok: -1 }, { inputCentsPerMTok: 1, outputCentsPerMTok: 1, cacheReadMultiplier: -1 }]) {
      expect(() => tokenCostMicroCents({ inputTokens: 1, outputTokens: 1 }, price), JSON.stringify(price)).toThrow(TypeError);
    }
  });

  it("rounds up to whole cents, so a nonzero cost never reads as free", () => {
    expect([0, 1, 10_000, 10_001].map(microCentsToCents)).toEqual([0, 1, 1, 2]);
  });

  it("never throws when a row cannot be written", async () => {
    expect(await recordCost(failingDb(), { provider: "model-vendor", capability: "model", costMicroCents: 5 })).toBe(false);
    expect(await recordCost(env.DB, { provider: "model-vendor", capability: "model", costMicroCents: -1 })).toBe(false);
  });
});

describe("the budget gate", () => {
  it("always enforces a job's daily cap, even in soft mode", async () => {
    const kv = new MemoryKv();
    const job = uid("capped");
    await recordCost(env.DB, { provider: "data-vendor", capability: "lookup", costMicroCents: cents(15), job });
    await kv.put(jobCapKey(job), "10");
    expect(await checkBudget({ db: env.DB, flags: flagsOf(kv), job })).toMatchObject({ allowed: false, reason: "job_cap" });
    await kv.put(jobCapKey(job), "100");
    expect((await checkBudget({ db: env.DB, flags: flagsOf(kv), job })).allowed).toBe(true);
    expect(await checkBudget({ db: env.DB, flags: flagsOf(kv), job, jobCapCents: 12 })).toMatchObject({ allowed: false, reason: "job_cap" });
  });

  it("treats a limit of 0 as forbidding spend", async () => {
    const kv = new MemoryKv();
    expect(await checkBudget({ db: env.DB, flags: flagsOf(kv), job: uid("free"), jobCapCents: 0 })).toMatchObject({ allowed: false, reason: "job_cap" });
    await kv.put(BUDGET_KEYS.enforcement, "hard");
    await kv.put(BUDGET_KEYS.dailyLimitCents, "0");
    expect(await checkBudget({ db: env.DB, flags: flagsOf(kv) })).toMatchObject({ allowed: false, reason: "daily_limit" });
  });

  it("only reports the global limits in soft mode, and blocks at them in hard mode", async () => {
    const kv = new MemoryKv();
    await kv.put(BUDGET_KEYS.dailyLimitCents, "0");
    expect(await checkBudget({ db: env.DB, flags: flagsOf(kv) })).toMatchObject({ allowed: true, nearLimit: true });
    await kv.put(BUDGET_KEYS.enforcement, "hard");
    expect((await checkBudget({ db: env.DB, flags: flagsOf(kv) })).allowed).toBe(false);
    await kv.put(BUDGET_KEYS.dailyLimitCents, "100000000");
    await kv.put(BUDGET_KEYS.monthlyLimitCents, "0");
    expect(await checkBudget({ db: env.DB, flags: flagsOf(kv) })).toMatchObject({ allowed: false, reason: "monthly_limit" });
    await kv.put(BUDGET_KEYS.monthlyLimitCents, "100000000");
    expect((await checkBudget({ db: env.DB, flags: flagsOf(kv) })).allowed).toBe(true);
  });

  it("blocks when a limit cannot be read or does not parse, or the ledger cannot be read", async () => {
    const down = new MemoryKv();
    down.failing = true;
    expect(await checkBudget({ db: env.DB, flags: flagsOf(down) })).toMatchObject({ allowed: false, reason: "unreadable" });
    for (const [key, value] of [
      [BUDGET_KEYS.dailyLimitCents, "ten dollars"],
      [BUDGET_KEYS.dailyLimitCents, "-5"],
      [BUDGET_KEYS.enforcement, "medium"],
      [BUDGET_KEYS.alertThreshold, "2"],
      [jobCapKey("malformed_cap"), "1.5"],
    ] as const) {
      const kv = new MemoryKv();
      await kv.put(key, value);
      expect(await checkBudget({ db: env.DB, flags: flagsOf(kv), job: "malformed_cap" }), `${key}=${value}`).toMatchObject({ allowed: false, reason: "unreadable" });
    }
    expect(await checkBudget({ db: failingDb(), flags: flagsOf(new MemoryKv()) })).toMatchObject({ allowed: false, reason: "unreadable" });
    for (const jobCapCents of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
      expect(await checkBudget({ db: env.DB, flags: flagsOf(new MemoryKv()), job: uid("bad_cap"), jobCapCents }), String(jobCapCents)).toMatchObject({ allowed: false, reason: "unreadable" });
    }
  });

  it("stops tools at a run's ceiling and aborts the run past 1.25 times it", async () => {
    expect([runSpendState(9, 10), runSpendState(10, 10), runSpendState(12, 10), runSpendState(13, 10)]).toEqual(["ok", "ceiling", "ceiling", "abort"]);
    const kv = new MemoryKv();
    await kv.put(BUDGET_KEYS.runCeilingCents, "10");
    const runId = uid("run");
    await recordCost(env.DB, { provider: "model-vendor", capability: "model", costMicroCents: cents(11), runId });
    expect((await checkRunCeiling({ db: env.DB, flags: flagsOf(kv), runId })).state).toBe("ceiling");
    await recordCost(env.DB, { provider: "model-vendor", capability: "model", costMicroCents: cents(2), runId });
    expect((await checkRunCeiling({ db: env.DB, flags: flagsOf(kv), runId })).state).toBe("abort");
    expect((await checkRunCeiling({ db: failingDb(), flags: flagsOf(kv), runId })).state).toBe("abort");
  });
});

describe("the turn ceiling", () => {
  it("stops every tool once a chat turn, delegated runs included, reaches its ceiling", async () => {
    const kv = new MemoryKv();
    const turnId = uid("turn");
    await recordCost(env.DB, { provider: "model-vendor", capability: "model", costMicroCents: cents(30), turnId, runId: uid("hub") });
    const stats = spy("3 contacts");
    const d = { registry: createToolRegistry(), handlers: { contacts_stats: stats.handler }, checks: [budgetCheck({ db: env.DB, flags: flagsOf(kv), turnId })] };
    expect((await executeToolCall(d, session(), { name: "contacts_stats", input: {} })).status).toBe("ok");
    // A delegated worker records its spend under the same turn.
    await recordCost(env.DB, { provider: "model-vendor", capability: "model", costMicroCents: cents(25), turnId, runId: uid("worker") });
    expect(await checkTurnCeiling({ db: env.DB, flags: flagsOf(kv), turnId })).toMatchObject({ allowed: false, reason: "turn_ceiling" });
    const blocked = await executeToolCall(d, session(), { name: "contacts_stats", input: {} });
    expect(blocked).toMatchObject({ status: "blocked", code: "over_budget" });
    expect(stats.calls).toHaveLength(1);
  });

  it("refuses paid third-party tools at the job cap, and leaves free tools alone", async () => {
    const kv = new MemoryKv();
    const job = uid("sourcing");
    await recordCost(env.DB, { provider: "data-vendor", capability: "lookup", costMicroCents: cents(5), job });
    const fetch = spy("page");
    const stats = spy("3");
    const d = {
      registry: createToolRegistry(),
      handlers: { web_fetch: fetch.handler, contacts_stats: stats.handler },
      checks: [budgetCheck({ db: env.DB, flags: flagsOf(kv), job, jobCapCents: 5 })],
    };
    expect(await executeToolCall(d, session(), { name: "web_fetch", input: { url: "https://www.example.com/" } })).toMatchObject({ status: "blocked", code: "over_budget" });
    expect(fetch.calls).toEqual([]);
    expect((await executeToolCall(d, session(), { name: "contacts_stats", input: {} })).status).toBe("ok");
  });

  it("treats delegations and undeclared tools as paid, so hard limits stop them", async () => {
    const kv = new MemoryKv();
    await kv.put(BUDGET_KEYS.enforcement, "hard");
    await kv.put(BUDGET_KEYS.dailyLimitCents, "0");
    const delegate = spy("worker result");
    const mystery = spy("whatever");
    const d = { registry: createToolRegistry(), handlers: { delegate_to_executor: delegate.handler, mystery_tool: mystery.handler }, checks: [budgetCheck({ db: env.DB, flags: flagsOf(kv) })] };
    expect(await executeToolCall(d, session(), { name: "delegate_to_executor", input: {} })).toMatchObject({ status: "blocked", code: "over_budget" });
    expect(await executeToolCall(d, session(), { name: "mystery_tool", input: {} })).toMatchObject({ status: "blocked", code: "over_budget" });
    expect(delegate.calls).toEqual([]);
    expect(mystery.calls).toEqual([]);
  });

  it("fails closed when the ledger cannot be read", async () => {
    const stats = spy("3");
    const d = { registry: createToolRegistry(), handlers: { contacts_stats: stats.handler }, checks: [budgetCheck({ db: failingDb(), flags: flagsOf(new MemoryKv()), turnId: uid("turn") })] };
    expect(await executeToolCall(d, session(), { name: "contacts_stats", input: {} })).toMatchObject({ status: "blocked", code: "over_budget" });
    expect(stats.calls).toEqual([]);
  });
});
