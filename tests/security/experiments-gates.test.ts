// GTM-agents: the experiments module's safety properties. Every switch ships off. No code path in
// the module applies a copy change or writes a setting except the operator's approve command. Every
// random choice comes from a seeded generator. Conclusions are blocked while measurement health is
// unreadable or blocks. Metrics are counted only in the metrics module. Everything here is synthetic.
import { describe, expect, it } from "vitest";
import { FLAGS } from "@gtm-agents/core/flags";
import { evaluateExperiment, guardrailFloors, applyFloors, type ExperimentRecord } from "@gtm-agents/core/experiments";
import { unreadableHealth } from "@gtm-agents/core/metrics";

const sources = import.meta.glob<string>("../../packages/core/src/experiments/*.ts", { query: "?raw", import: "default", eager: true });
const statsSources = import.meta.glob<string>(["../../packages/core/src/metrics/experiment-stats.ts", "../../packages/core/src/reports/ab.ts"], { query: "?raw", import: "default", eager: true });
const file = (name: string) => Object.entries(sources).find(([path]) => path.endsWith(`/experiments/${name}`))?.[1] ?? "";
// Comments describe the rules in words; only code is checked.
const code = (text: string) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("flags", () => {
  it("every experiments switch defaults off and is registered", () => {
    const byKey = new Map(FLAGS.map((f) => [f.key, f]));
    expect(byKey.get("experiments:enabled")?.default).toBe("false");
    expect(byKey.get("experiments:self_review_enabled")?.default).toBe("false");
    expect(byKey.get("outreach:send_time_experiment")?.default).toBe("false");
    expect(byKey.get("outreach:allocation_mode")?.default).toBe("weighted");
    expect(byKey.get("experiments:template_weight:<template>")?.default).toBeNull();
  });
});

describe("only a person applies a change", () => {
  it("nothing in the module writes to the flag store except the approve path in proposals.ts", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [path, text] of Object.entries(sources)) {
      const writes = /\.put\(/.test(code(text));
      if (path.endsWith("/proposals.ts")) expect(writes).toBe(true);
      else expect(writes, path).toBe(false);
    }
  });

  it("the jobs never receive a flag store to write with", () => {
    for (const name of ["cycle.ts", "self-review.ts", "jobs.ts", "plan.ts"]) expect(code(file(name)), name).not.toMatch(/approveProposal|\bkv\.put|KV\.put/);
  });

  it("an approval re-checks the setting and claims the proposal before writing", () => {
    const text = code(file("proposals.ts"));
    expect(text).toMatch(/norm\(raw\) !== norm\(p\.current\)/);
    const claimAt = text.indexOf("await claim(deps.db, p.id");
    const putAt = text.indexOf("await deps.kv.put(p.target");
    expect(claimAt).toBeGreaterThan(0);
    expect(putAt).toBeGreaterThan(claimAt);
  });
});

describe("randomness is seeded", () => {
  it("no experiments, statistics or dashboard code calls Math.random or an unseeded generator", () => {
    for (const [path, text] of [...Object.entries(sources), ...Object.entries(statsSources)]) expect(code(text), path).not.toMatch(/Math\.random|crypto\.getRandomValues/);
  });
});

describe("metrics are counted in one place", () => {
  it("the experiments module never reads reply or positive-reply columns itself", () => {
    for (const [path, text] of Object.entries(sources)) expect(code(text), path).not.toMatch(/positive_reply_at|replied_at|reply_intent/);
  });
});

describe("conclusions fail closed", () => {
  const record: ExperimentRecord = {
    id: "0000000001",
    name: "synthetic",
    hypothesis: "h",
    variable: "template",
    controlTemplateId: "a",
    treatmentTemplateId: "b",
    primaryMetric: "positive_reply",
    status: "running",
    population: "p",
    exclusions: "e",
    metricWindowDays: 30,
    baselineRate: 0.05,
    minDetectableEffect: 0.05,
    targetPerArm: 300,
    maxSamplePerArm: 300,
    maxDurationDays: 10,
    stoppingRule: "s",
    controlSha: null,
    treatmentSha: null,
    approver: "operator:test",
    startedAt: "2026-01-01T00:00:00.000Z",
    concludedAt: null,
    promotedAt: null,
    confidence: null,
    conclusionNotes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("unreadable measurement health blocks even a decisive experiment past its max duration", () => {
    const evaluation = evaluateExperiment({
      experiment: record,
      samples: { control: { sends: 1000, successes: 10 }, treatment: { sends: 1000, successes: 200 } },
      health: unreadableHealth(),
      now: new Date("2026-11-09T00:00:00.000Z"),
      rng: () => 0.5,
    });
    expect(evaluation.status).toBe("blocked");
  });

  it("the protected control's share never falls under its floor", () => {
    for (let k = 1; k <= 4; k++) {
      const arms = [{ control: true }, ...Array.from({ length: k }, () => ({ control: false }))];
      const floors = guardrailFloors(arms);
      expect(floors.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(0.5 + 1e-12);
      const shares = applyFloors([0, ...Array.from({ length: k }, () => 1 / k)], floors);
      expect(shares[0]).toBeGreaterThanOrEqual(0.2 - 1e-12);
    }
  });
});
