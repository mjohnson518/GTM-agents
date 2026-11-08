// GTM-agents: the inbox jobs a deployment registers.
//
//   createInboxJobs({ inbox: (env) => gmailInbox(env), operator: (env) => operatorChannel(env) })
//
// returns three job definitions for the job registry, all behind inbox:enabled (default off):
//   - inbox_poll           every minute: retries pending rows (rules a compliance write could not
//                          finish), then lists new mail from the stored cursor and records it. No
//                          model call, a small row ceiling, and near-zero cost when nothing is new
//                          (one provider call). With no listing provider (an Email Routing only
//                          deployment) it still runs the pending pass. Note that the job runner
//                          writes a run row for every run, so this job adds about 1,440 rows a day
//                          to execution_runs: plan retention for run rows with that in mind;
//   - inbox_sweep          every 15 minutes: lists the last 3 days without a cursor and records
//                          only what the database does not hold, then fetches again the bodies that
//                          could not be stored. Critical: the cron health check watches it;
//   - inbox_watch_renewal  daily at 06:20 UTC: renews the mailbox's push registration (Gmail
//                          watches expire after 7 days). Skipped when the provider has no push
//                          configured. Critical.
// Adapters are built per run from the environment, so secrets are read when a job runs. Each job
// checks inbox:enabled again itself (failing closed), so calling run() directly with the flag off
// does nothing.
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { KvStore } from "../shared/kv.ts";
import { INBOX_FLAGS, inboxEnabled } from "./flags.ts";
import { processPendingInbound, type InboxIntakeDeps } from "./intake.ts";
import { pollInbox, sweepInbox } from "./poll.ts";

export const INBOX_POLL_JOB = "inbox_poll";
/**
 * The start of a poll run's summary when it listed the mailbox and recorded everything it saw. Only
 * such a run shows that replies are being read: the follow-up sweep's intake gate looks for it, so a
 * run with no mailbox, a listing the adapter cannot do, or a message it failed to record never counts.
 */
export const POLL_LISTED_MARK = "listed;";
export const INBOX_SWEEP_JOB = "inbox_sweep";
export const INBOX_WATCH_JOB = "inbox_watch_renewal";

/** The bindings the inbox reads. A deployment's Env satisfies it. */
export interface InboxEnv {
  DB: D1Database;
  KV?: KvStore;
  BUCKET?: R2Bucket;
}

export interface InboxJobOptions {
  pollSchedule: string;
  sweepSchedule: string;
  watchSchedule: string;
  /** Messages listed per provider call in the poll. */
  pollLimit: number;
  /** Provider calls per poll while more mail waits. */
  pollPages: number;
  /** Pending rows retried per poll. */
  pendingLimit: number;
  /** Messages fetched per sweep. */
  sweepLimit: number;
  /** Bodies fetched again per sweep. */
  repairLimit: number;
}

export const DEFAULT_INBOX_JOB_OPTIONS: Readonly<InboxJobOptions> = Object.freeze({
  pollSchedule: "* * * * *",
  sweepSchedule: "*/15 * * * *",
  watchSchedule: "20 6 * * SUN-SAT",
  pollLimit: 20,
  pollPages: 2,
  pendingLimit: 10,
  sweepLimit: 25,
  repairLimit: 5,
});

export interface InboxDeps<E extends InboxEnv = InboxEnv> {
  /** Build the mailbox for one run. Return undefined when none is configured. */
  inbox?: (env: E) => InboxProvider | undefined;
  /** The operator channel for unsubscribe notices and billing alerts. */
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<InboxJobOptions>;
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

function checkWhole(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`inbox option ${name} must be a whole number from 1 to ${max}`);
}

/** Intake dependencies for one run, from a job context. */
export function intakeDepsFromEnv<E extends InboxEnv>(ctx: Pick<JobContext<E>, "env" | "config" | "now" | "log">, provider: string, operator: OperatorChannel | undefined): InboxIntakeDeps {
  return {
    db: ctx.env.DB,
    bucket: ctx.env.BUCKET ?? null,
    kv: ctx.env.KV ?? null,
    config: ctx.config,
    provider,
    operator,
    now: ctx.now,
    log: ctx.log,
  };
}

export function createInboxJobs<E extends InboxEnv>(deps: InboxDeps<E>): RegisteredJob<E>[] {
  const options: InboxJobOptions = { ...DEFAULT_INBOX_JOB_OPTIONS, ...(deps.options ?? {}) };
  checkWhole("pollLimit", options.pollLimit, 100);
  checkWhole("pollPages", options.pollPages, 5);
  checkWhole("pendingLimit", options.pendingLimit, 100);
  checkWhole("sweepLimit", options.sweepLimit, 100);
  checkWhole("repairLimit", options.repairLimit, 50);

  const poll = defineJob<E>({
    name: INBOX_POLL_JOB,
    schedule: options.pollSchedule,
    flag: INBOX_FLAGS.enabled,
    ceilings: { maxDurationMs: 50_000, maxRows: options.pollLimit * options.pollPages + options.pendingLimit },
    rerunnable: true,
    async run(ctx) {
      if (!(await inboxEnabled(ctx.flags))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const inbox = tryBuild(deps.inbox, ctx.env);
      if (!inbox) {
        const pending = await processPendingInbound(intakeDepsFromEnv(ctx, "none", operator), { limit: options.pendingLimit });
        return { summary: `no mailbox to poll; pending ${pending.processed}/${pending.attempted}`, rows: pending.attempted };
      }
      const result = await pollInbox({
        ...intakeDepsFromEnv(ctx, inbox.name, operator),
        inbox,
        limit: Math.min(options.pollLimit, ctx.ceilings.maxRows ?? options.pollLimit),
        maxPages: options.pollPages,
        pendingLimit: options.pendingLimit,
      });
      const i = result.intake;
      const listed = result.pages > 0 && !result.unsupported && i.failed === 0;
      return {
        summary: `${listed ? `${POLL_LISTED_MARK} ` : ""}${result.unsupported ? "listing unsupported; " : ""}pages ${result.pages}, recorded ${i.recorded}, duplicates ${i.duplicates}, from us ${i.fromUs}, failed ${i.failed}, pending ${i.pending + result.pending.pending}${result.reset ? ", cursor reset" : ""}`,
        rows: i.received + result.pending.attempted,
      };
    },
  });

  const sweep = defineJob<E>({
    name: INBOX_SWEEP_JOB,
    schedule: options.sweepSchedule,
    flag: INBOX_FLAGS.enabled,
    ceilings: { maxDurationMs: 120_000, maxRows: options.sweepLimit + options.repairLimit },
    critical: true,
    rerunnable: true,
    async run(ctx) {
      if (!(await inboxEnabled(ctx.flags))) return { summary: "flag off" };
      const inbox = tryBuild(deps.inbox, ctx.env);
      if (!inbox) return { summary: "no mailbox to sweep" };
      const result = await sweepInbox({ ...intakeDepsFromEnv(ctx, inbox.name, tryBuild(deps.operator, ctx.env)), inbox, limit: options.sweepLimit, repairLimit: options.repairLimit });
      if (result.unsupported) return { summary: "listing unsupported" };
      return { summary: `recorded ${result.intake.recorded}, duplicates ${result.intake.duplicates}, failed ${result.intake.failed}, bodies repaired ${result.repaired}`, rows: result.intake.received + result.repaired };
    },
  });

  const watch = defineJob<E>({
    name: INBOX_WATCH_JOB,
    schedule: options.watchSchedule,
    flag: INBOX_FLAGS.enabled,
    ceilings: { maxDurationMs: 30_000, maxRows: 1 },
    critical: true,
    rerunnable: true,
    async run(ctx) {
      if (!(await inboxEnabled(ctx.flags))) return { summary: "flag off" };
      const inbox = tryBuild(deps.inbox, ctx.env);
      if (!inbox?.watch) return { summary: "push not configured" };
      const { expiresAt } = await inbox.watch();
      return { summary: `push watch renewed until ${expiresAt}`, rows: 1 };
    },
  });

  return [poll, sweep, watch];
}
