// GTM-agents: tests for the recorded-response fetch that adapter contract tests use.
import { describe, expect, it } from "vitest";
import { json, recordedFetch } from "./fetch.ts";

describe("recordedFetch", () => {
  it("answers recorded routes, keeps the calls, and refuses anything unrecorded", async () => {
    const recorded = recordedFetch([
      { method: "GET", url: "https://api.vendor.example/v1/items", respond: json({ items: [] }) },
      { method: "POST", url: /\/v1\/items$/, respond: (req) => json({ echo: req.method }), times: 1 },
    ]);
    expect(await (await recorded.fetch("https://api.vendor.example/v1/items")).json()).toEqual({ items: [] });
    expect(await (await recorded.fetch("https://api.vendor.example/v1/items", { method: "POST" })).json()).toEqual({ echo: "POST" });
    await expect(recorded.fetch("https://api.vendor.example/v1/items", { method: "POST" })).rejects.toThrow(/no recorded response/);
    await expect(recorded.fetch("https://elsewhere.example/")).rejects.toThrow(/no recorded response/);
    expect(recorded.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "GET"]);
  });
});
