// GTM-agents: rate limits count calls per category and fail open, because they are bookkeeping.
import { executeToolCall } from "@gtm-agents/core/runtime";
import { rateLimitCheck } from "@gtm-agents/core/runtime";
import { RATE_LIMITS, checkRateLimit, createToolRegistry } from "@gtm-agents/core/security";
import { describe, expect, it } from "vitest";
import { MemoryKv, session, spy } from "./helpers.ts";

const limits = { web: { max: 2, windowSeconds: 60 } };
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

describe("rate limits", () => {
  it("allow calls up to the limit, then refuse until the window ends", async () => {
    const kv = new MemoryKv();
    expect(await checkRateLimit(kv, "web", "global", { limits, now: T0 })).toEqual({ allowed: true, remaining: 1 });
    expect(await checkRateLimit(kv, "web", "global", { limits, now: T0 + 1000 })).toEqual({ allowed: true, remaining: 0 });
    expect(await checkRateLimit(kv, "web", "global", { limits, now: T0 + 2000 })).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 58 });
    expect((await checkRateLimit(kv, "web", "global", { limits, now: T0 + 60_000 })).allowed).toBe(true);
  });

  it("count each identifier separately", async () => {
    const kv = new MemoryKv();
    for (let i = 0; i < 2; i++) await checkRateLimit(kv, "web", "alpha", { limits, now: T0 });
    expect((await checkRateLimit(kv, "web", "alpha", { limits, now: T0 })).allowed).toBe(false);
    expect((await checkRateLimit(kv, "web", "beta", { limits, now: T0 })).allowed).toBe(true);
  });

  it("treat a malformed limit as no limit", async () => {
    expect((await checkRateLimit(new MemoryKv(), "web", "global", { limits: { web: { max: 1, windowSeconds: 0 } } })).allowed).toBe(true);
  });

  it("do not limit a category with no configured limit", async () => {
    expect(await checkRateLimit(new MemoryKv(), "unlisted", "global")).toEqual({ allowed: true, remaining: Number.POSITIVE_INFINITY });
    expect(Object.keys(RATE_LIMITS)).toEqual(expect.arrayContaining(["web", "search", "enrichment", "mail", "esp", "git_write", "sandbox", "code_mode", "billing"]));
  });

  it("fail open when KV cannot be read or is missing", async () => {
    const kv = new MemoryKv();
    kv.failing = true;
    expect(await checkRateLimit(kv, "web", "global", { limits })).toEqual({ allowed: true, remaining: -1, degraded: true });
    expect((await checkRateLimit(undefined, "web", "global", { limits })).degraded).toBe(true);
  });

  it("refuse a tool call over the limit before the handler runs, and ignore tools without a category", async () => {
    const kv = new MemoryKv();
    const fetch = spy("page");
    const stats = spy("3");
    const d = { registry: createToolRegistry(), handlers: { web_fetch: fetch.handler, contacts_stats: stats.handler }, checks: [rateLimitCheck({ kv, limits, now: () => T0 })] };
    const call = () => executeToolCall(d, session(), { name: "web_fetch", input: { url: "https://www.example.com/" } });
    expect((await call()).status).toBe("ok");
    expect((await call()).status).toBe("ok");
    expect(await call()).toMatchObject({ status: "blocked", code: "rate_limited" });
    expect(fetch.calls).toHaveLength(2);
    for (let i = 0; i < 5; i++) expect((await executeToolCall(d, session(), { name: "contacts_stats", input: {} })).status).toBe("ok");
  });
});
