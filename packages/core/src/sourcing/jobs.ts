// GTM-agents: the sourcing jobs a deployment registers.
//
//   createSourcingJobs({ adapters: (env) => ({ sources, people, finders, verifier, model }) })
//
// returns three job definitions for the job registry:
//   - discovery_cycle      weekdays 09:00 UTC, flag discovery:enabled: search, enrich, qualify,
//                          promote. Paid calls are capped by ceilings.maxSpendCents per day;
//   - account_prescore     daily 04:00 UTC, flag fit:prescore_enabled: the free 0 to 100 prescore;
//   - account_fit_scoring  every 15 minutes, flag fit:scoring_enabled: the optional model fit score.
//                          Model calls never run in a per-minute job, so a schedule that fires more
//                          often than every 15 minutes is refused.
// Every flag defaults off, so registering the jobs changes nothing until the operator turns them
// on. The job runner checks the halt, the flag and the budget before a run; each job re-reads its
// own flag as well (failing closed), so calling run() directly with the flag off does nothing.
// Adapters are built per run from the environment, so secrets are read when a job runs, not at
// import time.
import type { KVReader } from "../brain/load.ts";
import { parseCron } from "../jobs/cron.ts";
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import { runFitScoring } from "../scoring/fit.ts";
import { runPrescore } from "../scoring/prescore.ts";
import { loadSourcingBrain } from "./brain.ts";
import type { SourcingAdapters } from "./context.ts";
import { runDiscoveryCycle, summarizeCycle } from "./cycle.ts";
import { SOURCING_FLAGS, SOURCING_LIMITS, readCeiling, readFlagOn } from "./flags.ts";
import { createSpendGate } from "./spend.ts";

export const DISCOVERY_JOB = "discovery_cycle";
export const PRESCORE_JOB = "account_prescore";
export const FIT_JOB = "account_fit_scoring";

/** The bindings the sourcing jobs read. A deployment's Env satisfies it. */
export interface SourcingEnv {
  DB: D1Database;
  KV?: KVReader;
}

export interface SourcingJobOptions {
  discoverySchedule: string;
  prescoreSchedule: string;
  fitSchedule: string;
  /** Daily spend cap for the discovery cycle, in cents. */
  discoveryMaxSpendCents: number;
  /** Daily spend cap for model fit scoring, in cents. */
  fitMaxSpendCents: number;
  /** People kept per account candidate (the best one, plus this many minus one as new candidates). */
  peoplePerAccount: number;
  /** The model role fit scoring asks for. */
  fitRole: "judge" | "classifier";
}

export const DEFAULT_SOURCING_JOB_OPTIONS: Readonly<SourcingJobOptions> = Object.freeze({
  discoverySchedule: "0 9 * * MON-FRI",
  prescoreSchedule: "0 4 * * *",
  fitSchedule: "*/15 * * * *",
  discoveryMaxSpendCents: 300,
  fitMaxSpendCents: 100,
  peoplePerAccount: 2,
  fitRole: "classifier",
});

export interface SourcingDeps<E extends SourcingEnv = SourcingEnv> {
  /** Build the adapters for one run. Called inside the job, after its gates have passed. */
  adapters(env: E): SourcingAdapters;
  options?: Partial<SourcingJobOptions>;
}

/** Refuse a model-calling schedule that fires more often than every 15 minutes. */
function assertNotPerMinute(schedule: string, job: string): void {
  const cron = parseCron(schedule);
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  const tooClose = minutes.some((m, i) => (i === 0 ? m + 60 - (minutes.at(-1) ?? m) : m - (minutes[i - 1] ?? m)) < 15 && minutes.length > 1);
  if (minutes.length > 4 || tooClose) throw new Error(`job ${job}: model calls never run in a per-minute job; schedule it at most every 15 minutes`);
}

export function createSourcingJobs<E extends SourcingEnv>(deps: SourcingDeps<E>): RegisteredJob<E>[] {
  const options: SourcingJobOptions = { ...DEFAULT_SOURCING_JOB_OPTIONS, ...(deps.options ?? {}) };
  if (!Number.isInteger(options.peoplePerAccount) || options.peoplePerAccount < 1 || options.peoplePerAccount > 5) {
    throw new Error("sourcing option peoplePerAccount must be a whole number from 1 to 5");
  }
  assertNotPerMinute(options.fitSchedule, FIT_JOB);

  const discovery = defineJob<E>({
    name: DISCOVERY_JOB,
    schedule: options.discoverySchedule,
    flag: SOURCING_FLAGS.enabled,
    ceilings: { maxDurationMs: 600_000, maxRows: 500, maxSpendCents: options.discoveryMaxSpendCents },
    critical: true,
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readFlagOn(ctx.flags, SOURCING_FLAGS.enabled))) return { summary: "flag off" };
      const result = await runDiscoveryCycle({
        db: ctx.env.DB,
        kv: ctx.env.KV,
        flags: ctx.flags,
        adapters: deps.adapters(ctx.env),
        now: ctx.now,
        job: ctx.job,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        signal: ctx.signal,
        log: ctx.log,
        jobCapCents: options.discoveryMaxSpendCents,
        peoplePerAccount: options.peoplePerAccount,
        ...(ctx.ceilings.maxRows !== undefined ? { maxRows: ctx.ceilings.maxRows } : {}),
      });
      return { summary: summarizeCycle(result), rows: result.search.inserted + ("processed" in result.enrich ? result.enrich.processed : 0) + ("processed" in result.qualify ? result.qualify.processed : 0) + ("processed" in result.promote ? result.promote.processed : 0) };
    },
  });

  const prescore = defineJob<E>({
    name: PRESCORE_JOB,
    schedule: options.prescoreSchedule,
    flag: SOURCING_FLAGS.prescoreEnabled,
    ceilings: { maxDurationMs: 120_000, maxRows: 5000 },
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readFlagOn(ctx.flags, SOURCING_FLAGS.prescoreEnabled))) return { summary: "flag off" };
      const brain = await loadSourcingBrain(ctx.env.KV);
      if (brain.degraded) return { summary: "skipped: the brain could not be read whole" };
      const written = await runPrescore({ db: ctx.env.DB, brain, now: ctx.now, maxAccounts: ctx.ceilings.maxRows ?? 5000, signal: ctx.signal });
      return { summary: `prescored ${written} accounts`, rows: written };
    },
  });

  const fit = defineJob<E>({
    name: FIT_JOB,
    schedule: options.fitSchedule,
    flag: SOURCING_FLAGS.fitEnabled,
    ceilings: { maxDurationMs: 300_000, maxRows: SOURCING_LIMITS.fitPerRun.max, maxSpendCents: options.fitMaxSpendCents },
    async run(ctx: JobContext<E>) {
      if (!(await readFlagOn(ctx.flags, SOURCING_FLAGS.fitEnabled))) return { summary: "flag off" };
      const model = deps.adapters(ctx.env).model;
      if (!model) return { summary: "no model gateway configured" };
      if (!ctx.env.KV) return { summary: "no KV binding, so no brain to score against" };
      const [topN, perRun] = await Promise.all([
        readCeiling(ctx.flags, SOURCING_FLAGS.fitTopN, SOURCING_LIMITS.fitTopN, ctx.log),
        readCeiling(ctx.flags, SOURCING_FLAGS.fitPerRun, SOURCING_LIMITS.fitPerRun, ctx.log),
      ]);
      const gate = createSpendGate({
        db: ctx.env.DB,
        flags: ctx.flags,
        job: ctx.job,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        jobCapCents: options.fitMaxSpendCents,
        log: ctx.log,
      });
      const result = await runFitScoring({
        db: ctx.env.DB,
        kv: ctx.env.KV,
        model,
        models: ctx.config.models,
        gate,
        role: options.fitRole,
        now: ctx.now,
        topN,
        perRun: Math.min(perRun, ctx.ceilings.maxRows ?? perRun),
        job: ctx.job,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        signal: ctx.signal,
        log: ctx.log,
      });
      const stopped = gate.stopped ? `; stopped: ${gate.stopped}` : "";
      return { summary: result.skipped ? `skipped: ${result.skipped}` : `scored ${result.scored}, failed ${result.failed}${stopped}`, rows: result.scored + result.failed };
    },
  });

  return [discovery, prescore, fit];
}
