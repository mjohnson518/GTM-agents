// GTM-agents: the experiment cycle: evaluate running experiments, run the copy-change gate, and
// watch subject tests. Twice a day, behind experiments:enabled (jobs.ts). No model calls.
//
// One run, in order:
//   1. measurement health (metrics/health.ts). While it blocks reply conclusions, nothing reply-based
//      concludes and no copy change is proposed; while it blocks product conclusions, no
//      product-metric experiment concludes. Unreadable health blocks everything;
//   2. each running experiment whose templates still hold the copy it started with is evaluated
//      (evaluate.ts) with a seeded generator whose seed goes in its notes; one whose copy changed is
//      held and the operator told once. A conclusion is written with a compare-and-set (running to concluded). Keep
//      opens a copy-change proposal for the treatment, through the gate (gate.ts);
//   3. with outreach:allocation_mode at thompson, each general template that beats the protected
//      control through the gate is proposed as a promotion;
//   4. each running subject test: the zero-reply tripwire, then its best variant against the
//      runner-up through the gate;
//   5. pending proposals older than PROPOSAL_TTL_DAYS expire, and every new proposal and conclusion
//      is sent to the operator once.
// Nothing here applies a change: proposals wait for exp-approve-<id> (proposals.ts).
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import {
  daysBefore,
  experimentArmSamples,
  maturedSamples,
  measurementHealth,
  subjectVariantSamples,
  unreadableHealth,
  type MeasurementHealth,
} from "../metrics/index.ts";
import { batchTemplates, isTargeted } from "../outreach/allocate.ts";
import { seededRng } from "../outreach/holdout.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { deliverOnce } from "../reports/deliver.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { evaluateExperiment, evaluationSeed } from "./evaluate.ts";
import { readAllocation, readControlTemplate, templateWeightKey } from "./flags.ts";
import { bestAndRunnerUp, copyChangeGate } from "./gate.ts";
import { ALLOCATION_LOOKBACK_DAYS } from "./plan.ts";
import { createProposal, expireProposals, proposalText, trackRecord, type ExperimentProposal } from "./proposals.ts";
import { copyChanged, markConcluded, runningExperiments, type ExperimentRecord } from "./store.ts";
import { activeSubjectTests, ZERO_REPLY_TRIPWIRE_SENDS } from "./subject.ts";
import { chooseArms } from "./thompson.ts";

export interface CycleDeps {
  db: D1Database;
  flags: FlagReader;
  now: Date;
  log: JobLogger;
  operator?: OperatorChannel | undefined;
  chatId?: string;
  /** The templates as served now (with weight overrides applied). */
  templates: () => Promise<readonly ServedTemplate[]>;
  /** The most experiments and tests evaluated in one run. */
  maxRows: number;
}

export interface CycleResult {
  evaluated: number;
  concluded: Array<{ id: string; verdict: string }>;
  blocked: number;
  proposals: string[];
  tripwires: string[];
}

async function raw(flags: FlagReader, key: string): Promise<string> {
  return ((await flags.get(key)) ?? "").trim();
}

/** Open (or find) a copy-change proposal for a winner over a loser, with the snapshot it is checked against. */
async function proposeCopyChange(
  deps: CycleDeps,
  input: { target: string; winner: ServedTemplate; loser: ServedTemplate; probability: number; winnerSends: number; loserSends: number; reason: string; experimentId?: string },
): Promise<ExperimentProposal | null> {
  let winnerWeight: string;
  let loserWeight: string;
  try {
    winnerWeight = await raw(deps.flags, templateWeightKey(input.winner.id));
    loserWeight = await raw(deps.flags, templateWeightKey(input.loser.id));
  } catch {
    deps.log.warn("template weights could not be read; the copy-change proposal waits for the next cycle", { target: input.target });
    return null;
  }
  const { proposal, created } = await createProposal(
    deps.db,
    {
      kind: "copy_change",
      target: input.target,
      current: `${input.winner.id} ${input.winner.meta.volume_weight}, ${input.loser.id} ${input.loser.meta.volume_weight}`,
      proposed: `promote ${input.winner.id} over ${input.loser.id}`,
      reason: `${input.reason}: P(${input.winner.id} better) ${input.probability.toFixed(3)} on ${input.winnerSends} and ${input.loserSends} matured sends.`,
      prediction: `${input.winner.id} keeps a higher positive reply rate than ${input.loser.id} over its next 300 matured sends.`,
      predictedEffect: input.probability,
      neededSample: 300,
      evidence: {
        snapshot: {
          change: input.experimentId ? "experiment" : "template_pair",
          ...(input.experimentId ? { experimentId: input.experimentId } : {}),
          winnerTemplate: input.winner.id,
          loserTemplate: input.loser.id,
          winnerSha: input.winner.sha256,
          loserSha: input.loser.sha256,
          winnerWeight,
          loserWeight,
        },
      },
    },
    deps.now,
  );
  return created ? proposal : null;
}

function conclusionNotes(verdict: string, reason: string, confidence: number, seed: string, e: ExperimentRecord, s: { control: { sends: number; successes: number }; treatment: { sends: number; successes: number } }): string {
  return `${verdict} (${reason}); confidence ${confidence.toFixed(4)}; seed ${seed}; ${e.primaryMetric}: control ${s.control.successes}/${s.control.sends}, treatment ${s.treatment.successes}/${s.treatment.sends}`;
}

/** One run of the cycle. Throws only when the running experiments cannot be listed at all. */
export async function runExperimentCycle(deps: CycleDeps): Promise<CycleResult> {
  const { db, now, log } = deps;
  const result: CycleResult = { evaluated: 0, concluded: [], blocked: 0, proposals: [], tripwires: [] };
  let health: MeasurementHealth;
  try {
    health = await measurementHealth(db, now);
  } catch {
    health = unreadableHealth();
  }
  const served = await deps.templates().catch(() => [] as readonly ServedTemplate[]);
  const byId = new Map(served.map((t) => [t.id, t]));
  const created: ExperimentProposal[] = [];
  const notices: Array<{ key: string; text: string }> = [];

  // 2. Running experiments.
  for (const e of (await runningExperiments(db)).slice(0, deps.maxRows)) {
    result.evaluated += 1;
    try {
      // Judged only on the copy it started with: an edit (or templates that cannot be read) blocks it.
      const changed = copyChanged(e, byId);
      if (changed) {
        result.blocked += 1;
        notices.push({ key: `exp:copy-changed:${e.id}`, text: `Experiment ${e.id} (${e.name}) is on hold: ${changed}. It enrolls no one and cannot conclude while the copy differs. Restore the copy, or stop it with experiment-stop ${e.id} and start a new one.` });
        continue;
      }
      const samples = await experimentArmSamples(db, e.id, e.primaryMetric, now);
      const seed = evaluationSeed(e.id, now);
      const evaluation = evaluateExperiment({ experiment: e, samples, health, now, rng: seededRng(seed) });
      if (evaluation.status === "blocked") {
        result.blocked += 1;
        continue;
      }
      if (evaluation.status === "waiting") continue;
      const notes = conclusionNotes(evaluation.verdict, evaluation.reason, evaluation.confidence, seed, e, samples);
      if (!(await markConcluded(db, e.id, evaluation.confidence, notes, now))) continue;
      result.concluded.push({ id: e.id, verdict: evaluation.verdict });
      log.info("experiment concluded", { experiment: e.id, verdict: evaluation.verdict, seed });
      const lines = [`Experiment ${e.id} (${e.name}) concluded: ${notes}.`];
      if (evaluation.verdict === "keep") {
        const winner = byId.get(e.treatmentTemplateId ?? "");
        const loser = byId.get(e.controlTemplateId ?? "");
        const gate = copyChangeGate({ id: "treatment", ...samples.treatment }, { id: "control", ...samples.control });
        if (!winner || !loser) lines.push("A template is no longer served, so no promotion is proposed.");
        else if (!gate.pass) lines.push(`The copy-change gate did not pass (${gate.reason}), so no promotion is proposed.`);
        else {
          const p = await proposeCopyChange(deps, { target: `experiment:${e.id}`, winner, loser, probability: gate.probability, winnerSends: samples.treatment.sends, loserSends: samples.control.sends, reason: `experiment ${e.id} concluded keep`, experimentId: e.id });
          if (p) created.push(p);
          lines.push("A promotion is proposed; it applies only when you approve it.");
        }
      } else {
        lines.push("Nothing changes: the control stays as it is.");
      }
      notices.push({ key: `exp:concluded:${e.id}`, text: lines.join("\n") });
    } catch (error) {
      log.warn("an experiment could not be evaluated; it is evaluated again next cycle", { experiment: e.id, error: sanitizeErrorMessage(error) });
    }
  }

  // 3. Thompson arms against the protected control.
  if (!health.blocksReplyConclusions && (await readAllocation(deps.flags)).mode === "thompson") {
    try {
      const general = batchTemplates([...served]).filter((t) => !isTargeted(t));
      const { arms } = chooseArms(general.map((t) => ({ id: t.id, weight: t.meta.volume_weight })), await readControlTemplate(deps.flags));
      const control = arms.find((a) => a.control);
      const samples = new Map((await maturedSamples(db, daysBefore(now, ALLOCATION_LOOKBACK_DAYS), now)).map((s) => [s.templateId, s]));
      const c = control ? samples.get(control.id) : undefined;
      const controlTemplate = control ? byId.get(control.id) : undefined;
      for (const arm of arms.filter((a) => !a.control)) {
        const s = samples.get(arm.id);
        const t = byId.get(arm.id);
        if (!s || !c || !t || !controlTemplate) continue;
        const gate = copyChangeGate({ id: arm.id, sends: s.sends, successes: s.positiveReplies }, { id: control?.id ?? "", sends: c.sends, successes: c.positiveReplies });
        if (!gate.pass) continue;
        const p = await proposeCopyChange(deps, { target: `template:${arm.id}`, winner: t, loser: controlTemplate, probability: gate.probability, winnerSends: s.sends, loserSends: c.sends, reason: `${arm.id} beats the protected control` });
        if (p) created.push(p);
      }
    } catch (error) {
      log.warn("the template gate could not run; it runs again next cycle", { error: sanitizeErrorMessage(error) });
    }
  }

  // 4. Subject tests.
  try {
    const tests = (await activeSubjectTests(db)).filter((t) => t.status === "running").slice(0, deps.maxRows);
    for (const test of tests) {
      const samples = await subjectVariantSamples(db, test.id, now);
      if (samples.allSends >= ZERO_REPLY_TRIPWIRE_SENDS && samples.allHumanReplies === 0) {
        result.tripwires.push(test.id);
        notices.push({
          key: `exp:tripwire:${test.id}`,
          text: `Subject test ${test.id} (${test.name}) has ${samples.allSends} sends and no reply at all. That is more likely broken reply attribution than bad copy: check that replies reach the ledger before reading this test.`,
        });
      }
      if (health.blocksReplyConclusions) continue;
      const pair = bestAndRunnerUp(samples.variants.map((v) => ({ id: v.variantId, sends: v.sends, successes: v.positives })));
      const template = byId.get(test.templateId);
      if (!pair || !template) continue;
      const gate = copyChangeGate(pair.best, pair.runnerUp);
      if (!gate.pass) continue;
      const variant = test.variants.find((v) => v.id === pair.best.id);
      const { proposal, created: isNew } = await createProposal(
        db,
        {
          kind: "copy_change",
          target: `subject_test:${test.id}`,
          current: `${test.templateId} subject "${template.subject.slice(0, 90)}"`,
          proposed: `winner ${pair.best.id}`,
          reason: `variant ${pair.best.id} ("${(variant?.text ?? "").slice(0, 90)}") beats ${pair.runnerUp.id}: P ${gate.probability.toFixed(3)} on ${pair.best.sends} and ${pair.runnerUp.sends} matured sends.`,
          prediction: `${test.templateId} with the winning subject keeps a positive reply rate at or above ${pair.runnerUp.id}'s over its next 300 matured sends.`,
          predictedEffect: gate.probability,
          neededSample: 300,
          evidence: { snapshot: { change: "subject_test", testId: test.id, variantId: pair.best.id, winnerTemplate: test.templateId, winnerSha: template.sha256 } },
        },
        now,
      );
      if (isNew) created.push(proposal);
    }
  } catch (error) {
    log.warn("subject tests could not be evaluated; they are evaluated again next cycle", { error: sanitizeErrorMessage(error) });
  }

  // 5. Expiry, then the operator.
  await expireProposals(db, now);
  const track = await trackRecord(db, ["copy_change"]).catch(() => null);
  for (const p of created) {
    result.proposals.push(p.id);
    notices.push({ key: `exp:proposal:${p.id}`, text: proposalText(p, track) });
  }
  for (const n of notices) await deliverOnce({ db, operator: deps.operator, ...(deps.chatId ? { chatId: deps.chatId } : {}), log }, n.key, n.text);
  return result;
}
