// GTM-agents: the experiments gate: a pre-registered experiment over synthetic ledger data concludes
// keep, discard or inconclusive exactly per its rules, and never earlier: not before its minimum
// age, not before both arms reach their target, not while measurement health blocks, and only on
// matured sends of the templates' current copy. Every send is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createExperiment, loadExperiment, markStarted, runExperimentCycle, pendingProposals, type ExperimentInput } from "../src/experiments/index.ts";
import { flagReader } from "../src/outreach/testing.ts";
import type { ServedTemplate } from "../src/templates/store.ts";
import { DAY, copyOf, insertLedger, iso, quiet, servedAcmeTemplates } from "./experiments-fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T09:00:00.000Z");
const T = NOW.getTime();

let counter = 0;
async function startedExperiment(templates: ServedTemplate[], patch: Partial<ExperimentInput> = {}, startedDaysAgo = 30): Promise<string> {
  counter += 1;
  const [control, treatment] = templates;
  const e = await createExperiment(
    db,
    {
      name: `Acme opener test ${counter}`,
      hypothesis: "A question about rerun time earns more positive replies than the pain statement.",
      population: "Cold first touches to general-template contacts.",
      exclusions: "Accounts already in another experiment.",
      primary_metric: "positive_reply",
      metric_window_days: 30,
      baseline_rate: 0.05,
      min_detectable_effect: 0.05,
      max_sample_per_arm: 300,
      max_duration_days: 60,
      stopping_rule: "Conclude at target and minimum age, or at max duration.",
      control_template: control?.id ?? "",
      treatment_template: treatment?.id ?? "",
      ...patch,
    },
    new Date(T - startedDaysAgo * DAY - DAY),
  );
  expect(await markStarted(db, e, "operator:test", new Date(T - startedDaysAgo * DAY), copyOf(templates))).toBe(true);
  return e.id;
}

async function arms(id: string, templates: ServedTemplate[], c: [number, number], t: [number, number], sentDaysAgo = 15): Promise<void> {
  const [control, treatment] = templates;
  if (!control || !treatment) throw new Error("two templates");
  await insertLedger(db, { templateId: control.id, sha: control.sha256, sends: c[0], positives: c[1], sentAt: iso(T - sentDaysAgo * DAY), experimentId: id, arm: "control" });
  await insertLedger(db, { templateId: treatment.id, sha: treatment.sha256, sends: t[0], positives: t[1], sentAt: iso(T - sentDaysAgo * DAY), experimentId: id, arm: "treatment" });
}

async function cycle(templates: ServedTemplate[], now: Date = NOW) {
  return runExperimentCycle({ db, flags: flagReader({}), now, log: quiet, templates: () => Promise.resolve(templates), maxRows: 20 });
}

async function retire(id: string) {
  // Keep the running count under the limit for the next scenario.
  await db.prepare("UPDATE experiments SET status = 'stopped' WHERE id = ?1 AND status = 'running'").bind(id).run();
}

describe("an experiment concludes honestly on its pre-registered metric", () => {
  it("keeps a clear winner once both arms reach target and the minimum age, and only proposes the promotion", async () => {
    const templates = await servedAcmeTemplates(db, ["keep-control", "keep-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [300, 15], [300, 45]);
    const result = await cycle(templates);
    expect(result.concluded).toEqual([{ id, verdict: "keep" }]);
    const e = await loadExperiment(db, id);
    expect(e?.status).toBe("concluded");
    expect(e?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(e?.conclusionNotes).toMatch(/^keep .*seed [0-9a-f]{10}:2026-11-09T09/);
    // Keep changes nothing by itself: it opens a proposal, and the weights are untouched.
    const proposals = await pendingProposals(db);
    expect(proposals.some((p) => p.kind === "copy_change" && p.target === `experiment:${id}`)).toBe(true);
    const flags = await env.KV.get("experiments:template_weight:keep-treatment");
    expect(flags).toBeNull();
  });

  it("discards a clear loser, and proposes nothing", async () => {
    const templates = await servedAcmeTemplates(db, ["discard-control", "discard-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [300, 45], [300, 15]);
    const result = await cycle(templates);
    expect(result.concluded).toContainEqual({ id, verdict: "discard" });
    expect((await loadExperiment(db, id))?.confidence).toBeLessThanOrEqual(0.05);
    expect((await pendingProposals(db)).some((p) => p.target === `experiment:${id}`)).toBe(false);
  });

  it("is inconclusive at target when the difference is noise", async () => {
    const templates = await servedAcmeTemplates(db, ["noise-control", "noise-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [300, 15], [300, 16]);
    const result = await cycle(templates);
    expect(result.concluded).toContainEqual({ id, verdict: "inconclusive" });
  });

  it("never concludes before the minimum age, however large the difference", async () => {
    const templates = await servedAcmeTemplates(db, ["young-control", "young-treatment"]);
    const id = await startedExperiment(templates, {}, 5);
    await arms(id, templates, [300, 10], [300, 90], 15);
    const result = await cycle(templates);
    expect(result.concluded.find((c) => c.id === id)).toBeUndefined();
    expect((await loadExperiment(db, id))?.status).toBe("running");
    await retire(id);
  });

  it("never concludes before both arms reach target", async () => {
    const templates = await servedAcmeTemplates(db, ["short-control", "short-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [299, 5], [300, 90]);
    const result = await cycle(templates);
    expect(result.concluded.find((c) => c.id === id)).toBeUndefined();
    expect((await loadExperiment(db, id))?.status).toBe("running");
    await retire(id);
  });

  it("counts only matured sends: a send younger than 10 days is not in the sample", async () => {
    const templates = await servedAcmeTemplates(db, ["fresh-control", "fresh-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [300, 15], [300, 45], 9);
    expect((await cycle(templates)).concluded.find((c) => c.id === id)).toBeUndefined();
    await retire(id);
  });

  it("counts only the current copy: sends of an edited template start afresh", async () => {
    const templates = await servedAcmeTemplates(db, ["edited-control", "edited-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [300, 15], [300, 45]);
    // The treatment's copy changes: its file hash on the templates row no longer matches the ledger.
    await db.prepare("UPDATE templates SET body_sha256 = ?2 WHERE id = ?1").bind("edited-treatment", "f".repeat(64)).run();
    expect((await cycle(templates)).concluded.find((c) => c.id === id)).toBeUndefined();
    await retire(id);
  });

  it("at max duration concludes inconclusive without 300 matured sends per arm, even with a large difference", async () => {
    const templates = await servedAcmeTemplates(db, ["max-control", "max-treatment"]);
    const id = await startedExperiment(templates, { max_duration_days: 20 }, 21);
    await arms(id, templates, [100, 2], [100, 40]);
    const result = await cycle(templates);
    expect(result.concluded).toContainEqual({ id, verdict: "inconclusive" });
    expect((await loadExperiment(db, id))?.conclusionNotes).toMatch(/at max duration; fewer than 300/);
  });

  it("a product metric waits 45 days even at target", async () => {
    const templates = await servedAcmeTemplates(db, ["product-control", "product-treatment"]);
    const id = await startedExperiment(templates, { primary_metric: "signed_up" }, 20);
    await arms(id, templates, [300, 0], [300, 0]);
    expect((await cycle(templates)).concluded.find((c) => c.id === id)).toBeUndefined();
    await retire(id);
  });
});

describe("an experiment is judged only on the copy it started with", () => {
  it("holds a decisive experiment whose treatment copy changed since it started, and tells the operator once", async () => {
    const templates = await servedAcmeTemplates(db, ["copy-control", "copy-treatment"]);
    const id = await startedExperiment(templates);
    await arms(id, templates, [300, 15], [300, 45]);
    const edited = [templates[0] as ServedTemplate, { ...(templates[1] as ServedTemplate), sha256: "c".repeat(64) }];
    const result = await cycle(edited);
    expect(result.concluded.find((c) => c.id === id)).toBeUndefined();
    expect(result.blocked).toBeGreaterThanOrEqual(1);
    expect((await loadExperiment(db, id))?.status).toBe("running");
    // Restored copy: it concludes by its rules again.
    expect((await cycle(templates)).concluded).toContainEqual({ id, verdict: "keep" });
  });
});

describe("measurement health blocks every conclusion", () => {
  it("leaves the experiment running, even past max duration, while the ledger cannot be trusted", async () => {
    const later = new Date("2027-06-01T09:00:00.000Z");
    const templates = await servedAcmeTemplates(db, ["health-control", "health-treatment"]);
    counter += 1;
    const [control, treatment] = templates;
    const e = await createExperiment(
      db,
      {
        name: "Health check",
        hypothesis: "Blocked measurement holds conclusions.",
        population: "All",
        exclusions: "None",
        metric_window_days: 30,
        baseline_rate: 0.05,
        min_detectable_effect: 0.05,
        max_sample_per_arm: 300,
        max_duration_days: 20,
        stopping_rule: "Rules.",
        control_template: control?.id ?? "",
        treatment_template: treatment?.id ?? "",
      },
      new Date(later.getTime() - 40 * DAY),
    );
    expect(await markStarted(db, e, "operator:test", new Date(later.getTime() - 30 * DAY), copyOf(templates))).toBe(true);
    if (!control || !treatment) throw new Error("two templates");
    await insertLedger(db, { templateId: control.id, sha: control.sha256, sends: 300, positives: 10, sentAt: iso(later.getTime() - 15 * DAY), experimentId: e.id, arm: "control" });
    await insertLedger(db, { templateId: treatment.id, sha: treatment.sha256, sends: 300, positives: 80, sentAt: iso(later.getTime() - 15 * DAY), experimentId: e.id, arm: "treatment" });
    // 25 recent sends with no provider evidence: the ledger coverage check blocks reply conclusions.
    await insertLedger(db, { templateId: control.id, sha: control.sha256, sends: 25, positives: 0, sentAt: iso(later.getTime() - 2 * DAY) });
    const result = await cycle(templates, later);
    expect(result.blocked).toBeGreaterThanOrEqual(1);
    expect(result.concluded.find((c) => c.id === e.id)).toBeUndefined();
    expect((await loadExperiment(db, e.id))?.status).toBe("running");
  });
});
