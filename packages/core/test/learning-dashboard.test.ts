// GTM-agents: tests for the learning module's dashboard sources: a pending proposal is listed with
// its exact detail and digest, approving applies it once through the learning module and only on the
// digest the gateway verified, and a decided proposal is no longer offered.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { createLearningProposal } from "../src/learning/proposals.ts";
import { learningDashboard } from "../src/learning/dashboard.ts";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const testEnv = env as unknown as Env;

describe("learningDashboard", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM learnings_proposals").run();
  });

  it("lists a pending learning with its detail, approves it once, and stops offering it", async () => {
    const created = await createLearningProposal(env.DB, { kind: "learning", payload: { section: "writing_rules", text: "Keep first emails under ninety words." }, proposedBy: "edit_mining" }, NOW);
    if (!created.ok) throw new Error(created.problems.join("; "));
    const sources = learningDashboard<Env>().proposals ?? [];
    const source = sources[0]?.(testEnv);
    if (!source) throw new Error("no proposal source");

    const listed = await source.list(NOW);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.detail).toContain("Keep first emails under ninety words.");
    const id = listed[0]?.id ?? "";
    expect(await source.get(id, NOW)).toMatchObject({ id });

    const sourceDigest = listed[0]?.digest ?? "";
    // A digest other than the one the gateway verified is refused, and nothing is applied.
    expect((await source.approve(id, { actor: "operator:ops@acme.example", sourceDigest: "0".repeat(64), now: NOW })).ok).toBe(false);
    expect(await source.list(NOW)).toHaveLength(1);
    const first = await source.approve(id, { actor: "operator:ops@acme.example", sourceDigest, now: NOW });
    expect(first.ok).toBe(true);
    // Decided: not listed, not gettable, and a second approval does nothing.
    expect(await source.list(NOW)).toHaveLength(0);
    expect(await source.get(id, NOW)).toBeNull();
    expect((await source.approve(id, { actor: "operator:ops@acme.example", sourceDigest, now: NOW })).ok).toBe(false);
  });

  it("rejects a pending proposal", async () => {
    const created = await createLearningProposal(env.DB, { kind: "learning", payload: { section: "writing_rules", text: "Lead with the reader's problem." }, proposedBy: "retrospective" }, NOW);
    if (!created.ok) throw new Error(created.problems.join("; "));
    const source = (learningDashboard<Env>().proposals ?? [])[0]?.(testEnv);
    const id = (await source?.list(NOW))?.[0]?.id ?? "";
    expect((await source?.reject(id, { actor: "operator:ops@acme.example", reason: "not now", now: NOW }))?.ok).toBe(true);
    expect(await source?.list(NOW)).toHaveLength(0);
  });
});
