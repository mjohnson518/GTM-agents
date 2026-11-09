// GTM-agents: the scheduled report jobs a deployment registers.
//
//   createReportJobs({ operator: (env) => channel })
//
// returns three job definitions for the job registry, each behind a flag that defaults off. None
// calls a model, writes anything but its own once-per-period claim, or touches a send path:
//   - daily_scorecard  12:00 UTC, Monday to Friday, ops:daily_scorecard: the scorecard, once a day;
//   - funnel_digest    09:00 UTC on Mondays, ops:funnel_digest: the weekly funnel digest, once a week;
//   - cost_digest      14:00 UTC, Monday to Friday, ops:cost_digest: spend per job, once a day, and
//                      only while the scorecard is off (it carries spend).
// Ceilings: one operator message per run, and a minute (the cost digest, 30 seconds). Each job
// re-reads its own flag, so calling run() directly with the flag off does nothing. A report whose
// message could not be sent is tried again on the next run the same day (rerunnable).
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { loadCostDigest, renderCostDigest } from "./cost.ts";
import { deliverOnce } from "./deliver.ts";
import { REPORT_FLAGS, reportFlagOn } from "./flags.ts";
import { loadFunnelDigest, renderFunnelDigest } from "./funnel.ts";
import { loadScorecard, renderScorecard } from "./scorecard.ts";

export const SCORECARD_JOB = "daily_scorecard";
export const FUNNEL_DIGEST_JOB = "funnel_digest";
export const COST_DIGEST_JOB = "cost_digest";

/** The bindings the report jobs read. A deployment's Env satisfies it. */
export interface ReportEnv {
  DB: D1Database;
}

export interface ReportJobOptions {
  scorecardSchedule: string;
  funnelSchedule: string;
  costSchedule: string;
  /** The chat reports go to. Defaults to the first allowlisted chat. */
  chatId?: string;
}

export const DEFAULT_REPORT_JOB_OPTIONS: Readonly<ReportJobOptions> = Object.freeze({
  scorecardSchedule: "0 12 * * MON-FRI",
  funnelSchedule: "0 9 * * MON",
  costSchedule: "0 14 * * MON-FRI",
});

export interface ReportDeps<E extends ReportEnv = ReportEnv> {
  /** Where reports go. Without it, every report job skips. */
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<ReportJobOptions>;
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

const day = (now: Date) => now.toISOString().slice(0, 10);

export function createReportJobs<E extends ReportEnv>(deps: ReportDeps<E>): RegisteredJob<E>[] {
  const options: ReportJobOptions = { ...DEFAULT_REPORT_JOB_OPTIONS, ...(deps.options ?? {}) };
  const send = async (ctx: JobContext<E>, key: string, text: () => Promise<string>) => {
    const operator = tryBuild(deps.operator, ctx.env);
    if (!operator) return { summary: "skipped: no operator channel" };
    const chatId = options.chatId ?? ctx.config.operator.allowedChatIds[0];
    const status = await deliverOnce({ db: ctx.env.DB, operator, ...(chatId ? { chatId } : {}), log: ctx.log }, key, await text());
    return { summary: status, rows: status === "sent" ? 1 : 0 };
  };

  const scorecard = defineJob<E>({
    name: SCORECARD_JOB,
    schedule: options.scorecardSchedule,
    flag: REPORT_FLAGS.scorecard,
    ceilings: { maxDurationMs: 60_000, maxRows: 1 },
    rerunnable: true,
    async run(ctx) {
      if (!(await reportFlagOn(ctx.flags, REPORT_FLAGS.scorecard))) return { summary: "flag off" };
      return send(ctx, `report:scorecard:${day(ctx.now)}`, async () => renderScorecard(await loadScorecard(ctx.env.DB, ctx.flags, ctx.now)));
    },
  });

  const funnel = defineJob<E>({
    name: FUNNEL_DIGEST_JOB,
    schedule: options.funnelSchedule,
    flag: REPORT_FLAGS.funnel,
    ceilings: { maxDurationMs: 60_000, maxRows: 1 },
    rerunnable: true,
    async run(ctx) {
      if (!(await reportFlagOn(ctx.flags, REPORT_FLAGS.funnel))) return { summary: "flag off" };
      return send(ctx, `report:funnel:${day(ctx.now)}`, async () => renderFunnelDigest(await loadFunnelDigest(ctx.env.DB, ctx.now)));
    },
  });

  const cost = defineJob<E>({
    name: COST_DIGEST_JOB,
    schedule: options.costSchedule,
    flag: REPORT_FLAGS.cost,
    ceilings: { maxDurationMs: 30_000, maxRows: 1 },
    rerunnable: true,
    async run(ctx) {
      if (!(await reportFlagOn(ctx.flags, REPORT_FLAGS.cost))) return { summary: "flag off" };
      if (await reportFlagOn(ctx.flags, REPORT_FLAGS.scorecard)) return { summary: "skipped: the daily scorecard carries spend" };
      return send(ctx, `report:cost:${day(ctx.now)}`, async () => renderCostDigest(await loadCostDigest(ctx.env.DB, ctx.now)));
    },
  });

  return [scorecard, funnel, cost];
}
