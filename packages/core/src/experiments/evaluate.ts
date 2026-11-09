// GTM-agents: when a running experiment may conclude, and what it concludes.
//
// The rules, all pre-registered with the experiment and none adjustable while it runs:
//   - measurement health first: while it blocks the experiment's kind of metric (reply or product,
//     metrics/health.ts), nothing concludes, not even at max duration. Health that cannot be read
//     blocks (fail closed);
//   - it may conclude once both arms reach their target sends and the minimum age has passed (10
//     days for a reply metric, 45 for a product metric), or once it reaches its max duration;
//   - confidence is P(treatment > control) by Monte Carlo over both arms' Beta posteriors, with a
//     generator seeded from the experiment id and the evaluation time, recorded in the notes;
//   - keep at confidence of KEEP_AT or more, discard at DISCARD_AT or less, both only with
//     MIN_PER_ARM or more matured sends in each arm; anything else is inconclusive.
// Keep does not change any copy: it opens a copy-change proposal a person approves (proposals.ts).
import { MONTE_CARLO_DRAWS, isProductMetric, probabilityBetterMonteCarlo, type ExperimentSamples, type MeasurementHealth, type Uniform } from "../metrics/index.ts";
import { ageDays, minimumAgeDays, type ExperimentRecord } from "./store.ts";

export const KEEP_AT = 0.95;
export const DISCARD_AT = 0.05;
export const MIN_PER_ARM = 300;

export type Verdict = "keep" | "discard" | "inconclusive";

export type Evaluation =
  | { status: "blocked"; reason: string }
  | { status: "waiting"; reason: string; confidence: number }
  | { status: "conclude"; verdict: Verdict; confidence: number; reason: string };

export interface EvaluationInput {
  experiment: ExperimentRecord;
  samples: ExperimentSamples;
  health: Pick<MeasurementHealth, "blocksReplyConclusions" | "blocksProductConclusions" | "reasons">;
  now: Date;
  rng: Uniform;
  draws?: number;
}

/** The seed for one evaluation: the experiment and the hour, so a rerun in the same hour agrees. */
export function evaluationSeed(experimentId: string, now: Date): string {
  return `${experimentId}:${now.toISOString().slice(0, 13)}`;
}

/** Decide one experiment. Pure given the generator. */
export function evaluateExperiment(input: EvaluationInput): Evaluation {
  const { experiment: e, samples, health, now } = input;
  const product = isProductMetric(e.primaryMetric);
  const blocked = product ? health.blocksProductConclusions : health.blocksReplyConclusions;
  if (blocked) return { status: "blocked", reason: `measurement health blocks ${product ? "product" : "reply"} conclusions${health.reasons.length ? `: ${health.reasons.join("; ")}` : ""}` };

  const confidence = probabilityBetterMonteCarlo(
    { sends: samples.treatment.sends, successes: samples.treatment.successes },
    { sends: samples.control.sends, successes: samples.control.successes },
    input.rng,
    input.draws ?? MONTE_CARLO_DRAWS,
  );
  const age = ageDays(e.startedAt, now);
  const minAge = minimumAgeDays(e.primaryMetric);
  const target = e.targetPerArm ?? e.maxSamplePerArm ?? Number.POSITIVE_INFINITY;
  const reachedTarget = samples.control.sends >= target && samples.treatment.sends >= target;
  const atMaxDuration = age >= e.maxDurationDays;
  if (!atMaxDuration && !(reachedTarget && age >= minAge)) {
    const why: string[] = [];
    if (!reachedTarget) why.push(`arms at ${samples.control.sends} and ${samples.treatment.sends} of ${target} matured sends`);
    if (age < minAge) why.push(`${Math.floor(age)} of ${minAge} days`);
    return { status: "waiting", reason: why.join("; "), confidence };
  }
  const enough = samples.control.sends >= MIN_PER_ARM && samples.treatment.sends >= MIN_PER_ARM;
  const when = atMaxDuration && !(reachedTarget && age >= minAge) ? "at max duration" : "target and minimum age reached";
  if (enough && confidence >= KEEP_AT) return { status: "conclude", verdict: "keep", confidence, reason: when };
  if (enough && confidence <= DISCARD_AT) return { status: "conclude", verdict: "discard", confidence, reason: when };
  const why = enough ? `confidence ${confidence.toFixed(3)} is between ${DISCARD_AT} and ${KEEP_AT}` : `fewer than ${MIN_PER_ARM} matured sends in an arm`;
  return { status: "conclude", verdict: "inconclusive", confidence, reason: `${when}; ${why}` };
}
