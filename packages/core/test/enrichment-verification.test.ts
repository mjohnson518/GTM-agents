// GTM-agents: verification semantics: the cache and its lifetimes, confidence grades, the promotion
// policy, and paid calls that go through the spend gate.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { jobCapKey } from "../src/budget/gate.ts";
import {
  cacheVerification,
  emailConfidence,
  freshVerification,
  isFresh,
  passesPromotionPolicy,
  readCachedVerification,
  verifyAddress,
} from "../src/enrichment/verification.ts";
import { AdapterError } from "../src/ports/types.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { fakeVerifier, flagsOf, resetSourcingTables } from "./sourcing-fakes.ts";

const now = new Date("2026-11-04T09:00:00.000Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const gate = (flags = flagsOf(), job = "verify_test") => createSpendGate({ db: env.DB, flags, job, runId: "run-verify" });

beforeEach(() => resetSourcingTables(env.DB));

describe("freshness", () => {
  it("keeps conclusive results 90 days and unknown results 7", () => {
    expect(isFresh({ status: "deliverable", verifiedAt: daysAgo(89) }, now)).toBe(true);
    expect(isFresh({ status: "deliverable", verifiedAt: daysAgo(91) }, now)).toBe(false);
    expect(isFresh({ status: "unknown", verifiedAt: daysAgo(6) }, now)).toBe(true);
    expect(isFresh({ status: "unknown", verifiedAt: daysAgo(8) }, now)).toBe(false);
    expect(isFresh({ status: "risky", verifiedAt: "not a date" }, now)).toBe(false);
  });
});

describe("confidence and policy", () => {
  it("grades deliverable by score, risky as low, and anything else as unusable", () => {
    expect(emailConfidence({ status: "deliverable", score: 95, disposable: false })).toBe("high");
    expect(emailConfidence({ status: "deliverable", score: 75, disposable: null })).toBe("medium");
    expect(emailConfidence({ status: "deliverable", score: null, disposable: null })).toBe("medium");
    expect(emailConfidence({ status: "deliverable", score: 40, disposable: null })).toBe("low");
    expect(emailConfidence({ status: "risky", score: 50, disposable: false })).toBe("low");
    expect(emailConfidence({ status: "unknown", score: null, disposable: null })).toBeNull();
    expect(emailConfidence({ status: "deliverable", score: 99, disposable: true })).toBeNull();
  });

  it("promotes only deliverable under strict, risky too under allow_risky, and never unknown, undeliverable or disposable", () => {
    expect(passesPromotionPolicy({ status: "deliverable", disposable: null }, "strict")).toBe(true);
    expect(passesPromotionPolicy({ status: "risky", disposable: null }, "strict")).toBe(false);
    expect(passesPromotionPolicy({ status: "risky", disposable: null }, "allow_risky")).toBe(true);
    for (const status of ["unknown", "undeliverable"] as const) expect(passesPromotionPolicy({ status, disposable: null }, "allow_risky")).toBe(false);
    expect(passesPromotionPolicy({ status: "deliverable", disposable: true }, "allow_risky")).toBe(false);
  });
});

describe("verifyAddress", () => {
  it("calls the verifier once, caches by address hash, and reuses the fresh result", async () => {
    const verifier = fakeVerifier("fake-verifier");
    const first = await verifyAddress("jane.doe@brightloop.example", { db: env.DB, verifier, gate: gate(), now });
    const second = await verifyAddress("jane.doe@brightloop.example", { db: env.DB, verifier, gate: gate(), now });
    expect(verifier.calls).toEqual(["jane.doe@brightloop.example"]);
    expect(first).toMatchObject({ ok: true, record: { status: "deliverable", cached: false } });
    expect(second).toMatchObject({ ok: true, record: { status: "deliverable", cached: true } });
    const stored = await env.DB.prepare("SELECT * FROM email_verifications").all<Record<string, unknown>>();
    expect(stored.results).toHaveLength(1);
    expect(JSON.stringify(stored.results)).not.toContain("jane.doe");
    const cost = await env.DB.prepare("SELECT provider, capability, job, run_id, cost_micro_cents FROM cost_events").first();
    expect(cost).toMatchObject({ provider: "fake-verifier", capability: "email_verify", job: "verify_test", run_id: "run-verify", cost_micro_cents: 10_000 });
  });

  it("verifies again once the cached result has expired", async () => {
    await cacheVerification(env.DB, "jane.doe@brightloop.example", { status: "unknown", provider: "old", score: null, acceptAll: null, disposable: null, reason: null, verifiedAt: daysAgo(10) });
    expect(await freshVerification(env.DB, "jane.doe@brightloop.example", now)).toBeNull();
    expect((await readCachedVerification(env.DB, "jane.doe@brightloop.example"))?.status).toBe("unknown");
    const verifier = fakeVerifier("fake-verifier");
    await verifyAddress("jane.doe@brightloop.example", { db: env.DB, verifier, gate: gate(), now });
    expect(verifier.calls).toHaveLength(1);
    expect((await freshVerification(env.DB, "jane.doe@brightloop.example", now))?.status).toBe("deliverable");
  });

  it("does not call the verifier when the budget refuses, or when there is none", async () => {
    const verifier = fakeVerifier("fake-verifier");
    const capped = gate(flagsOf({ [jobCapKey("verify_capped")]: "0" }), "verify_capped");
    expect(await verifyAddress("jane.doe@brightloop.example", { db: env.DB, verifier, gate: capped, now })).toMatchObject({ ok: false, reason: "budget" });
    expect(verifier.calls).toHaveLength(0);
    expect(await verifyAddress("jane.doe@brightloop.example", { db: env.DB, verifier: undefined, gate: gate(), now })).toMatchObject({ ok: false, reason: "no_verifier" });
  });

  it("reports a provider error without caching anything", async () => {
    const verifier = { name: "broken", verify: () => Promise.reject(new AdapterError("quota reached", "quota", false)) };
    expect(await verifyAddress("jane.doe@brightloop.example", { db: env.DB, verifier, gate: gate(), now })).toMatchObject({ ok: false, reason: "error", detail: "quota", retryable: false });
    expect(await readCachedVerification(env.DB, "jane.doe@brightloop.example")).toBeNull();
  });
});
