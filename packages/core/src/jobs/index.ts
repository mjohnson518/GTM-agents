// GTM-agents: public entry point for the job registry, schedules and the scheduled loop.
export { CronError, cronMatches, normalizeCron, parseCron, previousFire } from "./cron.ts";
export type { CronSchedule } from "./cron.ts";
export { SCHEDULER_CRON, createJobRegistry, defineJob } from "./registry.ts";
export type { FlagReader, JobCeilings, JobContext, JobDefinition, JobLogger, JobRegistry, JobResult, JobTrigger, RegisteredJob } from "./registry.ts";
export { DUE_JOB_CONCURRENCY, HALT_FLAG, defaultRunner, inRunOrder, isFlagOn, runDueJobs, runJobsConcurrently, runJobsInOrder, runOneJob, runScheduledJobs, withTimeout } from "./loop.ts";
export type { ConcurrentOptions, ContextFactory, JobOutcome, JobRunner } from "./loop.ts";
