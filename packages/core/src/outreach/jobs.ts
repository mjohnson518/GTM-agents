// GTM-agents: the outreach jobs a deployment registers.
//
//   createOutreachJobs({ send: (env) => sendOutreach, volume: (env, ctx) => todaysVolume, model, operator })
//
// returns the job definitions for the job registry:
//   - cold_batch  13:00 UTC Monday to Thursday, flag cold_batch:enabled (default off). Builds the day's
//                 cold batch and either hands it to the send function (auto-approve) or waits for the
//                 operator's release command. Idempotent per UTC day, so cron health may rerun it.
//                 Ceilings: 5 minutes, 1,500 drafts, and a daily spend cap for the model reviewer.
// The batch calls a model (the reviewer), so a schedule that fires more often than every 15 minutes
// is refused. Every dependency is built per run from the environment, so secrets are read when the
// job runs. The job runner checks the halt, the flag and the budget before a run; the job re-reads
// its flag as well, so calling run() directly with the flag off does nothing.
import type { KVReader } from "../brain/load.ts";
import { parseCron } from "../jobs/cron.ts";
import { defineJob, type FlagReader, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { SendOutreach } from "../sending/types.ts";
import type { TemplateFile } from "../templates/store.ts";
import { runColdBatch } from "./batch.ts";
import { OUTREACH_FLAGS, OUTREACH_LIMITS, readOn } from "./flags.ts";

export const COLD_BATCH_JOB = "cold_batch";

/** The bindings the outreach jobs read. A deployment's Env satisfies it. */
export interface OutreachEnv {
  DB: D1Database;
  KV?: KVReader;
  /** The product's app URL; copy may link to its host. */
  PRODUCT_APP_URL?: string;
}

export interface OutreachJobOptions {
  batchSchedule: string;
  /** Daily spend cap for the model reviewer, in cents (the job's ceilings.maxSpendCents). */
  reviewMaxSpendCents: number;
  reviewTimeoutMs: number;
  maxDurationMs: number;
}

export const DEFAULT_OUTREACH_JOB_OPTIONS: Readonly<OutreachJobOptions> = Object.freeze({
  batchSchedule: "0 13 * * MON-THU",
  reviewMaxSpendCents: 50,
  reviewTimeoutMs: 45_000,
  maxDurationMs: 300_000,
});

export interface OutreachDeps<E extends OutreachEnv = OutreachEnv> {
  /** The send function at the provider boundary. Built inside the run. */
  send(env: E): SendOutreach;
  /** Today's cold volume from the warm-up ramp. A throw or a non-positive number means no batch. */
  volume(env: E, ctx: { now: Date; flags: FlagReader }): Promise<number>;
  /** The model gateway for the reviewer. Without it the reviewer is unavailable and nothing auto-sends. */
  model?(env: E): ModelGateway | undefined;
  /** Where batch summaries, release codes and pages go. */
  operator?(env: E): OperatorChannel | undefined;
  /** Templates bundled with the Worker. Without them, templates are served from KV. */
  templates?(env: E): readonly TemplateFile[] | Promise<readonly TemplateFile[]>;
  options?: Partial<OutreachJobOptions>;
}

/** Refuse a model-calling schedule that fires more often than every 15 minutes. */
function assertNotPerMinute(schedule: string, job: string): void {
  const minutes = [...parseCron(schedule).minutes].sort((a, b) => a - b);
  const tooClose = minutes.length > 1 && minutes.some((m, i) => (i === 0 ? m + 60 - (minutes.at(-1) ?? m) : m - (minutes[i - 1] ?? m)) < 15);
  if (minutes.length > 4 || tooClose) throw new Error(`job ${job}: model calls never run in a per-minute job; schedule it at most every 15 minutes`);
}

const quietly = <T>(build: () => T): T | undefined => {
  try {
    return build();
  } catch {
    return undefined;
  }
};

export function createOutreachJobs<E extends OutreachEnv>(deps: OutreachDeps<E>): RegisteredJob<E>[] {
  const options: OutreachJobOptions = { ...DEFAULT_OUTREACH_JOB_OPTIONS, ...(deps.options ?? {}) };
  assertNotPerMinute(options.batchSchedule, COLD_BATCH_JOB);
  const coldBatch = defineJob<E>({
    name: COLD_BATCH_JOB,
    schedule: options.batchSchedule,
    flag: OUTREACH_FLAGS.enabled,
    ceilings: { maxDurationMs: options.maxDurationMs, maxRows: OUTREACH_LIMITS.batchMax, maxSpendCents: options.reviewMaxSpendCents },
    critical: true,
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readOn(ctx.flags, OUTREACH_FLAGS.enabled))) return { summary: "flag off" };
      const env = ctx.env;
      const templates = deps.templates ? await deps.templates(env) : undefined;
      const result = await runColdBatch({
        db: env.DB,
        kv: env.KV,
        flags: ctx.flags,
        config: ctx.config,
        now: ctx.now,
        job: ctx.job,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        signal: ctx.signal,
        log: ctx.log,
        send: deps.send(env),
        volume: () => deps.volume(env, { now: ctx.now, flags: ctx.flags }),
        model: deps.model ? quietly(() => deps.model?.(env)) : undefined,
        operator: deps.operator ? quietly(() => deps.operator?.(env)) : undefined,
        ...(templates ? { templates } : {}),
        appUrl: env.PRODUCT_APP_URL,
        reviewMaxSpendCents: options.reviewMaxSpendCents,
        reviewTimeoutMs: options.reviewTimeoutMs,
        ...(ctx.ceilings.maxRows !== undefined ? { maxDrafts: ctx.ceilings.maxRows } : {}),
      });
      return { summary: `${result.status}: ${result.summary}`, rows: result.drafts };
    },
  });
  return [coldBatch];
}
