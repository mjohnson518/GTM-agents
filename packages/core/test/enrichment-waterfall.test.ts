// GTM-agents: the email waterfall keeps only clean work addresses, runs later finders only behind
// their flag, stops a failing provider, and asks the spend gate before every paid call.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { jobCapKey } from "../src/budget/gate.ts";
import { runEmailWaterfall, type WaterfallOptions } from "../src/enrichment/waterfall.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { fakeFinder, flagsOf, resetSourcingTables } from "./sourcing-fakes.ts";

beforeEach(() => resetSourcingTables(env.DB));

const input = { firstName: "Jane", lastName: "Doe", account: "brightloop.example", tried: [] as string[] };
const options = (finders: WaterfallOptions["finders"], extra: Partial<WaterfallOptions> = {}): WaterfallOptions => ({
  finders,
  waterfallEnabled: false,
  gate: createSpendGate({ db: env.DB, flags: flagsOf(), job: "waterfall_test" }),
  disabled: new Set(),
  ...extra,
});

describe("runEmailWaterfall", () => {
  it("uses a clean address the people provider already returned, without paying a finder", async () => {
    const finder = fakeFinder("finder-a", {});
    const result = await runEmailWaterfall({ ...input, provided: { email: "Jane.Doe@brightloop.example", provider: "people-x", confidence: 88 } }, options([finder]));
    expect(result.found).toMatchObject({ email: "jane.doe@brightloop.example", provider: "people-x", confidence: 88 });
    expect(finder.calls).toHaveLength(0);
  });

  it("drops a provided personal address and moves on to the finder", async () => {
    const finder = fakeFinder("finder-a", { "jane doe@brightloop.example": "jane@brightloop.example" });
    const result = await runEmailWaterfall({ ...input, provided: { email: "jane.doe@gmail.com", provider: "people-x" } }, options([finder]));
    expect(result.steps[0]).toMatchObject({ step: "provided:people-x", outcome: "personal" });
    expect(result.found?.email).toBe("jane@brightloop.example");
  });

  it("keeps only an address at the candidate's domain, never a personal or role mailbox", async () => {
    for (const [address, outcome] of [
      ["jane@gmail.com", "personal"],
      ["jane@northwind.example", "off_domain"],
      ["info@brightloop.example", "role"],
    ] as const) {
      const finder = fakeFinder("finder-a", { "jane doe@brightloop.example": address });
      const result = await runEmailWaterfall(input, options([finder]));
      expect(result.found, address).toBeNull();
      expect(result.steps[0]?.outcome).toBe(outcome);
    }
  });

  it("runs finders after the first only while the waterfall flag is on", async () => {
    const a = fakeFinder("finder-a", {});
    const b = fakeFinder("finder-b", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    expect((await runEmailWaterfall(input, options([a, b]))).found).toBeNull();
    expect(b.calls).toHaveLength(0);
    const on = await runEmailWaterfall(input, options([a, b], { waterfallEnabled: true }));
    expect(on.found).toMatchObject({ email: "jane.doe@brightloop.example", provider: "finder-b" });
    expect(on.steps.map((s) => s.step)).toEqual(["finder:finder-a", "finder:finder-b"]);
  });

  it("never repeats a step already tried", async () => {
    const a = fakeFinder("finder-a", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    const result = await runEmailWaterfall({ ...input, tried: ["finder:finder-a"] }, options([a]));
    expect(result.found).toBeNull();
    expect(a.calls).toHaveLength(0);
  });

  it("stops every later step from a provider that failed", async () => {
    const a = fakeFinder("finder-a", { "jane doe@brightloop.example": "throw" });
    const opts = options([a]);
    const first = await runEmailWaterfall(input, opts);
    expect(first.steps[0]?.outcome).toBe("error");
    expect(opts.disabled.has("finder-a")).toBe(true);
    await runEmailWaterfall({ ...input, firstName: "John" }, opts);
    expect(a.calls).toHaveLength(1);
  });

  it("needs a first and a last name before paying a finder", async () => {
    const a = fakeFinder("finder-a", {});
    const result = await runEmailWaterfall({ ...input, lastName: null }, options([a]));
    expect(result.steps[0]).toMatchObject({ outcome: "skipped" });
    expect(a.calls).toHaveLength(0);
  });

  it("asks the spend gate before each call and records what it cost", async () => {
    const a = fakeFinder("finder-a", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    const capped = createSpendGate({ db: env.DB, flags: flagsOf({ [jobCapKey("waterfall_capped")]: "0" }), job: "waterfall_capped" });
    const stopped = await runEmailWaterfall(input, options([a], { gate: capped }));
    expect(stopped).toMatchObject({ found: null, budgetStopped: true });
    expect(a.calls).toHaveLength(0);
    await runEmailWaterfall(input, options([a]));
    const cost = await env.DB.prepare("SELECT provider, capability, job, cost_micro_cents FROM cost_events").first();
    expect(cost).toMatchObject({ provider: "finder-a", capability: "email_find", job: "waterfall_test", cost_micro_cents: 20_000 });
  });
});
