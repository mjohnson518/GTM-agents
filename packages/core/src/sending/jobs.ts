// GTM-agents: the delivery jobs a deployment registers.
//
//   createDeliveryJobs({ email: (env) => emailProvider(env), operator: (env) => operatorChannel(env) })
//
// returns four job definitions for the job registry:
//   - delivery_replay         00:00, 08:00, 13:00 and 20:00 UTC, Monday to Friday (mornings in Asia
//                             and the Pacific, Europe and the US East, and the US West afternoon), flag
//                             delivery:enabled: replays due deferred sends through the send function;
//   - delivery_bounce_monitor 09:00 UTC every day, flag delivery:enabled: bounce windows, automatic
//                             pauses and the daily reminder of a critical pause;
//   - delivery_ramp           09:30 UTC Monday to Friday, flag outreach:ramp_auto: one warm-up ramp
//                             decision;
//   - delivery_liveness       21:00 UTC Monday to Friday, flag cold_batch:enabled: pages when mail
//                             quietly stops.
// Every flag defaults off, so registering the jobs changes nothing until the operator turns them on.
// The job runner checks the halt, the flag and the budget first; each job also re-reads its own
// flag (failing closed), so calling run() directly with the flag off does nothing. None of them
// calls a model. Adapters are built per run from the environment, so secrets are read when a job
// runs, not at import time.
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { EmailProvider } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { KvStore } from "../shared/kv.ts";
import type { OutreachSenderDeps, OutreachSenderOptions } from "./boundary.ts";
import { runBounceMonitor } from "./bounce-monitor.ts";
import { replayDeferred } from "./deferred.ts";
import { DELIVERY_FLAGS, readSwitch } from "./flags.ts";
import { runLiveness } from "./liveness.ts";
import { runRampJob } from "./ramp.ts";

export const REPLAY_JOB = "delivery_replay";
export const BOUNCE_MONITOR_JOB = "delivery_bounce_monitor";
export const RAMP_JOB = "delivery_ramp";
export const LIVENESS_JOB = "delivery_liveness";

/** The bindings the delivery jobs read. A deployment's Env satisfies it. */
export interface DeliveryEnv {
  DB: D1Database;
  KV?: KvStore;
  UNSUBSCRIBE_SIGNING_KEY?: string;
  AGENT_BASE_URL?: string;
}

export interface DeliveryJobOptions {
  replaySchedule: string;
  bounceMonitorSchedule: string;
  rampSchedule: string;
  livenessSchedule: string;
  /** Deferred rows replayed per run. */
  replayMaxRows: number;
  sender: Partial<OutreachSenderOptions>;
}

export const DEFAULT_DELIVERY_JOB_OPTIONS: Readonly<DeliveryJobOptions> = Object.freeze({
  replaySchedule: "0 0,8,13,20 * * MON-FRI",
  bounceMonitorSchedule: "0 9 * * SUN-SAT",
  rampSchedule: "30 9 * * MON-FRI",
  livenessSchedule: "0 21 * * MON-FRI",
  replayMaxRows: 200,
  sender: {},
});

export interface DeliveryDeps<E extends DeliveryEnv = DeliveryEnv> {
  /** Build the email provider for one run. Return undefined when it is not configured. */
  email: (env: E) => EmailProvider | undefined;
  /** The operator channel for pages. */
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<DeliveryJobOptions>;
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

/** The send function's dependencies, from a deployment's environment. */
export function senderDepsFromEnv<E extends DeliveryEnv>(
  env: E,
  input: { config: OutreachSenderDeps["config"]; provider: EmailProvider | undefined; operator?: OperatorChannel; now?: () => Date; options?: Partial<OutreachSenderOptions>; log?: OutreachSenderDeps["log"] },
): OutreachSenderDeps {
  return {
    db: env.DB,
    kv: env.KV,
    config: input.config,
    provider: input.provider,
    unsubscribeSigningKey: env.UNSUBSCRIBE_SIGNING_KEY,
    baseUrl: env.AGENT_BASE_URL,
    ...(input.operator ? { operator: input.operator } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.options ? { options: input.options } : {}),
    ...(input.log ? { log: input.log } : {}),
  };
}

export function createDeliveryJobs<E extends DeliveryEnv>(deps: DeliveryDeps<E>): RegisteredJob<E>[] {
  const options: DeliveryJobOptions = { ...DEFAULT_DELIVERY_JOB_OPTIONS, ...(deps.options ?? {}) };
  if (!Number.isInteger(options.replayMaxRows) || options.replayMaxRows < 1 || options.replayMaxRows > 1000) {
    throw new Error("delivery option replayMaxRows must be a whole number from 1 to 1000");
  }

  const replay = defineJob<E>({
    name: REPLAY_JOB,
    schedule: options.replaySchedule,
    flag: DELIVERY_FLAGS.enabled,
    ceilings: { maxDurationMs: 240_000, maxRows: options.replayMaxRows },
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readSwitch(ctx.flags, DELIVERY_FLAGS.enabled))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const result = await replayDeferred({
        ...senderDepsFromEnv(ctx.env, { config: ctx.config, provider: tryBuild(deps.email, ctx.env), ...(operator ? { operator } : {}), now: () => ctx.now, options: options.sender, log: ctx.log }),
        flags: ctx.flags,
        maxRows: Math.min(options.replayMaxRows, ctx.ceilings.maxRows ?? options.replayMaxRows),
      });
      return {
        summary: `due ${result.due}, claimed ${result.claimed}, sent ${result.sent}, requeued ${result.requeued}, cancelled ${result.cancelled}, failed ${result.failed}`,
        rows: result.claimed,
      };
    },
  });

  const bounce = defineJob<E>({
    name: BOUNCE_MONITOR_JOB,
    schedule: options.bounceMonitorSchedule,
    flag: DELIVERY_FLAGS.enabled,
    ceilings: { maxDurationMs: 60_000, maxRows: 10 },
    critical: true,
    rerunnable: true,
    async run(ctx: JobContext<E>) {
      if (!(await readSwitch(ctx.flags, DELIVERY_FLAGS.enabled))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const result = await runBounceMonitor({ db: ctx.env.DB, kv: ctx.env.KV, ...(operator ? { operator } : {}), now: ctx.now });
      return { summary: `${result.overall}: 7d ${result.window7d.bounced}/${result.window7d.sent}, 1d ${result.window1d.bounced}/${result.window1d.sent}; ${result.action}` };
    },
  });

  const ramp = defineJob<E>({
    name: RAMP_JOB,
    schedule: options.rampSchedule,
    flag: DELIVERY_FLAGS.rampAuto,
    ceilings: { maxDurationMs: 30_000, maxRows: 10 },
    async run(ctx: JobContext<E>) {
      if (!(await readSwitch(ctx.flags, DELIVERY_FLAGS.rampAuto))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const result = await runRampJob({ db: ctx.env.DB, kv: ctx.env.KV, ...(operator ? { operator } : {}), now: ctx.now });
      return { summary: `${result.action} (${result.from} -> ${result.to} a day): ${result.reason}` };
    },
  });

  const liveness = defineJob<E>({
    name: LIVENESS_JOB,
    schedule: options.livenessSchedule,
    flag: DELIVERY_FLAGS.coldBatchEnabled,
    ceilings: { maxDurationMs: 30_000, maxRows: 10 },
    async run(ctx: JobContext<E>) {
      if (!(await readSwitch(ctx.flags, DELIVERY_FLAGS.coldBatchEnabled))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const result = await runLiveness({ db: ctx.env.DB, kv: ctx.env.KV, flags: ctx.flags, config: ctx.config, ...(operator ? { operator } : {}), now: ctx.now });
      return { summary: result.quiet ? `quiet (${result.paged ? "paged" : "already paged today"}): ${result.diagnosis.join("; ")}` : `ok: ${result.sentToday} today, ${result.sentLast3Days} in 3 days` };
    },
  });

  return [replay, bounce, ramp, liveness];
}
