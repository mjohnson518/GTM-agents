// GTM-agents: the copy-change gate: the only test a copy change has to pass before it is even
// proposed. Pure.
//
// A winner may be proposed over the arm it beat only when:
//   - each of the two arms has GATE_MIN_PER_ARM or more matured sends (matured sends are at least
//     MATURITY_DAYS, 10 days, old, so every one has had its follow-ups and time to answer);
//   - P(winner better) is GATE_MIN_PROBABILITY or more, from the deterministic normal approximation
//     of the two Beta posteriors (no random draw, so the same counts always give the same answer).
// Passing the gate changes nothing. It opens a proposal (proposals.ts); a person applies it.
import { probabilityBetterNormal, type ArmCounts } from "../metrics/index.ts";

export const GATE_MIN_PER_ARM = 300;
export const GATE_MIN_PROBABILITY = 0.95;

export interface GateArm extends ArmCounts {
  id: string;
}

export type GateResult = { pass: true; winner: GateArm; loser: GateArm; probability: number } | { pass: false; reason: string; probability: number | null };

/** The gate for a winner against the arm it is compared with. */
export function copyChangeGate(winner: GateArm, loser: GateArm): GateResult {
  if (winner.sends < GATE_MIN_PER_ARM || loser.sends < GATE_MIN_PER_ARM) {
    return { pass: false, reason: `needs ${GATE_MIN_PER_ARM} matured sends per arm (${winner.id} ${winner.sends}, ${loser.id} ${loser.sends})`, probability: null };
  }
  const probability = probabilityBetterNormal(winner, loser);
  if (probability < GATE_MIN_PROBABILITY) return { pass: false, reason: `P(${winner.id} better) is ${probability.toFixed(3)}, under ${GATE_MIN_PROBABILITY}`, probability };
  return { pass: true, winner, loser, probability };
}

/** The best arm and the runner-up by observed rate, for a gate over several arms. Pure. */
export function bestAndRunnerUp<T extends ArmCounts & { id: string }>(arms: readonly T[]): { best: T; runnerUp: T } | null {
  if (arms.length < 2) return null;
  const rate = (a: T) => (a.sends > 0 ? a.successes / a.sends : 0);
  const sorted = [...arms].sort((a, b) => rate(b) - rate(a) || b.sends - a.sends || (a.id < b.id ? -1 : 1));
  const best = sorted[0];
  const runnerUp = sorted[1];
  return best && runnerUp ? { best, runnerUp } : null;
}
