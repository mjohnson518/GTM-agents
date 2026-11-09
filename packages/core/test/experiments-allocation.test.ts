// GTM-agents: Thompson allocation with guardrails, account-clustered assignment and the statistics
// under them: seeded and reproducible, a protected control that is never starved, floors that never
// total more than half, at most four arms plus the control, cells that decide only when ready,
// colleagues who always share an arm, and arms that are never filled past their cap. Pure.
import { describe, expect, it } from "vitest";
import {
  CONTROL_FLOOR,
  applyFloors,
  buildCellTable,
  chooseArms,
  decideCell,
  guardrailFloors,
  planAssignments,
  thompsonReady,
  thompsonShares,
  unitKey,
  type ExperimentRecord,
  type ThompsonArm,
} from "../src/experiments/index.ts";
import { probabilityBest, probabilityBetterMonteCarlo, probabilityBetterNormal, sampleSizePerArm, systematicCounts } from "../src/metrics/index.ts";
import { seededRng } from "../src/outreach/holdout.ts";

describe("statistics", () => {
  it("the sample-size helper matches the two-sided 95%, 80% power normal approximation", () => {
    expect(sampleSizePerArm(0.05, 0.05)).toBe(435);
    expect(sampleSizePerArm(0.1, 0.05)).toBe(686);
    expect(sampleSizePerArm(0, 0.05)).toBeNull();
    expect(sampleSizePerArm(0.5, 0.6)).toBeNull();
  });

  it("Monte Carlo estimates are reproducible from their seed", () => {
    const a = probabilityBetterMonteCarlo({ sends: 300, successes: 30 }, { sends: 300, successes: 20 }, seededRng("2026-11-09:seed"));
    const b = probabilityBetterMonteCarlo({ sends: 300, successes: 30 }, { sends: 300, successes: 20 }, seededRng("2026-11-09:seed"));
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0.85);
    const best = probabilityBest([{ alpha: 31, beta: 271 }, { alpha: 21, beta: 281 }], seededRng("x"));
    expect(best[0] ?? 0).toBeCloseTo(1 - (best[1] ?? 0), 10);
  });

  it("the normal approximation is deterministic and symmetric", () => {
    const p = probabilityBetterNormal({ sends: 300, successes: 45 }, { sends: 300, successes: 15 });
    expect(p).toBeGreaterThan(0.999);
    expect(probabilityBetterNormal({ sends: 300, successes: 15 }, { sends: 300, successes: 45 })).toBeCloseTo(1 - p, 6);
    expect(probabilityBetterNormal({ sends: 100, successes: 5 }, { sends: 100, successes: 5 })).toBeCloseTo(0.5, 6);
  });

  it("systematic sampling gives whole counts that add up and stay within one of their share", () => {
    for (let s = 0; s < 50; s++) {
      const rng = seededRng(`counts:${s}`);
      const shares = [0.2, 0.35, 0.45];
      const n = 7 + s;
      const counts = systematicCounts(shares, n, rng);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
      counts.forEach((c, i) => expect(Math.abs(c - (shares[i] ?? 0) * n)).toBeLessThan(1 + 1e-9));
    }
  });
});

const arms = (k: number): ThompsonArm[] => [{ id: "control", control: true, weight: 1 }, ...Array.from({ length: k }, (_, i) => ({ id: `arm${i + 1}`, control: false, weight: 1 }))];

describe("guardrails", () => {
  it("the control's floor is 20% and the others share at most 30% of floors", () => {
    expect(guardrailFloors(arms(1))).toEqual([0.2, 0.15]);
    expect(guardrailFloors(arms(2))).toEqual([0.2, 0.15, 0.15]);
    const four = guardrailFloors(arms(4));
    expect(four[0]).toBe(0.2);
    expect(four.reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 6);
    four.slice(1).forEach((f) => expect(f).toBeCloseTo(0.075, 10));
  });

  it("a hopeless control still gets its 20%, and shares add up to 1", () => {
    const shares = applyFloors([0, 1, 0], guardrailFloors(arms(2)));
    expect(shares[0]).toBeCloseTo(CONTROL_FLOOR, 10);
    expect(shares[2]).toBeCloseTo(0.15, 10);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("offers at most four arms plus the protected control, keeping the named control", () => {
    const general = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, weight: 10 - i }));
    const chosen = chooseArms(general, "f");
    expect(chosen.arms[0]).toEqual({ id: "f", control: true, weight: 5 });
    expect(chosen.arms).toHaveLength(5);
    expect(chosen.dropped).toEqual(["e"]);
    expect(chooseArms(general, null).arms[0]?.id).toBe("a");
  });
});

describe("Thompson shares and cells", () => {
  const sample = (templateId: string, sends: number, positives: number, segment = "fintech", teamSize = "50-200", persona = "platform-champion") => ({ templateId, segment, teamSize, persona, sends, positives });
  const two: ThompsonArm[] = [
    { id: "control", control: true, weight: 1 },
    { id: "arm1", control: false, weight: 1 },
  ];

  it("waits for 50 matured sends in every arm, counting real sends only", () => {
    expect(thompsonReady(buildCellTable([sample("control", 60, 3), sample("arm1", 49, 5)]), two)).toBe(false);
    expect(thompsonReady(buildCellTable([sample("control", 60, 3), sample("arm1", 50, 5)]), two)).toBe(true);
  });

  it("a cell decides only when every arm has 150 matured sends in it, most specific first", () => {
    const table = buildCellTable([sample("control", 200, 10), sample("arm1", 149, 30), sample("control", 10, 1, "fintech", "50-200", "economic-buyer"), sample("arm1", 10, 1, "fintech", "50-200", "economic-buyer")]);
    // The persona cell has only 149 for arm1, so the segment|team size cell (159) decides.
    const d = decideCell(table, two, { segment: "Fintech", teamSize: "50-200", persona: "platform-champion" });
    expect(d.cell).toBe("fintech|50-200");
    const pooled = decideCell(table, two, { segment: "healthcare", teamSize: null, persona: null });
    expect(pooled.cell).toBeNull();
  });

  it("shrinks a cell toward its parent with 50 pseudo-sends", () => {
    const table = buildCellTable([sample("control", 150, 0, "a", "x", "p"), sample("arm1", 150, 0, "a", "x", "p"), sample("control", 850, 85, "a", "x", "q"), sample("arm1", 850, 85, "a", "x", "q")]);
    const d = decideCell(table, two, { segment: "a", teamSize: "x", persona: "p" });
    expect(d.cell).toBe("a|x|p");
    // Parent a|x has a rate of 85/1000 = 0.085 per arm: alpha = 1 + 0 + 50 * 0.085.
    expect(d.posteriors[0]?.alpha).toBeCloseTo(1 + 50 * 0.085, 10);
    expect(d.posteriors[0]?.beta).toBeCloseTo(1 + 150 + 50 * 0.915, 10);
  });

  it("favors the better arm but never below the floors, reproducibly", () => {
    const table = buildCellTable([sample("control", 400, 8), sample("arm1", 400, 40)]);
    const d = decideCell(table, two, { segment: null, teamSize: null, persona: null });
    const s1 = thompsonShares(d, two, seededRng("batch:1"));
    const s2 = thompsonShares(d, two, seededRng("batch:1"));
    expect(s1).toEqual(s2);
    expect(s1[0]).toBeGreaterThanOrEqual(CONTROL_FLOOR - 1e-12);
    expect(s1[1]).toBeGreaterThan(0.75);
  });
});

function experiment(id: string, cap: number, startedDaysAgo = 1, maxDuration = 42): ExperimentRecord {
  const now = Date.parse("2026-11-09T00:00:00.000Z");
  return {
    id,
    name: id,
    hypothesis: "h",
    variable: "template",
    controlTemplateId: "ctl",
    treatmentTemplateId: "trt",
    primaryMetric: "positive_reply",
    status: "running",
    population: "p",
    exclusions: "e",
    metricWindowDays: 30,
    baselineRate: 0.05,
    minDetectableEffect: 0.05,
    targetPerArm: cap,
    maxSamplePerArm: cap,
    maxDurationDays: maxDuration,
    stoppingRule: "s",
    controlSha: null,
    treatmentSha: null,
    approver: "operator:test",
    startedAt: new Date(now - startedDaysAgo * 86_400_000).toISOString(),
    concludedAt: null,
    promotedAt: null,
    confidence: null,
    conclusionNotes: null,
    createdAt: new Date(now - 10 * 86_400_000).toISOString(),
  };
}

describe("account-clustered assignment", () => {
  const both = new Set(["ctl", "trt", "other"]);
  const now = new Date("2026-11-09T00:00:00.000Z");

  it("colleagues share their account's arm; a contact without an account is its own unit", () => {
    expect(unitKey({ id: "c1", account_key: "globex.example" })).toBe("globex.example");
    expect(unitKey({ id: "c2", account_key: null })).toBe("contact:c2");
    const planned = planAssignments({
      experiments: [experiment("e1", 100)],
      units: [{ unit: "globex.example", eligible: [both, both, both] }],
      pins: new Map(),
      loads: new Map(),
      sizes: new Map([["globex.example", 3]]),
      seed: "2026-11-09:s",
      rng: seededRng("a"),
      now,
    });
    expect(planned.arms.get("globex.example")?.isNew).toBe(true);
  });

  it("a pinned account keeps its arm, whatever the room", () => {
    const planned = planAssignments({
      experiments: [experiment("e1", 1)],
      units: [{ unit: "initrode.example", eligible: [both] }],
      pins: new Map([["e1", new Map([["initrode.example", "treatment"]])]]),
      loads: new Map([["e1", { control: 1, treatment: 1 }]]),
      sizes: new Map([["initrode.example", 5]]),
      seed: "s",
      rng: seededRng("b"),
      now,
    });
    expect(planned.arms.get("initrode.example")).toEqual({ experimentId: "e1", arm: "treatment", templateId: "trt", isNew: false });
  });

  it("a pinned account's colleagues are never offered the other arm: frozen copy or an arm past its cap restricts both templates", () => {
    const pins = new Map([["e1", new Map([["globex.example", "control"]])]]);
    const frozen = planAssignments({ experiments: [experiment("e1", 100)], frozen: new Set(["e1"]), units: [{ unit: "globex.example", eligible: [both] }], pins, loads: new Map(), sizes: new Map(), seed: "s", rng: seededRng("f"), now });
    expect(frozen.arms.size).toBe(0);
    expect([...(frozen.restricted.get("globex.example") ?? [])].sort()).toEqual(["ctl", "trt"]);
    const full = planAssignments({ experiments: [experiment("e1", 10)], units: [{ unit: "globex.example", eligible: [both] }], pins, loads: new Map([["e1", { control: 11, treatment: 3 }]]), sizes: new Map(), seed: "s", rng: seededRng("f"), now });
    expect(full.arms.size).toBe(0);
    expect(full.restricted.has("globex.example")).toBe(true);
    // A unit pinned excluded never enrolls in that experiment.
    const out = planAssignments({ experiments: [experiment("e1", 100)], units: [{ unit: "initech.example", eligible: [both] }], pins: new Map([["e1", new Map([["initech.example", "excluded"]])]]), loads: new Map(), sizes: new Map(), seed: "s", rng: seededRng("f"), now });
    expect(out.arms.size).toBe(0);
  });

  it("an unpinned account enters only if its arm has room for every member, and never fills an arm past its cap", () => {
    const units = Array.from({ length: 60 }, (_, i) => ({ unit: `acct${i}.example`, eligible: [both] }));
    const sizes = new Map(units.map((u, i) => [u.unit, i % 3 === 0 ? 4 : 1]));
    const planned = planAssignments({ experiments: [experiment("e1", 20)], units, pins: new Map(), loads: new Map([["e1", { control: 5, treatment: 0 }]]), sizes, seed: "s", rng: seededRng("c"), now });
    const load = { control: 5, treatment: 0 };
    for (const [unit, p] of planned.arms) load[p.arm] += sizes.get(unit) ?? 1;
    expect(load.control).toBeLessThanOrEqual(20);
    expect(load.treatment).toBeLessThanOrEqual(20);
    expect(planned.arms.size).toBeLessThan(60);
  });

  it("enrolls no one new once the experiment reached its max duration, and only units that may get both templates", () => {
    const old = planAssignments({ experiments: [experiment("e1", 100, 50, 42)], units: [{ unit: "a.example", eligible: [both] }], pins: new Map(), loads: new Map(), sizes: new Map(), seed: "s", rng: seededRng("d"), now });
    expect(old.arms.size).toBe(0);
    const targeted = planAssignments({ experiments: [experiment("e1", 100)], units: [{ unit: "b.example", eligible: [new Set(["ctl"])] }], pins: new Map(), loads: new Map(), sizes: new Map(), seed: "s", rng: seededRng("d"), now });
    expect(targeted.arms.size).toBe(0);
  });

  it("a unit belongs to one experiment, and the same seed plans the same arms", () => {
    const input = { experiments: [experiment("e1", 100), experiment("e2", 100)], units: Array.from({ length: 20 }, (_, i) => ({ unit: `u${i}.example`, eligible: [both] })), pins: new Map(), loads: new Map(), sizes: new Map(), seed: "s", now };
    const a = planAssignments({ ...input, rng: seededRng("same") });
    const b = planAssignments({ ...input, rng: seededRng("same") });
    expect([...a.arms.entries()]).toEqual([...b.arms.entries()]);
    expect([...a.arms.values()].every((p) => p.experimentId === "e1")).toBe(true);
  });
});
