// GTM-agents: the experiment jobs a deployment registers.
//
//   createExperimentJobs({ operator: (env) => operatorChannel(env) })
//
// returns two job definitions for the job registry, neither of which calls a model:
//   - experiments_cycle        twice a day (09:00 and 21:00 UTC), flag experiments:enabled: evaluates
//                              running experiments, runs the copy-change gate, watches subject tests
//                              (cycle.ts). It proposes; it never applies a copy change.
//   - experiments_self_review  Sundays 14:00 UTC, flag experiments:self_review_enabled: at most three
//                              rule-based proposals a week, and judges earlier ones (self-review.ts).
// Both are bounded: the cycle evaluates at most maxRows experiments and tests per run, the review
// writes at most three proposals, and each has a duration ceiling. The templates they check against
// are served from KV (or the bundled files) with weight overrides applied, as the cold batch serves
// them.
import type { GtmConfig } from "../config/schema.ts";
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { KvStore } from "../shared/kv.ts";
import { loadTemplates, serveTemplateFiles, type ServedTemplate, type TemplateFile } from "../templates/store.ts";
import { runExperimentCycle } from "./cycle.ts";
import { EXPERIMENT_FLAGS } from "./flags.ts";
import { withWeightOverrides } from "./plan.ts";
import { runSelfReview } from "./self-review.ts";

export const EXPERIMENT_CYCLE_JOB = "experiments_cycle";
export const SELF_REVIEW_JOB = "experiments_self_review";

/** The bindings the experiment jobs read. A deployment's Env satisfies it. */
export interface ExperimentEnv {
  DB: D1Database;
  KV?: KvStore;
}

export interface ExperimentJobOptions {
  cycleSchedule: string;
  reviewSchedule: string;
  /** Experiments and subject tests evaluated per cycle run. */
  cycleMaxRows: number;
  /** Signal sources the review may propose turning on, in order (each a discovery:<source>_enabled flag). */
  signalSources: readonly string[];
  /** The chat proposals go to. Defaults to the channel's default chat. */
  chatId?: string;
}

export const DEFAULT_EXPERIMENT_JOB_OPTIONS: Readonly<ExperimentJobOptions> = Object.freeze({
  cycleSchedule: "0 9,21 * * *",
  reviewSchedule: "0 14 * * SUN",
  cycleMaxRows: 20,
  signalSources: [],
});

export interface ExperimentDeps<E extends ExperimentEnv = ExperimentEnv> {
  operator?: (env: E) => OperatorChannel | undefined;
  /** Today's cold volume, for verified runway in the self-review. */
  volume?: (env: E, ctx: { flags: JobContext<E>["flags"] }) => Promise<number>;
  /** Templates bundled with the Worker; without them, templates are served from KV. */
  templates?: readonly TemplateFile[];
  options?: Partial<ExperimentJobOptions>;
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

/** The templates as the cold batch serves them: bundled or from KV, with weight overrides. */
export function servedTemplates(kv: KvStore | undefined, config: Pick<GtmConfig, "company">, flags: JobContext["flags"], bundled?: readonly TemplateFile[]): () => Promise<readonly ServedTemplate[]> {
  return async () => {
    const load = bundled ? await serveTemplateFiles(bundled, { companyDomain: config.company.domain }) : await loadTemplates(kv, { companyDomain: config.company.domain });
    if (load.error) throw new Error(load.error);
    return withWeightOverrides(load.templates, flags);
  };
}

export function createExperimentJobs<E extends ExperimentEnv>(deps: ExperimentDeps<E> = {}): RegisteredJob<E>[] {
  const options = { ...DEFAULT_EXPERIMENT_JOB_OPTIONS, ...deps.options };
  return [
    defineJob<E>({
      name: EXPERIMENT_CYCLE_JOB,
      schedule: options.cycleSchedule,
      flag: EXPERIMENT_FLAGS.enabled,
      rerunnable: true,
      ceilings: { maxDurationMs: 120_000, maxRows: options.cycleMaxRows },
      async run(ctx) {
        const result = await runExperimentCycle({
          db: ctx.env.DB,
          flags: ctx.flags,
          now: ctx.now,
          log: ctx.log,
          operator: tryBuild(deps.operator, ctx.env),
          ...(options.chatId ? { chatId: options.chatId } : {}),
          templates: servedTemplates(ctx.env.KV, ctx.config, ctx.flags, deps.templates),
          maxRows: Math.min(options.cycleMaxRows, ctx.ceilings.maxRows ?? options.cycleMaxRows),
        });
        return {
          summary: `evaluated ${result.evaluated}, concluded ${result.concluded.length}, blocked ${result.blocked}, proposals ${result.proposals.length}, tripwires ${result.tripwires.length}`,
          rows: result.evaluated,
        };
      },
    }),
    defineJob<E>({
      name: SELF_REVIEW_JOB,
      schedule: options.reviewSchedule,
      flag: EXPERIMENT_FLAGS.selfReview,
      ceilings: { maxDurationMs: 120_000, maxRows: 3 },
      async run(ctx) {
        const volume = deps.volume;
        const result = await runSelfReview({
          db: ctx.env.DB,
          flags: ctx.flags,
          now: ctx.now,
          log: ctx.log,
          operator: tryBuild(deps.operator, ctx.env),
          ...(options.chatId ? { chatId: options.chatId } : {}),
          templates: servedTemplates(ctx.env.KV, ctx.config, ctx.flags, deps.templates),
          ...(volume ? { volume: () => volume(ctx.env, { flags: ctx.flags }) } : {}),
          signalSources: options.signalSources,
        });
        return { summary: `proposed ${result.proposed.length}, judged ${result.judged}${result.skipped.length ? `; skipped: ${result.skipped.join("; ")}` : ""}`, rows: result.proposed.length };
      },
    }),
  ];
}
