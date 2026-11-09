// GTM-agents: the self-improvement jobs. Each loop is its own job behind its own flag, off by
// default; one failing never stops another. Every job has row, time and (for model calls) daily spend
// ceilings, and every model call goes through the spend gate.
//
//   learning_fitness          daily 04:15          no model
//   learning_objections       daily 04:45          no model
//   learning_retrospective    daily 05:00          strategist
//   learning_agent_review     MON-FRI 06:30        judge
//   learning_edit_mining      MON 07:00            no model
//   learning_voice_drift      MON 07:30            no model
//   learning_benchmark        SUN 03:00            writer, worker, triage, judge
//   learning_evolution        SUN 05:00            strategist, then the benchmark's roles
//
//   createLearningJobs({ model: (env) => gateway, operator: (env) => channel })
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { assertModelSchedule } from "../replies/jobs.ts";
import { claimEffect } from "../events/effects.ts";
import type { KvStore } from "../shared/kv.ts";
import { createSpendGate } from "../sourcing/spend.ts";
import { runAgentReview } from "./agent-review.ts";
import { runBenchmark, weeklyRegression } from "./benchmark.ts";
import { mineDraftEdits } from "./edit-mining.ts";
import { runEvolution } from "./evolution.ts";
import { DEFAULT_FITNESS_TARGETS, runFitness, type FitnessTargets } from "./fitness.ts";
import { LEARNING_FLAGS, learningFlagOn, type LearningFlag } from "./flags.ts";
import { scoreObjectionAnswers } from "./objections.ts";
import { expireLearningProposals } from "./proposals.ts";
import { runRetrospective } from "./retrospective.ts";
import { voiceDrift } from "./voice.ts";

export const LEARNING_JOBS = Object.freeze({
  fitness: "learning_fitness",
  objections: "learning_objections",
  retrospective: "learning_retrospective",
  agentReview: "learning_agent_review",
  editMining: "learning_edit_mining",
  voiceDrift: "learning_voice_drift",
  benchmark: "learning_benchmark",
  evolution: "learning_evolution",
});

export interface LearningEnv {
  DB: D1Database;
  KV?: KvStore;
}

export interface LearningJobOptions {
  schedules: Record<keyof typeof LEARNING_JOBS, string>;
  /** Daily model spend caps per job, in cents. */
  spendCents: { retrospective: number; agentReview: number; benchmark: number; evolution: number };
  /** Scenarios per benchmark dimension. */
  benchmarkScenarios: number;
  fitnessTargets: Partial<FitnessTargets>;
  /** The chat notices go to. Defaults to the first allowlisted chat. */
  chatId?: string;
}

export const DEFAULT_LEARNING_JOB_OPTIONS: Readonly<LearningJobOptions> = Object.freeze({
  schedules: {
    fitness: "15 4 * * *",
    objections: "45 4 * * *",
    retrospective: "0 5 * * *",
    agentReview: "30 6 * * MON-FRI",
    editMining: "0 7 * * MON",
    voiceDrift: "30 7 * * MON",
    benchmark: "0 3 * * SUN",
    evolution: "0 5 * * SUN",
  },
  spendCents: { retrospective: 25, agentReview: 50, benchmark: 100, evolution: 200 },
  benchmarkScenarios: 2,
  fitnessTargets: { ...DEFAULT_FITNESS_TARGETS },
});

export interface LearningDeps<E extends LearningEnv = LearningEnv> {
  model?: (env: E) => ModelGateway | undefined;
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<LearningJobOptions>;
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

export function createLearningJobs<E extends LearningEnv>(deps: LearningDeps<E> = {}): RegisteredJob<E>[] {
  const o: LearningJobOptions = {
    ...DEFAULT_LEARNING_JOB_OPTIONS,
    ...(deps.options ?? {}),
    schedules: { ...DEFAULT_LEARNING_JOB_OPTIONS.schedules, ...(deps.options?.schedules ?? {}) },
    spendCents: { ...DEFAULT_LEARNING_JOB_OPTIONS.spendCents, ...(deps.options?.spendCents ?? {}) },
  };
  for (const key of ["retrospective", "agentReview", "benchmark", "evolution"] as const) assertModelSchedule(o.schedules[key], LEARNING_JOBS[key]);
  const chatOf = (ctx: JobContext<E>) => o.chatId ?? ctx.config.operator.allowedChatIds[0];
  const notify = async (ctx: JobContext<E>, text: string) => {
    const channel = tryBuild(deps.operator, ctx.env);
    const chatId = chatOf(ctx);
    try {
      await channel?.notify({ text, ...(chatId ? { chatId } : {}) });
    } catch {
      ctx.log.warn("a learning notice could not be delivered");
    }
  };
  const gate = (ctx: JobContext<E>, cap: number) =>
    createSpendGate({ db: ctx.env.DB, flags: ctx.flags, job: ctx.job, ...(ctx.runId ? { runId: ctx.runId } : {}), jobCapCents: Math.min(cap, ctx.ceilings.maxSpendCents ?? cap), now: () => ctx.now, log: ctx.log });
  const off = async (ctx: JobContext<E>, flag: LearningFlag) => {
    await expireLearningProposals(ctx.env.DB, ctx.now);
    return !(await learningFlagOn(ctx.flags, flag));
  };
  const model = (ctx: JobContext<E>) => tryBuild(deps.model, ctx.env);
  const common = (ctx: JobContext<E>, cap: number) => ({
    db: ctx.env.DB,
    kv: ctx.env.KV,
    flags: ctx.flags,
    model: model(ctx),
    config: ctx.config,
    spend: gate(ctx, cap),
    job: ctx.job,
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    now: ctx.now,
    log: ctx.log,
  });

  return [
    defineJob<E>({
      name: LEARNING_JOBS.fitness,
      schedule: o.schedules.fitness,
      flag: LEARNING_FLAGS.fitness,
      ceilings: { maxDurationMs: 60_000, maxRows: 1 },
      rerunnable: true,
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.fitness)) return { summary: "flag off" };
        const r = await runFitness({ db: ctx.env.DB, flags: ctx.flags, now: ctx.now, targets: o.fitnessTargets });
        return { summary: r.composite === null ? "no dimension has enough data yet" : `fitness ${r.composite}`, rows: r.composite === null ? 0 : 1 };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.objections,
      schedule: o.schedules.objections,
      flag: LEARNING_FLAGS.objections,
      ceilings: { maxDurationMs: 120_000, maxRows: 200 },
      rerunnable: true,
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.objections)) return { summary: "flag off" };
        const r = await scoreObjectionAnswers(ctx.env.DB, ctx.now, ctx.ceilings.maxRows ?? 200);
        return { summary: `${r.scored} answer uses scored (${r.successes} successes), ${r.waiting} waiting`, rows: r.scored };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.retrospective,
      schedule: o.schedules.retrospective,
      flag: LEARNING_FLAGS.retrospective,
      ceilings: { maxDurationMs: 180_000, maxRows: 1, maxSpendCents: o.spendCents.retrospective },
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.retrospective)) return { summary: "flag off" };
        const operator = tryBuild(deps.operator, ctx.env);
        const chatId = chatOf(ctx);
        const r = await runRetrospective({ ...common(ctx, o.spendCents.retrospective), ...(operator ? { operator } : {}), ...(chatId ? { chatId } : {}) });
        return { summary: r.summary, rows: r.proposal ? 1 : 0 };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.agentReview,
      schedule: o.schedules.agentReview,
      flag: LEARNING_FLAGS.agentReview,
      ceilings: { maxDurationMs: 180_000, maxRows: 40, maxSpendCents: o.spendCents.agentReview },
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.agentReview)) return { summary: "flag off" };
        const r = await runAgentReview(common(ctx, o.spendCents.agentReview));
        return { summary: r.summary, rows: r.memories ?? 0 };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.editMining,
      schedule: o.schedules.editMining,
      flag: LEARNING_FLAGS.editMining,
      ceilings: { maxDurationMs: 120_000, maxRows: 500 },
      rerunnable: true,
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.editMining)) return { summary: "flag off" };
        const r = await mineDraftEdits({ db: ctx.env.DB, now: ctx.now, maxRows: ctx.ceilings.maxRows ?? 500, ...(ctx.runId ? { runId: ctx.runId } : {}) });
        if (r.proposed.length > 0) await notify(ctx, `Edit mining proposes ${r.proposed.length} writing rule(s) from drafts you edited: ${r.proposed.join(", ")}. Review them with learning-show <id>.`);
        return { summary: `${r.edits} edits, ${r.patterns} patterns, ${r.proposed.length} proposed`, rows: r.edits };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.voiceDrift,
      schedule: o.schedules.voiceDrift,
      flag: LEARNING_FLAGS.voice,
      ceilings: { maxDurationMs: 60_000, maxRows: 1 },
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.voice)) return { summary: "flag off" };
        const d = await voiceDrift(ctx.env.DB, ctx.now);
        const week = ctx.now.toISOString().slice(0, 10);
        if (d.suggest && (await claimEffect(ctx.env.DB, week, "learning_voice_drift_notice"))) {
          await notify(ctx, `You edited ${d.edited} of the last ${d.decisions} reply drafts (${Math.round((d.rate ?? 0) * 100)}%). Consider rebuilding the voice profile from threads you pick: voice-build <thread id> ...`);
        }
        return { summary: d.rate === null ? "no decisions" : `edit rate ${Math.round(d.rate * 100)}% over ${d.decisions}${d.suggest ? ", rebuild suggested" : ""}` };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.benchmark,
      schedule: o.schedules.benchmark,
      flag: LEARNING_FLAGS.benchmark,
      ceilings: { maxDurationMs: 600_000, maxRows: 15, maxSpendCents: o.spendCents.benchmark },
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.benchmark)) return { summary: "flag off" };
        const run = await runBenchmark(common(ctx, o.spendCents.benchmark), { trigger: "weekly", perDimension: o.benchmarkScenarios });
        const check = await weeklyRegression(ctx.env.DB, run);
        if (check.regressed) await notify(ctx, `The weekly benchmark regressed: ${check.latest} against ${check.previous} last time (a drop of ${check.drop}). Recent brain or template changes are the first place to look.`);
        return { summary: `benchmark ${run.aggregate ?? "incomplete"}${run.complete ? "" : " (incomplete)"}${check.regressed ? ", regression" : ""}`, rows: run.scenarios.length };
      },
    }),
    defineJob<E>({
      name: LEARNING_JOBS.evolution,
      schedule: o.schedules.evolution,
      flag: LEARNING_FLAGS.evolution,
      ceilings: { maxDurationMs: 840_000, maxRows: 3, maxSpendCents: o.spendCents.evolution },
      async run(ctx) {
        if (await off(ctx, LEARNING_FLAGS.evolution)) return { summary: "flag off" };
        const operator = tryBuild(deps.operator, ctx.env);
        const chatId = chatOf(ctx);
        const r = await runEvolution({ ...common(ctx, o.spendCents.evolution), ...(operator ? { operator } : {}), ...(chatId ? { chatId } : {}), perDimension: o.benchmarkScenarios });
        return { summary: r.summary, rows: r.proposal ? 1 : 0 };
      },
    }),
  ];
}

