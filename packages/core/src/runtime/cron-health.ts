// GTM-agents: the cron health check.
//
// Cloudflare cron triggers occasionally do not fire, and a job can fail every day without anyone
// looking. For each job registered as `critical`, this check works out when the job last should
// have fired (from its schedule, allowing for its duration ceiling plus a grace period) and looks
// for a run row since then:
//   - a completed run is healthy;
//   - a run skipped on purpose (halted, flag off, over budget) was held, not missed. A run skipped
//     because state could not be read ("unreadable") is reported as failed;
//   - a failed run is reported with its sanitized error;
//   - a run still marked running past its ceiling and the grace period is reported as abandoned;
//   - no row at all is reported as missed.
// A missed, failed or abandoned job marked `rerunnable` runs again through the job runner, so the
// halt, its flag and the budget gate still apply. Each expected fire is rerun at most once: the
// rerun is claimed in the effects ledger first. Reruns that would not finish before the check's
// own deadline are left for the next check.
import { claimEffect } from "../events/effects.ts";
import { previousFire } from "../jobs/cron.ts";
import { runOneJob, type ContextFactory, type JobOutcome, type JobRunner } from "../jobs/loop.ts";
import type { JobDefinition, JobRegistry } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { claimPage, notifyWithin, releasePage, type RunnerEnv } from "./job-runner.ts";

export const DEFAULT_GRACE_MS = 15 * 60 * 1000;
export const CRON_HEALTH_CEILING_MS = 120_000;

export type CronHealthStatus = "ok" | "skipped" | "missed" | "failed" | "abandoned" | "unknown";

export interface CronHealthFinding {
  job: string;
  status: CronHealthStatus;
  /** When the job last should have fired. */
  expectedAt: string;
  error?: string;
  rerun?: JobOutcome;
  /** Set when a rerun was due but left for the next check. */
  rerunDeferred?: string;
}

export interface Rerun<E> {
  makeContext: ContextFactory<E>;
  runner: JobRunner<E>;
  /** Epoch milliseconds by which every rerun must be able to finish. */
  deadline?: number;
}

export interface CronHealthOptions<E> {
  registry: JobRegistry<E>;
  db: D1Database;
  now?: Date;
  /** Time after a job's ceiling before a missing run counts as missed. Defaults to 15 minutes. */
  graceMs?: number;
  /** Rerun missed or failed rerunnable jobs through this runner. */
  rerun?: Rerun<E>;
  /** Jobs to leave out, such as the job running the check. */
  exclude?: readonly string[];
}

const UNHEALTHY: ReadonlySet<CronHealthStatus> = new Set(["missed", "failed", "abandoned"]);

/** Inspect every critical job. Reruns nothing unless `rerun` is given. */
export async function checkCronHealth<E>(options: CronHealthOptions<E>): Promise<CronHealthFinding[]> {
  const now = options.now ?? new Date();
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const findings: CronHealthFinding[] = [];
  for (const job of options.registry.jobs) {
    if (!job.critical || options.exclude?.includes(job.name)) continue;
    const cutoff = new Date(now.getTime() - job.ceilings.maxDurationMs - grace);
    const fire = previousFire(job.cron, cutoff);
    if (!fire) continue;
    const expectedAt = fire.toISOString();
    try {
      const { results } = await options.db
        .prepare("SELECT status, error, summary, started_at FROM execution_runs WHERE task_name = ?1 AND started_at >= ?2 ORDER BY started_at DESC LIMIT 50")
        .bind(job.name, expectedAt)
        .all<{ status: string; error: string | null; summary: string | null; started_at: string }>();
      const latest = results[0];
      const unreadable = (summary: string | null) => (summary ?? "").includes("unreadable");
      const heldOnPurpose = results.find((r) => r.status === "skipped" && !unreadable(r.summary));
      const heldUnreadable = results.find((r) => r.status === "skipped" && unreadable(r.summary));
      const stale = results.find((r) => r.status === "running" && r.started_at <= cutoff.toISOString());
      if (results.some((r) => r.status === "completed")) findings.push({ job: job.name, status: "ok", expectedAt });
      else if (heldOnPurpose) findings.push({ job: job.name, status: "skipped", expectedAt });
      else if (latest?.status === "failed") findings.push({ job: job.name, status: "failed", expectedAt, error: latest.error ?? "unknown error" });
      else if (heldUnreadable) findings.push({ job: job.name, status: "failed", expectedAt, error: `held: ${heldUnreadable.summary ?? "unreadable"}` });
      else if (stale) findings.push({ job: job.name, status: "abandoned", expectedAt });
      else if (latest?.status === "running") findings.push({ job: job.name, status: "ok", expectedAt });
      else findings.push({ job: job.name, status: "missed", expectedAt });
    } catch (error) {
      findings.push({ job: job.name, status: "unknown", expectedAt, error: sanitizeErrorMessage(error) });
    }
  }
  if (options.rerun) await rerunUnhealthy(findings, options.registry, options.db, options.rerun);
  return findings;
}

/** Rerun the unhealthy, rerunnable jobs among `findings`, at most once per expected fire. */
export async function rerunUnhealthy<E>(findings: CronHealthFinding[], registry: JobRegistry<E>, db: D1Database, rerun: Rerun<E>): Promise<void> {
  for (const finding of findings) {
    const job = registry.get(finding.job);
    if (!job || !job.rerunnable || !UNHEALTHY.has(finding.status)) continue;
    if (rerun.deadline !== undefined && Date.now() + job.ceilings.maxDurationMs > rerun.deadline) {
      finding.rerunDeferred = "the rerun could take longer than the time left in this check";
      continue;
    }
    let claimed: boolean;
    try {
      claimed = await claimEffect(db, `cron-health:${job.name}:${finding.expectedAt}`, "rerun");
    } catch {
      claimed = false;
    }
    if (!claimed) continue;
    finding.rerun = await runOneJob(job, (j, signal) => ({ ...rerun.makeContext(j, signal), trigger: "rerun" }), rerun.runner);
  }
}

export interface CronHealthJobOptions<E> {
  /** When the check runs, as a job schedule, for example "30 10,15 * * *". */
  schedule: string;
  /** The registry to watch. A function, because the check job is itself registered in it. */
  registry: () => JobRegistry<E>;
  runner: JobRunner<E>;
  operator?: (env: E) => OperatorChannel | undefined;
  graceMs?: number;
}

export const CRON_HEALTH_JOB = "cron_health";

/**
 * The cron health check as a job. It pages each unhealthy finding first, at most once per job and
 * status per day (with the same KV fallback as job failure pages), then reruns what it can within
 * its own ceiling.
 */
export function createCronHealthJob<E extends RunnerEnv>(options: CronHealthJobOptions<E>): JobDefinition<E> {
  return {
    name: CRON_HEALTH_JOB,
    schedule: options.schedule,
    ceilings: { maxDurationMs: CRON_HEALTH_CEILING_MS },
    async run(ctx) {
      const started = Date.now();
      const registry = options.registry();
      const findings = await checkCronHealth({
        registry,
        db: ctx.env.DB,
        now: new Date(),
        exclude: [CRON_HEALTH_JOB],
        ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      });
      const unhealthy = findings.filter((f) => UNHEALTHY.has(f.status) || f.status === "unknown");
      let operator: OperatorChannel | undefined;
      try {
        operator = options.operator?.(ctx.env);
      } catch {
        operator = undefined;
      }
      let paged = 0;
      if (operator) {
        const eventId = `cron-health:${new Date().toISOString().slice(0, 10)}`;
        for (const f of unhealthy) {
          const effect = `${f.job}:${f.status}`;
          if (!(await claimPage(ctx.env.DB, ctx.env.KV, eventId, effect))) continue;
          const text = `Cron health: ${f.job} is ${f.status} (expected at ${f.expectedAt}).${f.error ? ` Error: ${f.error}` : ""}`;
          if (await notifyWithin(operator, text)) paged += 1;
          else await releasePage(ctx.env.DB, ctx.env.KV, eventId, effect);
        }
      }
      // A rerun for this check is the same run, so the Worker stays alive while it finishes.
      await rerunUnhealthy(findings, registry, ctx.env.DB, {
        runner: options.runner,
        deadline: started + CRON_HEALTH_CEILING_MS - 5_000,
        makeContext: (j, signal) => ({ ...ctx, job: j.name, signal, ceilings: j.ceilings }),
      });
      const reran = findings.filter((f) => f.rerun).length;
      return { summary: `${findings.length} critical job(s) checked, ${unhealthy.length} unhealthy, ${paged} paged, ${reran} rerun` };
    },
  };
}
