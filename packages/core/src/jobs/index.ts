// GTM-agents: public entry point for the job registry, schedules and the scheduled loop.
export { CronError, cronMatches, normalizeCron, parseCron, previousFire } from "./cron.ts";
export type { CronSchedule } from "./cron.ts";
export { createJobRegistry, defineJob } from "./registry.ts";
export type { FlagReader, JobCeilings, JobContext, JobDefinition, JobLogger, JobRegistry, JobResult, JobTrigger, RegisteredJob } from "./registry.ts";
export { HALT_FLAG, defaultRunner, isFlagOn, runOneJob, runScheduledJobs, withTimeout } from "./loop.ts";
export type { ContextFactory, JobOutcome, JobRunner } from "./loop.ts";
