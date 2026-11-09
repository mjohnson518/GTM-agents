// GTM-agents: the runtime module's public surface: the tool dispatcher and its pre-call checks, the
// fault-tolerant job runner, the cron health check and run-row retention.
export { executeToolCall } from "./dispatcher.ts";
export type {
  CallOptions,
  DispatchResult,
  DispatcherDeps,
  PreCallCheck,
  ToolCall,
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolSession,
} from "./dispatcher.ts";
export { budgetCheck, rateLimitCheck } from "./checks.ts";
export type { BudgetCheckOptions, RateLimitCheckOptions } from "./checks.ts";
export {
  ESCALATE_FAILURES_PER_DAY,
  ESCALATE_STREAK_DAYS,
  NOTIFY_TIMEOUT_MS,
  claimPage,
  classifyJobError,
  createJobRunner,
  failureStats,
  notifyJobFailure,
  notifyWithin,
  releasePage,
} from "./job-runner.ts";
export type { JobErrorClass, JobRunnerOptions, RunnerEnv } from "./job-runner.ts";
export { CRON_HEALTH_CEILING_MS, CRON_HEALTH_JOB, DEFAULT_GRACE_MS, checkCronHealth, createCronHealthJob, rerunUnhealthy } from "./cron-health.ts";
export type { CronHealthFinding, CronHealthJobOptions, CronHealthOptions, CronHealthStatus, Rerun } from "./cron-health.ts";
export {
  DEFAULT_RUN_RETENTION_SCHEDULE,
  RETAINED_STATUSES,
  RETENTION_BATCH_ROWS,
  RETENTION_CEILING_MS,
  RETENTION_MAX_ROWS,
  RUN_RETENTION_DAYS,
  RUN_RETENTION_FLAG,
  RUN_RETENTION_JOB,
  createRetentionJob,
  pruneRunRows,
} from "./retention.ts";
export type { PruneOptions, PruneResult, RetainedStatus, RetentionJobOptions } from "./retention.ts";
