// GTM-agents: the sequence jobs a deployment registers.
//
//   createSequenceJobs({ email: (env) => provider, operator: (env) => channel, model: (env) => gateway })
//
// returns two job definitions for the job registry:
//   - sequence_sweep        08:30, 12:30, 16:30 and 20:30 UTC, Monday to Friday, flag sequences:enabled
//                           (default off): the follow-up sweep (sweep.ts). Ceilings: 4 minutes, 200
//                           rows, and a daily spend cap for the model reviewer. Safe to rerun: every
//                           step is keyed, so a rerun never sends a step twice;
//   - sequence_stale_check  10:00 UTC on Saturdays, flag sequences:enabled: reports stale and paused
//                           sequences once (stale.ts). Ceilings: 30 seconds, 500 rows. No model call.
// The sweep calls a model (the reviewer), so a schedule that fires more often than every 15 minutes
// is refused. Every dependency is built per run from the environment, so secrets are read when the
// job runs. The job runner checks the halt, the flag and the budget before a run; each job re-reads
// its flag as well, so calling run() directly with the flag off does nothing.
import type { KVReader } from "../brain/load.ts";
import { parseCron } from "../jobs/cron.ts";
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import { readOn } from "../outreach/flags.ts";
import type { EmailProvider } from "../ports/email.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { OutreachSenderOptions } from "../sending/boundary.ts";
import { senderDepsFromEnv, type DeliveryEnv } from "../sending/jobs.ts";
import type { KvStore } from "../shared/kv.ts";
import type { TemplateFile } from "../templates/store.ts";
import { SEQUENCE_FLAGS, SEQUENCE_LIMITS } from "./flags.ts";
import { createSequenceSender } from "./sender.ts";
import { runStaleCheck } from "./stale.ts";
import { runFollowUpSweep } from "./sweep.ts";

export const SEQUENCE_SWEEP_JOB = "sequence_sweep";
export const SEQUENCE_STALE_JOB = "sequence_stale_check";

/** The bindings the sequence jobs read. A deployment's Env satisfies it. */
export interface SequenceEnv extends DeliveryEnv {
  KV?: KvStore & KVReader;
  /** The product's app URL; copy may link to its host. */
  PRODUCT_APP_URL?: string;
}

export interface SequenceJobOptions {
  sweepSchedule: string;
  staleSchedule: string;
  /** Rows one sweep reads, at most (the job's ceilings.maxRows). */
  sweepMaxRows: number;
  maxDurationMs: number;
  /** Daily spend cap for the model reviewer, in cents (the job's ceilings.maxSpendCents). */
  reviewMaxSpendCents: number;
  reviewTimeoutMs: number;
  /** Message-ID lookups at the provider per sweep, at most. */
  messageIdLookups: number;
  /** Manual touches asked for per UTC day, at most. */
  manualTouchesPerDay: number;
  /** Options for the send function, as for the delivery jobs. */
  sender: Partial<OutreachSenderOptions>;
}

export const DEFAULT_SEQUENCE_JOB_OPTIONS: Readonly<SequenceJobOptions> = Object.freeze({
  sweepSchedule: "30 8,12,16,20 * * MON-FRI",
  staleSchedule: "0 10 * * SAT",
  sweepMaxRows: 200,
  maxDurationMs: 240_000,
  reviewMaxSpendCents: 25,
  reviewTimeoutMs: 45_000,
  messageIdLookups: SEQUENCE_LIMITS.messageIdLookups,
  manualTouchesPerDay: SEQUENCE_LIMITS.manualTouchesPerDay,
  sender: {},
});

export interface SequenceDeps<E extends SequenceEnv = SequenceEnv> {
  /** The email provider: the steps go out through it, and it looks up Message-IDs. */
  email: (env: E) => EmailProvider | undefined;
  /** Where release codes, notices and reports go. */
  operator?: (env: E) => OperatorChannel | undefined;
  /** The model gateway for the reviewer. Without it the reviewer is unavailable and nothing auto-sends. */
  model?: (env: E) => ModelGateway | undefined;
  /** Templates bundled with the Worker. Without them, templates are served from KV. */
  templates?: (env: E) => readonly TemplateFile[] | Promise<readonly TemplateFile[]>;
  options?: Partial<SequenceJobOptions>;
}

/** Refuse a model-calling schedule that fires more often than every 15 minutes. */
function assertNotPerMinute(schedule: string, job: string): void {
  const minutes = [...parseCron(schedule).minutes].sort((a, b) => a - b);
  const tooClose = minutes.length > 1 && minutes.some((m, i) => (i === 0 ? m + 60 - (minutes.at(-1) ?? m) : m - (minutes[i - 1] ?? m)) < 15);
  if (minutes.length > 4 || tooClose) throw new Error(`job ${job}: model calls never run in a per-minute job; schedule it at most every 15 minutes`);
}

const quietly = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

export function createSequenceJobs<E extends SequenceEnv>(deps: SequenceDeps<E>): RegisteredJob<E>[] {
  const options: SequenceJobOptions = { ...DEFAULT_SEQUENCE_JOB_OPTIONS, ...(deps.options ?? {}) };
  assertNotPerMinute(options.sweepSchedule, SEQUENCE_SWEEP_JOB);
  if (!Number.isInteger(options.sweepMaxRows) || options.sweepMaxRows < 1 || options.sweepMaxRows > 1000) {
    throw new Error("sequence option sweepMaxRows must be a whole number from 1 to 1000");
  }

  const sweep = defineJob<E>({
    name: SEQUENCE_SWEEP_JOB,
    schedule: options.sweepSchedule,
    flag: SEQUENCE_FLAGS.enabled,
    ceilings: { maxDurationMs: options.maxDurationMs, maxRows: options.sweepMaxRows, maxSpendCents: options.reviewMaxSpendCents },
    critical: true,
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readOn(ctx.flags, SEQUENCE_FLAGS.enabled))) return { summary: "flag off" };
      const env = ctx.env;
      const provider = quietly(deps.email, env);
      const operator = quietly(deps.operator, env);
      const templates = deps.templates ? await deps.templates(env) : undefined;
      const send = createSequenceSender(
        senderDepsFromEnv(env, { config: ctx.config, provider, ...(operator ? { operator } : {}), now: () => ctx.now, options: options.sender, log: ctx.log }),
      );
      const result = await runFollowUpSweep({
        db: env.DB,
        kv: env.KV,
        flags: ctx.flags,
        config: ctx.config,
        now: ctx.now,
        job: ctx.job,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        signal: ctx.signal,
        log: ctx.log,
        send,
        provider,
        model: quietly(deps.model, env),
        operator,
        ...(templates ? { templates } : {}),
        appUrl: env.PRODUCT_APP_URL,
        reviewMaxSpendCents: options.reviewMaxSpendCents,
        reviewTimeoutMs: options.reviewTimeoutMs,
        maxRows: Math.min(options.sweepMaxRows, ctx.ceilings.maxRows ?? options.sweepMaxRows),
        messageIdLookups: options.messageIdLookups,
        manualTouchesPerDay: options.manualTouchesPerDay,
      });
      return { summary: `${result.status}: ${result.summary}`, rows: result.due };
    },
  });

  const stale = defineJob<E>({
    name: SEQUENCE_STALE_JOB,
    schedule: options.staleSchedule,
    flag: SEQUENCE_FLAGS.enabled,
    ceilings: { maxDurationMs: 30_000, maxRows: 500 },
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readOn(ctx.flags, SEQUENCE_FLAGS.enabled))) return { summary: "flag off" };
      const result = await runStaleCheck({ db: ctx.env.DB, operator: quietly(deps.operator, ctx.env), now: ctx.now, log: ctx.log, maxRows: ctx.ceilings.maxRows ?? 500 });
      return { summary: `${result.stale} stale (${result.paused} paused), ${result.reported} reported`, rows: result.stale };
    },
  });

  return [sweep, stale];
}
