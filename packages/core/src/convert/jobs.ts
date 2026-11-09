// GTM-agents: the convert jobs a deployment registers.
//
//   createConvertJobs({ calendar: (env) => provider, operator: (env) => channel })
//
// returns three job definitions for the job registry, none of which calls a model:
//   - calendar_sync      every 15 minutes, flag convert:calendar_enabled (default off): calendar sync
//                        (sync.ts). Ceilings: 2 minutes, 500 events. Safe to rerun: every effect is
//                        claimed, so a rerun repeats nothing;
//   - meeting_followups  every 15 minutes at :05, :20, :35 and :50, flag convert:calendar_enabled:
//                        reminders, the held or no-show question, recap drafts and, with
//                        convert:post_demo_enabled, the post-demo drafts (followups.ts). Ceilings:
//                        1 minute, 200 meetings;
//   - deal_handoffs      hourly at :10, flag convert:handoff_enabled (default off): the deal handoff
//                        brief at proposal and negotiation (handoff.ts). Ceilings: 30 seconds, 20 deals.
// Every dependency is built per run from the environment, so secrets are read when the job runs. The
// job runner checks the halt and the flag before a run; each job re-reads its flag as well, so
// calling run() directly with the flag off does nothing.
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import { readOn } from "../outreach/flags.ts";
import type { CalendarProvider } from "../ports/business.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import { CONVERT_FLAGS } from "./flags.ts";
import { runMeetingFollowups } from "./followups.ts";
import { runDealHandoffs } from "./handoff.ts";
import { runCalendarSync } from "./sync.ts";

export const CALENDAR_SYNC_JOB = "calendar_sync";
export const MEETING_FOLLOWUPS_JOB = "meeting_followups";
export const DEAL_HANDOFF_JOB = "deal_handoffs";

/** The bindings the convert jobs read. A deployment's Env satisfies it. */
export interface ConvertEnv {
  DB: D1Database;
  /** Where approval requests record what was shown. Without it, drafts are saved without a request. */
  KV?: ShownStore;
}

export interface ConvertJobOptions {
  syncSchedule: string;
  followupSchedule: string;
  handoffSchedule: string;
  /** Events one sync handles, at most. */
  syncMaxRows: number;
  /** Meetings one follow-up run handles, at most. */
  followupMaxRows: number;
  /** Deals one handoff run handles, at most. */
  handoffMaxRows: number;
  /** The chat notices and approvals go to. Defaults to the first allowed chat in gtm.config.ts. */
  chatId?: string;
}

export const DEFAULT_CONVERT_JOB_OPTIONS: Readonly<ConvertJobOptions> = Object.freeze({
  syncSchedule: "*/15 * * * *",
  followupSchedule: "5,20,35,50 * * * *",
  handoffSchedule: "10 * * * *",
  syncMaxRows: 500,
  followupMaxRows: 200,
  handoffMaxRows: 20,
});

export interface ConvertDeps<E extends ConvertEnv = ConvertEnv> {
  /** The calendar bookings are read from. Without it, calendar sync does nothing. */
  calendar: (env: E) => CalendarProvider | undefined;
  /** Where notices, reminders, briefs and approval requests go. */
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<ConvertJobOptions>;
}

const quietly = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

function whole(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`convert option ${name} must be a whole number from 1 to ${max}`);
}

export function createConvertJobs<E extends ConvertEnv>(deps: ConvertDeps<E>): RegisteredJob<E>[] {
  const options: ConvertJobOptions = { ...DEFAULT_CONVERT_JOB_OPTIONS, ...(deps.options ?? {}) };
  whole("syncMaxRows", options.syncMaxRows, 2500);
  whole("followupMaxRows", options.followupMaxRows, 1000);
  whole("handoffMaxRows", options.handoffMaxRows, 100);
  const chatOf = (ctx: JobContext<E>) => options.chatId ?? ctx.config.operator.allowedChatIds[0];

  const sync = defineJob<E>({
    name: CALENDAR_SYNC_JOB,
    schedule: options.syncSchedule,
    flag: CONVERT_FLAGS.calendar,
    ceilings: { maxDurationMs: 120_000, maxRows: options.syncMaxRows },
    critical: true,
    rerunnable: true,
    async run(ctx) {
      if (!(await readOn(ctx.flags, CONVERT_FLAGS.calendar))) return { summary: "flag off" };
      const calendar = quietly(deps.calendar, ctx.env);
      if (!calendar) return { summary: "no calendar configured" };
      const result = await runCalendarSync({
        db: ctx.env.DB,
        calendar,
        config: ctx.config,
        operator: quietly(deps.operator, ctx.env),
        shown: ctx.env.KV,
        chatId: chatOf(ctx),
        now: ctx.now,
        log: ctx.log,
        maxRows: Math.min(options.syncMaxRows, ctx.ceilings.maxRows ?? options.syncMaxRows),
      });
      return {
        summary: `listed ${result.listed}, handled ${result.handled}: booked ${result.booked}, ambiguous ${result.ambiguous}, unmatched ${result.unmatched}, moved ${result.moved}, cancelled ${result.cancelled}, failed ${result.failed}${result.truncated ? " (more than one run handles)" : ""}`,
        rows: result.handled,
      };
    },
  });

  const followups = defineJob<E>({
    name: MEETING_FOLLOWUPS_JOB,
    schedule: options.followupSchedule,
    flag: CONVERT_FLAGS.calendar,
    ceilings: { maxDurationMs: 60_000, maxRows: options.followupMaxRows },
    rerunnable: true,
    async run(ctx) {
      if (!(await readOn(ctx.flags, CONVERT_FLAGS.calendar))) return { summary: "flag off" };
      const result = await runMeetingFollowups({
        db: ctx.env.DB,
        config: ctx.config,
        flags: ctx.flags,
        operator: quietly(deps.operator, ctx.env),
        shown: ctx.env.KV,
        chatId: chatOf(ctx),
        now: ctx.now,
        log: ctx.log,
        maxRows: Math.min(options.followupMaxRows, ctx.ceilings.maxRows ?? options.followupMaxRows),
      });
      return {
        summary: `${result.meetings} meetings: reminders ${result.reminders}, asked ${result.asked}, recaps ${result.recaps}, follow-ups ${result.steps}, stopped ${result.stopped}, failed ${result.failed}`,
        rows: result.meetings,
      };
    },
  });

  const handoffs = defineJob<E>({
    name: DEAL_HANDOFF_JOB,
    schedule: options.handoffSchedule,
    flag: CONVERT_FLAGS.handoff,
    ceilings: { maxDurationMs: 30_000, maxRows: options.handoffMaxRows },
    rerunnable: true,
    async run(ctx) {
      if (!(await readOn(ctx.flags, CONVERT_FLAGS.handoff))) return { summary: "flag off" };
      const result = await runDealHandoffs({
        db: ctx.env.DB,
        operator: quietly(deps.operator, ctx.env),
        chatId: chatOf(ctx),
        now: ctx.now,
        log: ctx.log,
        maxRows: Math.min(options.handoffMaxRows, ctx.ceilings.maxRows ?? options.handoffMaxRows),
      });
      return { summary: `${result.due} due, ${result.written} written, ${result.failed} failed`, rows: result.due };
    },
  });

  return [sync, followups, handoffs];
}
