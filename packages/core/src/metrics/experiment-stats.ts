// GTM-agents: the statistics every experiment, allocation and promotion check uses: Beta posteriors
// over matured samples, P(arm is best) and P(treatment beats control) by Monte Carlo, the
// deterministic normal approximation of the copy-change gate, and the sample-size helper.
//
// Each arm is a count of matured sends and of successes on one metric (metrics/experiments.ts
// supplies them), and its posterior is Beta(1 + successes, 1 + sends - successes). Monte Carlo
// estimates take a generator, never Math.random: callers pass a seeded one (outreach/holdout.ts
// seededRng) and log its seed, so every number can be reproduced. Everything here is pure.

/** A uniform generator in [0, 1). */
export type Uniform = () => number;

/** Draws per Monte Carlo estimate. */
export const MONTE_CARLO_DRAWS = 4000;

export interface ArmCounts {
  /** Matured sends (or, for a product metric, contacts who received the arm). */
  sends: number;
  /** Of those, how many reached the metric. */
  successes: number;
}

/** The Beta posterior's parameters under a uniform prior, with optional pseudo-counts from a parent. */
export function posterior(arm: ArmCounts, prior: { alpha: number; beta: number } = { alpha: 1, beta: 1 }): { alpha: number; beta: number } {
  const sends = Math.max(0, Math.floor(arm.sends));
  const successes = Math.min(sends, Math.max(0, Math.floor(arm.successes)));
  return { alpha: prior.alpha + successes, beta: prior.beta + sends - successes };
}

/** A standard normal draw (Box-Muller). */
function normal(rng: Uniform): number {
  let u = rng();
  while (u <= 1e-12) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A Gamma(shape, 1) draw for shape >= 1 (Marsaglia and Tsang); smaller shapes are boosted. */
function gamma(shape: number, rng: Uniform): number {
  if (shape < 1) {
    let u = rng();
    while (u <= 1e-12) u = rng();
    return gamma(shape + 1, rng) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One Beta(alpha, beta) draw. */
export function betaDraw(alpha: number, beta: number, rng: Uniform): number {
  const x = gamma(alpha, rng);
  const y = gamma(beta, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

/**
 * P(each arm has the highest rate), by Monte Carlo over the arms' posteriors. Ties in a draw go to
 * the earlier arm. Returns shares that sum to 1, in the order given.
 */
export function probabilityBest(arms: ReadonlyArray<{ alpha: number; beta: number }>, rng: Uniform, draws: number = MONTE_CARLO_DRAWS): number[] {
  if (arms.length === 0) return [];
  if (arms.length === 1) return [1];
  const wins = arms.map(() => 0);
  for (let i = 0; i < draws; i++) {
    let best = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[a] ?? { alpha: 1, beta: 1 };
      const value = betaDraw(arm.alpha, arm.beta, rng);
      if (value > bestValue) {
        best = a;
        bestValue = value;
      }
    }
    wins[best] = (wins[best] ?? 0) + 1;
  }
  return wins.map((w) => w / draws);
}

/** P(treatment's rate > control's), by Monte Carlo over both posteriors. */
export function probabilityBetterMonteCarlo(treatment: ArmCounts, control: ArmCounts, rng: Uniform, draws: number = MONTE_CARLO_DRAWS): number {
  const t = posterior(treatment);
  const c = posterior(control);
  let wins = 0;
  for (let i = 0; i < draws; i++) if (betaDraw(t.alpha, t.beta, rng) > betaDraw(c.alpha, c.beta, rng)) wins += 1;
  return wins / draws;
}

/** The standard normal CDF (a rational approximation good to about 1e-7). */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/**
 * P(a's rate > b's), deterministic: the normal approximation of the difference of the two Beta
 * posteriors. The copy-change gate uses this, so a proposal never depends on a random draw.
 */
export function probabilityBetterNormal(a: ArmCounts, b: ArmCounts): number {
  const pa = posterior(a);
  const pb = posterior(b);
  const mean = (p: { alpha: number; beta: number }) => p.alpha / (p.alpha + p.beta);
  const variance = (p: { alpha: number; beta: number }) => (p.alpha * p.beta) / ((p.alpha + p.beta) ** 2 * (p.alpha + p.beta + 1));
  const sd = Math.sqrt(variance(pa) + variance(pb));
  if (!(sd > 0)) return 0.5;
  return normalCdf((mean(pa) - mean(pb)) / sd);
}

const Z_TWO_SIDED_95 = 1.959963984540054;
const Z_POWER_80 = 0.8416212335729143;

/**
 * Sends per arm to detect an absolute lift of `minDetectableEffect` over `baselineRate`, two-sided
 * at 95% with 80% power (normal approximation). Null when the inputs do not describe a test.
 */
export function sampleSizePerArm(baselineRate: number, minDetectableEffect: number): number | null {
  const p1 = baselineRate;
  const p2 = baselineRate + minDetectableEffect;
  if (!(p1 > 0 && p1 < 1) || !(minDetectableEffect > 0) || !(p2 > 0 && p2 < 1)) return null;
  const pBar = (p1 + p2) / 2;
  const numerator = Z_TWO_SIDED_95 * Math.sqrt(2 * pBar * (1 - pBar)) + Z_POWER_80 * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(numerator ** 2 / (p2 - p1) ** 2);
}

/**
 * Turn shares into whole counts that add up to `n`, by systematic sampling: cumulative shares
 * scaled to n, cut at a random offset. Each count is within one of its expected value.
 */
export function systematicCounts(shares: readonly number[], n: number, rng: Uniform): number[] {
  const total = shares.reduce((s, x) => s + (x > 0 ? x : 0), 0);
  if (n <= 0 || !(total > 0)) return shares.map(() => 0);
  const offset = rng();
  const counts: number[] = [];
  let cumulative = 0;
  let previous = Math.floor(offset);
  for (const share of shares) {
    cumulative += (share > 0 ? share : 0) / total;
    const edge = Math.floor(cumulative * n + offset);
    counts.push(edge - previous);
    previous = edge;
  }
  // Rounding at the last edge can leave the total one off; the last positive share absorbs it.
  const diff = n - counts.reduce((s, c) => s + c, 0);
  if (diff !== 0) {
    for (let i = counts.length - 1; i >= 0; i--) {
      if ((shares[i] ?? 0) > 0 && (counts[i] ?? 0) + diff >= 0) {
        counts[i] = (counts[i] ?? 0) + diff;
        break;
      }
    }
  }
  return counts;
}

/** Fisher-Yates shuffle with the given generator. Returns a new array. */
export function shuffled<T>(items: readonly T[], rng: Uniform): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
