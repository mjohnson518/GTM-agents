// GTM-agents: the ship sandbox's model gate and cost ledger, against the suite's real database: a
// model call from the container is forwarded only while the flags are on, the system is not halted
// and the budget allows it; the daily cap for job ship_build and the per-task run ceiling stop it;
// anything unreadable refuses; and every forwarded call leaves one cost row under job ship_build
// and run ship:<task>. The upstream is a recorded response; no key or model here is real.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@gtm-agents/core";
import { memoryKv } from "@gtm-agents/core/agents/testing";
import { MICRO_CENTS_PER_CENT } from "@gtm-agents/core/budget";
import { SHIP_BUILD_JOB, createEgressContext, handleEgress, readSandboxOptions, shipRunId, type EgressProps, type EgressSetup } from "@gtm-agents/adapters/sandbox-cloudflare";
import { resetShipTables } from "../src/planning-testing.ts";
import { BUILD_ON } from "../src/sandbox-testing.ts";

const db = (env as unknown as Env).DB;
const NOW = new Date("2026-11-10T15:00:00.000Z");
const TASK = "st_gate0001";
const CODER = "ship-test-coder";
// Low-entropy on purpose, so no scanner mistakes it for a real credential.
const KEY = "m".repeat(48);
const props: EgressProps = { route: "model", taskId: TASK, host: "api.anthropic.com" };

const setup = (overrides: Partial<EgressSetup> = {}): EgressSetup => ({
  options: readSandboxOptions({}),
  coderModel: CODER,
  price: { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  provider: "anthropic",
  binding: "SHIP_SANDBOX",
  ...overrides,
});

function rig(options: { flags?: Record<string, string>; setup?: Partial<EgressSetup>; database?: D1Database } = {}) {
  const kv = memoryKv(options.flags ?? { ...BUILD_ON });
  const upstream: Request[] = [];
  const waits: Array<Promise<unknown>> = [];
  let turns = 0;
  const namespace = { getByName: (name: string) => ({ takeModelTurn: (limit: number) => Promise.resolve({ allowed: name === TASK && ++turns <= limit, turns }) }) };
  const bindings = { DB: options.database ?? db, KV: kv as unknown as KVNamespace, ANTHROPIC_API_KEY: KEY, SHIP_SANDBOX: namespace };
  const context = createEgressContext(setup(options.setup), bindings, props, {
    fetch: (input, init) => {
      upstream.push(new Request(input, init));
      return Promise.resolve(Response.json({ id: "msg_1", content: [], usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000 } }));
    },
    waitUntil: (promise) => void waits.push(promise),
    now: () => NOW,
  });
  const call = async () => {
    const request = new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "whatever-the-agent-asked-for", messages: [{ role: "user", content: "hi" }] }) });
    const response = await handleEgress(request, props, context);
    await response.text();
    await Promise.all(waits);
    return response;
  };
  return { kv, upstream, call };
}

const spend = (cents: number, fields: { job?: string; runId?: string; at?: Date } = {}) =>
  db
    .prepare("INSERT INTO cost_events (provider, capability, cost_micro_cents, job, run_id, created_at) VALUES ('anthropic', 'model', ?1, ?2, ?3, ?4)")
    .bind(cents * MICRO_CENTS_PER_CENT, fields.job ?? null, fields.runId ?? null, (fields.at ?? NOW).toISOString())
    .run();

beforeEach(async () => {
  await resetShipTables(db);
});

describe("the ship sandbox's model gate", () => {
  it("forwards a call with the Worker's key and the coder model, and records its cost under the task", async () => {
    const { upstream, call } = rig();
    expect((await call()).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(((await upstream[0]?.json()) as { model: string }).model).toBe(CODER);
    const rows = (await db.prepare("SELECT provider, capability, model, input_tokens, output_tokens, cache_read_tokens, cost_micro_cents, job, run_id FROM cost_events").all<Record<string, unknown>>()).results;
    // 1M input at 300 cents, 100K output at 1500 cents per million, 2M cache reads at a tenth of the input price.
    expect(rows).toEqual([
      { provider: "anthropic", capability: "model", model: CODER, input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 2_000_000, cost_micro_cents: (300 + 150 + 60) * MICRO_CENTS_PER_CENT, job: SHIP_BUILD_JOB, run_id: shipRunId(TASK) },
    ]);
  });

  it("refuses while a ship flag is off or unset, the system is halted, or the flags cannot be read", async () => {
    const closed: Array<[string, Record<string, string>]> = [
      ["ship:enabled off", { ...BUILD_ON, "ship:enabled": "false" }],
      ["ship:builds_enabled unset", { "ship:enabled": "true" }],
      ["halted", { ...BUILD_ON, "system:halt": JSON.stringify({ reason: "test" }) }],
    ];
    for (const [name, flags] of closed) {
      const { upstream, call } = rig({ flags });
      expect((await call()).status, name).toBe(429);
      expect(upstream, name).toHaveLength(0);
    }
    const unreadable = rig();
    unreadable.kv.failing = true;
    expect((await unreadable.call()).status).toBe(429);
    expect(unreadable.upstream).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM cost_events").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("stops at the daily cap for the build job, whatever the global budget mode", async () => {
    await spend(1999, { job: SHIP_BUILD_JOB });
    const under = rig();
    expect((await under.call()).status).toBe(200);
    // The call above cost 510 cents: today's spend for the job is now over the 2000-cent default.
    const over = rig();
    expect((await over.call()).status).toBe(429);
    expect(over.upstream).toHaveLength(0);
    // Spend by other jobs, or on another day, does not count against it.
    await resetShipTables(db);
    await spend(5000, { job: "ship_specs" });
    await spend(5000, { job: SHIP_BUILD_JOB, at: new Date("2026-11-09T23:59:00.000Z") });
    expect((await rig().call()).status).toBe(200);
  });

  it("lets the flag lower the daily cap, and an option of zero forbid all spend", async () => {
    await spend(100, { job: SHIP_BUILD_JOB });
    expect((await rig({ flags: { ...BUILD_ON, "budget:job:ship_build:daily_cents": "100" } }).call()).status).toBe(429);
    expect((await rig({ flags: { ...BUILD_ON, "budget:job:ship_build:daily_cents": "101" } }).call()).status).toBe(200);
    await resetShipTables(db);
    const zero = rig({ setup: { options: readSandboxOptions({ dailySpendCents: 0 }) } });
    expect((await zero.call()).status).toBe(429);
    expect(zero.upstream).toHaveLength(0);
  });

  it("stops one task at its run ceiling without stopping the others", async () => {
    await spend(1000, { job: SHIP_BUILD_JOB, runId: shipRunId(TASK), at: new Date("2026-11-08T10:00:00.000Z") });
    const capped = rig();
    expect((await capped.call()).status).toBe(429);
    expect(capped.upstream).toHaveLength(0);
    await resetShipTables(db);
    await spend(1000, { job: SHIP_BUILD_JOB, runId: shipRunId("st_other"), at: new Date("2026-11-08T10:00:00.000Z") });
    expect((await rig().call()).status).toBe(200);
  });

  it("refuses when the ledger or a budget setting cannot be read", async () => {
    const broken = new Proxy({} as D1Database, {
      get() {
        throw new Error("D1 is unavailable");
      },
    });
    const noLedger = rig({ database: broken });
    expect((await noLedger.call()).status).toBe(429);
    expect(noLedger.upstream).toHaveLength(0);
    const badSetting = rig({ flags: { ...BUILD_ON, "budget:daily_limit_cents": "plenty" } });
    expect((await badSetting.call()).status).toBe(429);
    expect(badSetting.upstream).toHaveLength(0);
  });

  it("forwards nothing for a coder model with no price, since its cost could not be recorded", async () => {
    const unpriced = rig({ setup: { price: undefined } });
    expect((await unpriced.call()).status).toBe(503);
    expect(unpriced.upstream).toHaveLength(0);
  });

  it("counts turns through the task's own sandbox, and refuses when that binding is missing", async () => {
    const limited = rig({ setup: { options: readSandboxOptions({ limits: { maxModelTurns: 2 } }) } });
    expect((await limited.call()).status).toBe(200);
    expect((await limited.call()).status).toBe(200);
    expect((await limited.call()).status).toBe(429);
    expect(limited.upstream).toHaveLength(2);
    // The two calls above already spent this task's run ceiling; start the next check from zero.
    await resetShipTables(db);
    const unbound = rig({ setup: { binding: "NOT_BOUND" } });
    expect((await unbound.call()).status).toBe(503);
    expect(unbound.upstream).toHaveLength(0);
  });
});
