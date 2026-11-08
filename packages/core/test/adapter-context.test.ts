// GTM-agents: tests for the AdapterContext core builds for adapters.
import { describe, expect, it } from "vitest";
import { createAdapterContext } from "../src/adapters/index.ts";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("createAdapterContext", () => {
  it("reads secrets from the environment and refuses a missing required one", () => {
    const ctx = createAdapterContext({ name: "data-example", env: { EXAMPLE_KEY: "k", EMPTY: "" }, logger: silent });
    expect(ctx.secret("EXAMPLE_KEY")).toBe("k");
    expect(() => ctx.secret("MISSING_KEY")).toThrow(/wrangler secret put MISSING_KEY/);
    expect(ctx.optionalSecret("EMPTY")).toBeUndefined();
  });

  it("passes the adapter its own options from the config", () => {
    const ctx = createAdapterContext({
      name: "data-example",
      env: {},
      logger: silent,
      config: { adapters: { "data-example": { enabled: true, options: { region: "eu" } } } },
    });
    expect(ctx.options).toEqual({ region: "eu" });
  });

  it("times out a request that does not answer", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      });
    const ctx = createAdapterContext({ name: "data-example", env: {}, logger: silent, fetch: hanging, timeoutMs: 20 });
    await expect(ctx.fetch("https://api.vendor.example/v1")).rejects.toThrow();
  });
});
