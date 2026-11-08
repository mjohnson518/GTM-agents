// GTM-agents: tests for campaign readiness: each dimension, the worst one deciding, and salvage.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addSuppression } from "../src/sending/suppression.ts";
import { assessReadiness, lintSample, readinessWithSalvage, salvageable, type ReadinessItem } from "../src/outreach/index.ts";
import { resetOutreachTables, seedContact } from "../src/outreach/testing.ts";

const NOW = new Date("2026-11-09T13:00:00.000Z");
const options = { now: NOW, domainDailyCap: 500, accountWeeklyCap: 3 };
const item = (n: number, patch: Partial<ReadinessItem> = {}): ReadinessItem => ({
  draftId: `d${n}`,
  to: `p${n}@acct${n}.example`,
  accountKey: `acct${n}.example`,
  subject: "Flaky builds",
  body: "Hi Pat,\n\nIs flaky-test time something your team tracks?\n\nAvery",
  ...patch,
});

beforeEach(async () => {
  await resetOutreachTables(env.DB);
  for (let n = 0; n < 4; n++) await seedContact(env.DB, { first: "Pat", email: `p${n}@acct${n}.example` });
});

describe("assessReadiness", () => {
  it("is GREEN when every dimension passes", async () => {
    const report = await assessReadiness(env.DB, [item(0), item(1)], options);
    expect(report.overall).toBe("green");
  });

  it("is YELLOW on a warning and RED on a block, the worst dimension deciding", async () => {
    expect((await assessReadiness(env.DB, [item(0, { body: "Hi Pat! Great! Is it tracked?" })], options)).dimensions.contentLint.status).toBe("warn");
    expect((await assessReadiness(env.DB, [item(0), item(1)], { ...options, domainDailyCap: 1 })).overall).toBe("yellow");
    expect((await assessReadiness(env.DB, [item(0)], { ...options, domainDailyCap: 0 })).overall).toBe("red");
    expect((await assessReadiness(env.DB, [item(0, { body: "TODO" })], options)).overall).toBe("red");
  });

  it("salvages RED caused only by suppression overlap or the account cap, once", async () => {
    await addSuppression(env.DB, { email: "p1@acct1.example", reason: "opt_out", source: "test" });
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO outreach_sends (id, account_key, send_path, provider, sent_at) VALUES (?1, 'acct2.example', 'cold', 'p', ?2)").bind(`os-cap-${i}`, "2026-11-06T10:00:00.000Z").run();
    }
    const items = [item(0), item(1), item(2), item(3)];
    const first = await assessReadiness(env.DB, items, options);
    expect(first.overall).toBe("red");
    expect(first.suppressedDrafts).toEqual(["d1"]);
    expect(first.overCapAccounts).toEqual(["acct2.example"]);
    expect(salvageable(first)).toBe(true);
    const decision = await readinessWithSalvage(env.DB, items, options);
    expect(decision.salvaged).toBe(true);
    expect(decision.items.map((i) => i.draftId)).toEqual(["d0", "d3"]);
    expect(decision.report.overall).toBe("green");
  });

  it("never salvages RED from anything else", async () => {
    const decision = await readinessWithSalvage(env.DB, [item(0, { body: "TODO" })], options);
    expect(decision.salvaged).toBe(false);
    expect(decision.report.overall).toBe("red");
  });

  it("blocks a dimension whose data cannot be read", async () => {
    const broken = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("down")), all: () => Promise.reject(new Error("down")) }), first: () => Promise.reject(new Error("down")), all: () => Promise.reject(new Error("down")) }) } as unknown as D1Database;
    const report = await assessReadiness(broken, [item(0)], options);
    expect(report.overall).toBe("red");
    expect(report.suppressionUnreadable).toBe(true);
    expect(salvageable(report)).toBe(false);
  });

  it("samples the first, the last and evenly between for the lint", () => {
    expect(lintSample([1, 2, 3])).toEqual([1, 2, 3]);
    expect(lintSample(Array.from({ length: 9 }, (_, i) => i))).toEqual([0, 2, 4, 6, 8]);
  });
});
