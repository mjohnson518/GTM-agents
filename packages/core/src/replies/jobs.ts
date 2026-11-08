// GTM-agents: the reply jobs a deployment registers.
//
//   createReplyJobs({ model: (env) => gateway, inbox: (env) => mailbox, operator: (env) => channel })
//
// returns four job definitions for the job registry, each behind a flag that defaults off:
//   - replies_triage     every 15 minutes, replies:triage_enabled: triage, routing, the qualifier,
//                        and drafting while replies:drafting_enabled is on. Calls models (triage
//                        and writer), so a schedule more often than every 15 minutes is refused.
//                        Ceilings: 10 messages, a daily model spend cap, 5 minutes.
//   - replies_mirror     every 15 minutes, replies:mirror_enabled: mailbox drafts and their
//                        reconciliation. 20 rows, 2 minutes.
//   - replies_send       every 5 minutes, replies:send_enabled: approved replies go out from the
//                        mailbox. 10 drafts, 2 minutes.
//   - replies_reminders  every 5 minutes, replies:reminders_enabled: the reply-owed clock and quiet
//                        threads. 50 rows, 1 minute.
// The job runner checks the halt, the flag and the budget first; each job re-reads its own flag, so
// calling run() directly with the flag off does nothing. Adapters are built per run from the
// environment, so secrets are read when a job runs.
import type { KVReader } from "../brain/load.ts";
import { parseCron } from "../jobs/cron.ts";
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import type { KvStore } from "../shared/kv.ts";
import { REPLY_FLAGS, replyFlagOn } from "./flags.ts";
import { runMirror } from "./mirror.ts";
import { runOutbox } from "./outbox.ts";
import { runReplyClock } from "./owed.ts";
import { runReplyPipeline } from "./pipeline.ts";

export const REPLY_TRIAGE_JOB = "replies_triage";
export const REPLY_MIRROR_JOB = "replies_mirror";
export const REPLY_SEND_JOB = "replies_send";
export const REPLY_REMINDERS_JOB = "replies_reminders";

/** The bindings the reply jobs read. A deployment's Env satisfies it. */
export interface ReplyEnv {
  DB: D1Database;
  KV?: KVReader & ShownStore & KvStore;
  BUCKET?: Pick<R2Bucket, "get">;
  UNSUBSCRIBE_SIGNING_KEY?: string;
  AGENT_BASE_URL?: string;
}

export interface ReplyJobOptions {
  triageSchedule: string;
  mirrorSchedule: string;
  sendSchedule: string;
  remindersSchedule: string;
  /** Messages triaged or drafted per run. */
  triageMaxRows: number;
  /** Daily model spend cap for triage and drafting, in cents. */
  maxSpendCents: number;
  /** The chat approval requests, reminders and notices go to. Defaults to the first allowlisted chat. */
  chatId?: string;
  /** The UTC hour the daily morning reminder goes out from. */
  morningHourUtc: number;
  /** How long an owed reply is chased, in days. */
  owedWindowDays: number;
}

export const DEFAULT_REPLY_JOB_OPTIONS: Readonly<ReplyJobOptions> = Object.freeze({
  triageSchedule: "*/15 * * * *",
  mirrorSchedule: "*/15 * * * *",
  sendSchedule: "*/5 * * * *",
  remindersSchedule: "*/5 * * * *",
  triageMaxRows: 10,
  maxSpendCents: 100,
  morningHourUtc: 13,
  owedWindowDays: 14,
});

export interface ReplyDeps<E extends ReplyEnv = ReplyEnv> {
  /** The model gateway (triage and writer roles). Without it nothing is triaged or drafted. */
  model?: (env: E) => ModelGateway | undefined;
  /** The warm mailbox: thread reads, drafts and sends. Without it nothing is mirrored or sent. */
  inbox?: (env: E) => InboxProvider | undefined;
  /** Where approval requests, reminders and notices go. */
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<ReplyJobOptions>;
}

/** Refuse a model-calling schedule that fires more often than every 15 minutes. */
export function assertModelSchedule(schedule: string, job: string): void {
  const minutes = [...parseCron(schedule).minutes].sort((a, b) => a - b);
  const tooClose = minutes.length > 1 && minutes.some((m, i) => (i === 0 ? m + 60 - (minutes.at(-1) ?? m) : m - (minutes[i - 1] ?? m)) < 15);
  if (minutes.length > 4 || tooClose) throw new Error(`job ${job}: model calls never run in a per-minute job; schedule it at most every 15 minutes`);
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

export function createReplyJobs<E extends ReplyEnv>(deps: ReplyDeps<E>): RegisteredJob<E>[] {
  const options: ReplyJobOptions = { ...DEFAULT_REPLY_JOB_OPTIONS, ...(deps.options ?? {}) };
  assertModelSchedule(options.triageSchedule, REPLY_TRIAGE_JOB);
  if (!Number.isInteger(options.morningHourUtc) || options.morningHourUtc < 0 || options.morningHourUtc > 23) throw new Error("reply option morningHourUtc must be a whole hour from 0 to 23");
  const chatOf = (ctx: JobContext<E>) => options.chatId ?? ctx.config.operator.allowedChatIds[0];

  const triage = defineJob<E>({
    name: REPLY_TRIAGE_JOB,
    schedule: options.triageSchedule,
    flag: REPLY_FLAGS.triage,
    ceilings: { maxDurationMs: 300_000, maxRows: options.triageMaxRows, maxSpendCents: options.maxSpendCents },
    rerunnable: true,
    async run(ctx) {
      if (!(await replyFlagOn(ctx.flags, REPLY_FLAGS.triage))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const model = tryBuild(deps.model, ctx.env);
      const inbox = tryBuild(deps.inbox, ctx.env);
      const chat = chatOf(ctx);
      const result = await runReplyPipeline({
        db: ctx.env.DB,
        kv: ctx.env.KV,
        bucket: ctx.env.BUCKET,
        flags: ctx.flags,
        config: ctx.config,
        ...(model ? { model } : {}),
        ...(inbox ? { inbox } : {}),
        ...(operator ? { operator } : {}),
        ...(chat ? { approvalChatId: chat } : {}),
        job: ctx.job,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        signal: ctx.signal,
        now: ctx.now,
        log: ctx.log,
        maxRows: Math.min(options.triageMaxRows, ctx.ceilings.maxRows ?? options.triageMaxRows),
        maxSpendCents: options.maxSpendCents,
      });
      return {
        summary: `rerouted ${result.rerouted}, triaged ${result.triaged} (${result.triageFailed} left for retry), drafted ${result.drafted}, blocked ${result.blocked}, draft failures ${result.draftFailed}${result.stopped ? `; stopped: ${result.stopped}` : ""}`,
        rows: result.triaged + result.drafted,
      };
    },
  });

  const mirror = defineJob<E>({
    name: REPLY_MIRROR_JOB,
    schedule: options.mirrorSchedule,
    flag: REPLY_FLAGS.mirror,
    ceilings: { maxDurationMs: 120_000, maxRows: 20 },
    rerunnable: true,
    async run(ctx) {
      if (!(await replyFlagOn(ctx.flags, REPLY_FLAGS.mirror))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const chat = chatOf(ctx);
      const result = await runMirror({
        db: ctx.env.DB,
        inbox: tryBuild(deps.inbox, ctx.env),
        ...(operator ? { operator } : {}),
        ...(chat ? { chatId: chat } : {}),
        now: ctx.now,
        log: ctx.log,
        maxRows: ctx.ceilings.maxRows ?? 20,
      });
      if (result.skipped) return { summary: `skipped: ${result.skipped}` };
      return { summary: `created ${result.created}, failed ${result.failed}, sent from the mailbox ${result.sent}, gone and still owed ${result.waiting}, closed ${result.discarded}`, rows: result.created + result.sent + result.discarded };
    },
  });

  const send = defineJob<E>({
    name: REPLY_SEND_JOB,
    schedule: options.sendSchedule,
    flag: REPLY_FLAGS.send,
    ceilings: { maxDurationMs: 120_000, maxRows: 10 },
    async run(ctx) {
      if (!(await replyFlagOn(ctx.flags, REPLY_FLAGS.send))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const chat = chatOf(ctx);
      const kv = ctx.env.KV;
      const result = await runOutbox({
        db: ctx.env.DB,
        kv,
        shown: kv ?? { get: () => Promise.resolve(null), put: () => Promise.reject(new Error("the KV binding is missing")) },
        flags: ctx.flags,
        config: ctx.config,
        inbox: tryBuild(deps.inbox, ctx.env),
        unsubscribeSigningKey: ctx.env.UNSUBSCRIBE_SIGNING_KEY,
        baseUrl: ctx.env.AGENT_BASE_URL,
        ...(operator ? { operator } : {}),
        ...(chat ? { chatId: chat } : {}),
        now: () => ctx.now,
        log: ctx.log,
        maxRows: ctx.ceilings.maxRows ?? 10,
      });
      return { summary: `sent ${result.sent}, refused ${result.refused}, held ${result.held}, failed ${result.failed}, rejections recorded ${result.rejectedRecorded}`, rows: result.sent + result.refused + result.failed };
    },
  });

  const reminders = defineJob<E>({
    name: REPLY_REMINDERS_JOB,
    schedule: options.remindersSchedule,
    flag: REPLY_FLAGS.reminders,
    ceilings: { maxDurationMs: 60_000, maxRows: 50 },
    rerunnable: true,
    async run(ctx) {
      if (!(await replyFlagOn(ctx.flags, REPLY_FLAGS.reminders))) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const chat = chatOf(ctx);
      const result = await runReplyClock({
        db: ctx.env.DB,
        operator,
        ...(chat ? { chatId: chat } : {}),
        now: ctx.now,
        log: ctx.log,
        morningHourUtc: options.morningHourUtc,
        windowDays: options.owedWindowDays,
        maxRows: ctx.ceilings.maxRows ?? 50,
      });
      return { summary: `owed ${result.owed}, reminded ${result.reminded}, quiet threads ${result.quiet}`, rows: result.owed };
    },
  });

  return [triage, mirror, send, reminders];
}
