// GTM-agents: Thompson sampling with guardrails: how the cold batch splits general first touches
// among templates once outreach:allocation_mode is thompson. Pure: the planner (plan.ts) reads the
// samples and hands in a seeded generator.
//
//   - Arms are the general (untargeted) templates the batch may use: the protected control plus at
//     most MAX_ARMS others, highest volume weight first. Targeted templates keep segment routing.
//   - Each arm's posterior is Beta(1 + positives, 1 + sends - positives) over matured samples
//     (metrics/experiments.ts), and its share is P(arm is best) by Monte Carlo
//     (MONTE_CARLO_DRAWS draws).
//   - Until every arm has MIN_MATURED_PER_ARM matured sends, the operator's volume weights apply
//     instead (readiness counts real sends only).
//   - Floors: the protected control gets at least CONTROL_FLOOR; every other arm ARM_FLOOR, scaled
//     down so all floors together stay at or under MAX_FLOOR_TOTAL. A share is its floor plus its
//     part of what the floors leave, so no arm is ever starved and the shares add up to 1.
//   - Cells, most specific first: segment|team size|persona, then segment|team size, then
//     segment. A contact's shares come from the first of its cells where every arm has
//     CELL_MIN_PER_ARM real matured sends, each arm shrunk toward its rate in the parent cell with
//     PSEUDO_SENDS pseudo-sends. With no ready cell, the pooled posterior decides.
import { MONTE_CARLO_DRAWS, posterior, probabilityBest, type Uniform } from "../metrics/experiment-stats.ts";
import type { CellSample } from "../metrics/experiments.ts";

export const MIN_MATURED_PER_ARM = 50;
export const CONTROL_FLOOR = 0.2;
export const ARM_FLOOR = 0.15;
export const MAX_FLOOR_TOTAL = 0.5;
export const MAX_ARMS = 4;
export const CELL_MIN_PER_ARM = 150;
export const PSEUDO_SENDS = 50;

export interface ThompsonArm {
  id: string;
  control: boolean;
  /** The operator's volume weight, used before every arm is ready. */
  weight: number;
}

export interface Counts {
  sends: number;
  positives: number;
}

/** The floors for these arms: CONTROL_FLOOR for the control, ARM_FLOOR scaled for the others. Pure. */
export function guardrailFloors(arms: ReadonlyArray<Pick<ThompsonArm, "control">>): number[] {
  if (arms.length <= 1) return arms.map(() => 0);
  const hasControl = arms.some((a) => a.control);
  const others = arms.filter((a) => !a.control).length;
  const controlFloor = hasControl ? CONTROL_FLOOR : 0;
  const room = MAX_FLOOR_TOTAL - controlFloor;
  const each = others > 0 ? Math.min(ARM_FLOOR, room / others) : 0;
  return arms.map((a) => (a.control ? controlFloor : each));
}

/** Floors plus each arm's part of what they leave. The result adds up to 1. Pure. */
export function applyFloors(probabilities: readonly number[], floors: readonly number[]): number[] {
  const floorTotal = floors.reduce((s, f) => s + f, 0);
  const pTotal = probabilities.reduce((s, p) => s + (p > 0 ? p : 0), 0);
  const free = Math.max(0, 1 - floorTotal);
  return probabilities.map((p, i) => (floors[i] ?? 0) + (pTotal > 0 ? (free * (p > 0 ? p : 0)) / pTotal : free / probabilities.length));
}

const norm = (v: string | null | undefined) => v?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") || "(unknown)";

export interface CellFacts {
  segment: string | null;
  teamSize: string | null;
  persona: string | null;
}

/** A contact's cells, most specific first. Pure. */
export function cellKeys(facts: CellFacts): string[] {
  const s = norm(facts.segment);
  const t = norm(facts.teamSize);
  const p = norm(facts.persona);
  return [`${s}|${t}|${p}`, `${s}|${t}`, s];
}

/** Matured counts per cell key (every level) and pooled, per template. */
export interface CellTable {
  pooled: Map<string, Counts>;
  cells: Map<string, Map<string, Counts>>;
}

/** Aggregate cell samples into every level. Pure. */
export function buildCellTable(samples: readonly CellSample[]): CellTable {
  const pooled = new Map<string, Counts>();
  const cells = new Map<string, Map<string, Counts>>();
  const add = (map: Map<string, Counts>, key: string, s: CellSample) => {
    const c = map.get(key) ?? { sends: 0, positives: 0 };
    c.sends += s.sends;
    c.positives += s.positives;
    map.set(key, c);
  };
  for (const s of samples) {
    add(pooled, s.templateId, s);
    for (const key of cellKeys(s)) {
      const byTemplate = cells.get(key) ?? new Map<string, Counts>();
      add(byTemplate, s.templateId, s);
      cells.set(key, byTemplate);
    }
  }
  return { pooled, cells };
}

const rate = (c: Counts | undefined): number | null => (c && c.sends > 0 ? c.positives / c.sends : null);

/** True once every arm has MIN_MATURED_PER_ARM matured sends. Pure. */
export function thompsonReady(table: CellTable, arms: readonly ThompsonArm[]): boolean {
  return arms.length > 1 && arms.every((a) => (table.pooled.get(a.id)?.sends ?? 0) >= MIN_MATURED_PER_ARM);
}

export interface CellDecision {
  /** The cell that decided, or null when the pooled posterior did. */
  cell: string | null;
  posteriors: Array<{ alpha: number; beta: number }>;
}

/** Which cell decides for a contact, and each arm's posterior there. Pure. */
export function decideCell(table: CellTable, arms: readonly ThompsonArm[], facts: CellFacts): CellDecision {
  const keys = cellKeys(facts);
  for (let level = 0; level < keys.length; level++) {
    const key = keys[level] ?? "";
    const cell = table.cells.get(key);
    if (!cell || !arms.every((a) => (cell.get(a.id)?.sends ?? 0) >= CELL_MIN_PER_ARM)) continue;
    const parentKey = keys[level + 1];
    const parent = parentKey ? table.cells.get(parentKey) : undefined;
    const posteriors = arms.map((a) => {
      const own = cell.get(a.id) ?? { sends: 0, positives: 0 };
      const parentRate = rate(parent?.get(a.id)) ?? rate(table.pooled.get(a.id)) ?? 0.5;
      return posterior({ sends: own.sends, successes: own.positives }, { alpha: 1 + PSEUDO_SENDS * parentRate, beta: 1 + PSEUDO_SENDS * (1 - parentRate) });
    });
    return { cell: key, posteriors };
  }
  return { cell: null, posteriors: arms.map((a) => posterior({ sends: table.pooled.get(a.id)?.sends ?? 0, successes: table.pooled.get(a.id)?.positives ?? 0 })) };
}

/** Shares for a decision: P(best) by Monte Carlo, then the floors. Pure given the generator. */
export function thompsonShares(decision: CellDecision, arms: readonly ThompsonArm[], rng: Uniform, draws: number = MONTE_CARLO_DRAWS): number[] {
  return applyFloors(probabilityBest(decision.posteriors, rng, draws), guardrailFloors(arms));
}

/** Shares from the operator's volume weights. Pure. */
export function weightShares(arms: readonly ThompsonArm[]): number[] {
  const total = arms.reduce((s, a) => s + Math.max(0, a.weight), 0);
  return arms.map((a) => (total > 0 ? Math.max(0, a.weight) / total : 1 / arms.length));
}

/**
 * The arms for a batch: the protected control (the named template when it is among the general
 * ones, else the highest-weight general template) and at most MAX_ARMS others by weight. Pure.
 */
export function chooseArms(general: ReadonlyArray<{ id: string; weight: number }>, controlId: string | null): { arms: ThompsonArm[]; dropped: string[] } {
  const sorted = [...general].filter((g) => g.weight > 0).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
  const control = sorted.find((g) => g.id === controlId) ?? sorted[0];
  if (!control) return { arms: [], dropped: [] };
  const rest = sorted.filter((g) => g.id !== control.id);
  return {
    arms: [{ id: control.id, control: true, weight: control.weight }, ...rest.slice(0, MAX_ARMS).map((g) => ({ id: g.id, control: false, weight: g.weight }))],
    dropped: rest.slice(MAX_ARMS).map((g) => g.id),
  };
}
