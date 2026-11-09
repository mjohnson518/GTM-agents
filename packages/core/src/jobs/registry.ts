// GTM-agents: the job registry. Scheduled work is declared as data, and the Worker's scheduled
// handler loops over the registry instead of switching on cron strings. The Worker has one cron
// trigger, every minute (SCHEDULER_CRON); each minute the handler runs the jobs whose own schedule
// matches that minute (dueAt), so adding a job never means editing wrangler.jsonc.
import type { GtmConfig } from "../config/schema.ts";
import { cronMatches, normalizeCron, parseCron, type CronSchedule } from "./cron.ts";

/**
 * The Worker's only cron trigger. Every minute the scheduled handler runs each registered job whose
 * schedule matches that minute (UTC). A second trigger would run the jobs due in its minutes twice.
 */
export const SCHEDULER_CRON = "* * * * *";

export interface JobCeilings {
  /** Wall-clock budget for one run. Required: every job is bounded. */
  maxDurationMs: number;
  /** Rows the job may touch in one run. */
  maxRows?: number;
  /** Spend the job may incur in one day, in cents. */
  maxSpendCents?: number;
}

export interface JobLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface FlagReader {
  /** The raw flag value, or null when unset. Throws when the flag store cannot be read. */
  get(key: string): Promise<string | null>;
}

export type JobTrigger = "cron" | "rerun" | "manual";

export interface JobContext<E = unknown> {
  env: E;
  config: GtmConfig;
  job: string;
  now: Date;
  /** Why the job is running. Defaults to "cron". */
  trigger?: JobTrigger;
  /** The run row's id, set by the job runner. Cost rows recorded by the job carry it. */
  runId?: string;
  /** Aborted when the job exceeds its duration ceiling. */
  signal: AbortSignal;
  /**
   * Set by the scheduler when the job cannot start in time to finish within the invocation. The
   * runner then records the run as failed with this reason, without running the job.
   */
  notStarted?: string;
  ceilings: JobCeilings;
  flags: FlagReader;
  log: JobLogger;
}

export interface JobResult {
  summary?: string;
  rows?: number;
}

export interface JobDefinition<E = unknown> {
  /** snake_case, unique in the registry. */
  name: string;
  /** Five-field UTC cron with named days, for example "0 13 * * MON-THU". */
  schedule: string;
  /** When set, the job runs only while this flag is on. */
  flag?: string;
  ceilings: JobCeilings;
  /** Critical jobs are watched by the cron health check. */
  critical?: boolean;
  /** Safe to run again if a scheduled run was missed. */
  rerunnable?: boolean;
  run(ctx: JobContext<E>): Promise<JobResult | void>;
}

export interface RegisteredJob<E = unknown> extends JobDefinition<E> {
  readonly cron: CronSchedule;
}

const JOB_NAME = /^[a-z][a-z0-9_]{1,63}$/;
/**
 * The longest a scheduled job may run: the scheduled handler's wall budget inside Cloudflare's
 * 15-minute limit for one cron invocation. A longer ceiling could never be started from cron.
 */
export const MAX_JOB_DURATION_MS = 14 * 60 * 1000;

/** Declare a job. Validates the name, the schedule and the ceilings at definition time. */
export function defineJob<E = unknown>(definition: JobDefinition<E>): RegisteredJob<E> {
  if (!JOB_NAME.test(definition.name)) throw new Error(`job name "${definition.name}" must be snake_case`);
  const cron = parseCron(definition.schedule);
  const c = definition.ceilings;
  if (!(Number.isFinite(c.maxDurationMs) && c.maxDurationMs > 0)) throw new Error(`job ${definition.name}: ceilings.maxDurationMs must be a positive number`);
  if (c.maxDurationMs > MAX_JOB_DURATION_MS) {
    throw new Error(`job ${definition.name}: ceilings.maxDurationMs is over ${MAX_JOB_DURATION_MS / 60_000} minutes, so it could never start within one cron invocation`);
  }
  if (c.maxRows !== undefined && !(Number.isInteger(c.maxRows) && c.maxRows > 0)) throw new Error(`job ${definition.name}: ceilings.maxRows must be a positive integer`);
  if (c.maxSpendCents !== undefined && !(Number.isInteger(c.maxSpendCents) && c.maxSpendCents >= 0)) {
    throw new Error(`job ${definition.name}: ceilings.maxSpendCents must be a whole number of cents, zero or more`);
  }
  return Object.freeze({ ...definition, schedule: cron.expression, cron });
}

export interface JobRegistry<E = unknown> {
  readonly jobs: readonly RegisteredJob<E>[];
  get(name: string): RegisteredJob<E> | undefined;
  /** Jobs whose schedule fires at this minute (UTC), in registration order: what the per-minute trigger runs. */
  dueAt(at: Date): RegisteredJob<E>[];
  /** Jobs whose schedule is exactly this cron expression, in registration order. */
  forCron(cron: string): RegisteredJob<E>[];
  /** Distinct schedules, sorted. Informational: the Worker itself needs only SCHEDULER_CRON. */
  schedules(): string[];
}

export function createJobRegistry<E = unknown>(jobs: Array<JobDefinition<E> | RegisteredJob<E>>): JobRegistry<E> {
  const registered = jobs.map((j) => ("cron" in j ? j : defineJob(j)));
  const seen = new Set<string>();
  for (const job of registered) {
    if (seen.has(job.name)) throw new Error(`job ${job.name} is registered twice`);
    seen.add(job.name);
  }
  return {
    jobs: registered,
    get: (name) => registered.find((j) => j.name === name),
    dueAt: (at) => registered.filter((j) => cronMatches(j.cron, at)),
    forCron: (cron) => {
      const key = normalizeCron(cron);
      return registered.filter((j) => j.schedule === key);
    },
    schedules: () => [...new Set(registered.map((j) => j.schedule))].sort(),
  };
}
