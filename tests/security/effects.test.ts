// GTM-agents: the effects ledger claims each side effect exactly once, even under concurrency, and
// fails closed when the database cannot be reached.
import { claimEffect, hasEffect, releaseEffect, runOnce } from "@gtm-agents/core/events";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { failingDb, uid } from "./helpers.ts";

describe("the effects ledger", () => {
  it("lets exactly one of 20 concurrent claims win", async () => {
    const eventId = uid("evt");
    const results = await Promise.all(Array.from({ length: 20 }, () => claimEffect(env.DB, eventId, "reply_email")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await hasEffect(env.DB, eventId, "reply_email")).toBe(true);
  });

  it("keeps different effects of the same event independent", async () => {
    const eventId = uid("evt");
    expect(await claimEffect(env.DB, eventId, "reply_email")).toBe(true);
    expect(await claimEffect(env.DB, eventId, "operator_page")).toBe(true);
    expect(await claimEffect(env.DB, eventId, "reply_email")).toBe(false);
  });

  it("refuses an empty event id or effect name instead of deduplicating nothing", async () => {
    for (const [eventId, effect] of [["", "send"], ["  ", "send"], ["evt", ""], [null, "send"]] as const) {
      await expect(claimEffect(env.DB, eventId as string, effect)).rejects.toThrow(TypeError);
    }
  });

  it("allows a released claim to be claimed again", async () => {
    const eventId = uid("evt");
    expect(await claimEffect(env.DB, eventId, "send")).toBe(true);
    expect(await releaseEffect(env.DB, eventId, "send")).toBe(true);
    expect(await claimEffect(env.DB, eventId, "send")).toBe(true);
  });

  it("fails closed when claiming and open when releasing", async () => {
    await expect(claimEffect(failingDb(), uid("evt"), "send")).rejects.toThrow();
    await expect(hasEffect(failingDb(), uid("evt"), "send")).rejects.toThrow();
    expect(await releaseEffect(failingDb(), uid("evt"), "send")).toBe(false);
  });

  it("runs work once, and releases the claim when the work fails", async () => {
    const eventId = uid("evt");
    let calls = 0;
    await expect(
      runOnce(env.DB, eventId, "send", () => {
        calls += 1;
        return Promise.reject(new Error("provider down"));
      }),
    ).rejects.toThrow("provider down");
    expect(await runOnce(env.DB, eventId, "send", () => Promise.resolve(++calls))).toEqual({ ran: true, value: 2 });
    expect(await runOnce(env.DB, eventId, "send", () => Promise.resolve(++calls))).toEqual({ ran: false });
    expect(calls).toBe(2);
  });
});
