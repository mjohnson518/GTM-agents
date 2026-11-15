// GTM-agents: operator timers on the operator side: the operator_timers job that queues due timers,
// and the /timers command. The timers themselves live in agents/timers.ts, the timer_set tool in
// tools/timer-set.ts, and the turn a timer starts runs in the chat consumer (chat.ts).
//
// The job runs every minute behind operator:timers_enabled and never calls a model. Each run:
//   1. expires timers more than six hours late, and queued ones whose message never arrived, and
//      tells each chat that still may use the agent which of its timers expired (one notice per
//      chat, through the operator channel; bookkeeping, so a notice that fails is logged and the
//      run goes on). The chat consumer tells the chat the same way when it expires a timer itself;
//   2. stops there while the operator agent is off, so nothing fires into a disabled agent;
//   3. reads the daily cap (operator:timers_daily_max). It is a bound, so a value that cannot be read
//      is 0 and nothing fires;
//   4. moves each due timer pending -> queued with a compare-and-set, then sends one message to the
//      chat queue carrying only its id. A send that fails moves the timer back to pending, so the
//      next run tries again; the consumer claims each timer once, so a send that did arrive cannot
//      start a second turn.
// Timers go through the same chat queue as operator messages, so with the template's
// max_concurrency of 1 a timer's turn never runs alongside another chat turn. The order a /clean and
// a timer's message arrive in does not matter: the timer's turn checks the session was not cleared
// since the timer was set.
import { TIMER_PENDING_MAX, cancelSessionTimers, cancelTimer, dueTimers, expireLateTimers, listOpenTimers, minuteUtc, timerEffectKey, timersQueuedOn, transitionTimer } from "../agents/timers.ts";
import type { Timer } from "../agents/timers.ts";
import type { ChatMessage, Env } from "../env.ts";
import type { FlagReader, JobContext, JobDefinition, JobResult } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { readCap } from "../sending/flags.ts";
import { TIMERS_FLAG, isAgentEnabled, isAllowedOperator, isTimersEnabled } from "./access.ts";

export const TIMERS_JOB = "operator_timers";
export const TIMERS_SCHEDULE = "* * * * *";
export const TIMERS_DAILY_MAX_FLAG = "operator:timers_daily_max";
export const TIMERS_DAILY_MAX = { default: 20, max: 200 } as const;
/** Timers one run queues at most. */
export const TIMERS_PER_RUN = 10;

export interface OperatorTimerJobOptions<E extends Env = Env> {
  /** Defaults to every minute. */
  schedule?: string;
  /** Timers one run queues at most. Defaults to TIMERS_PER_RUN. */
  maxPerRun?: number;
  /** The operator channel expired timers are reported through. Without it, they expire unannounced. */
  operator?: (env: E) => OperatorChannel | undefined;
}

/** The most timers one expiry notice names; the rest are counted. */
export const EXPIRED_LISTED_MAX = 10;

const EXPIRY_REASONS: Record<string, string> = {
  late: "more than 6 hours past due when timers could next fire (the agent or timers were off, or the Worker was not running)",
  "not delivered": "its message never reached the chat",
  "no model gateway": "no model gateway is configured",
};

/**
 * What the operator reads about timers that expired without running, all from one chat. The note's
 * first line is shown as /timers shows it: to the operator only, never to the model.
 */
export function expiryNotice(timers: readonly Pick<Timer, "id" | "dueAt" | "reason" | "note">[]): string {
  const line = (t: (typeof timers)[number]) => `- ${t.id}, due ${minuteUtc(t.dueAt)}: ${EXPIRY_REASONS[t.reason ?? ""] ?? "it could no longer fire"}. Note: ${firstLine(t.note)}`;
  const shown = timers.slice(0, EXPIRED_LISTED_MAX);
  const more = timers.length - shown.length;
  return [
    timers.length === 1 ? "A timer expired without running:" : `${timers.length} timers expired without running:`,
    ...shown.map(line),
    ...(more > 0 ? [`- and ${more} more; /timers lists only those still waiting.`] : []),
    "Nothing was run for them. Ask again for any that still matter.",
  ].join("\n");
}

/**
 * Tell each chat which of its timers expired. Bookkeeping: never throws; a chat no longer allowed
 * is not told, and a notice that cannot be sent is logged.
 */
export async function announceExpiredTimers<E extends Env>(ctx: Pick<JobContext<E>, "env" | "config" | "log">, operator: OperatorChannel | undefined, timers: readonly Timer[]): Promise<number> {
  if (!operator || timers.length === 0) return 0;
  const byChat = new Map<string, Timer[]>();
  for (const t of timers) {
    if (!isAllowedOperator(ctx.config.operator, t.chatId, t.userId)) continue;
    byChat.set(t.chatId, [...(byChat.get(t.chatId) ?? []), t]);
  }
  let told = 0;
  for (const [chatId, list] of byChat) {
    try {
      await operator.notify({ text: expiryNotice(list), chatId, kind: "notice" });
      told += 1;
    } catch (error) {
      ctx.log.warn("the notice about expired timers could not be sent", { chatId, count: list.length, error: sanitizeErrorMessage(error) });
    }
  }
  return told;
}

/** The message that starts a timer's turn. The consumer reads everything else from the timer's row. */
export function timerQueueMessage(timer: { id: string; chatId: string; userId: string; sessionKey: string }): ChatMessage {
  return { updateId: timerEffectKey(timer.id), chatId: timer.chatId, userId: timer.userId, sessionKey: timer.sessionKey, text: timerEffectKey(timer.id), timerId: timer.id };
}

/** One run of the operator_timers job. Throws on a database error, so the run is recorded as failed. */
export async function queueDueTimers<E extends Env>(ctx: JobContext<E>, operator?: (env: E) => OperatorChannel | undefined): Promise<JobResult> {
  const db = ctx.env.DB;
  const now = ctx.now;
  const expiredTimers = await expireLateTimers(db, now);
  const expired = expiredTimers.length;
  if (expired > 0) {
    let channel: OperatorChannel | undefined;
    try {
      channel = operator?.(ctx.env);
    } catch {
      channel = undefined;
    }
    await announceExpiredTimers(ctx, channel, expiredTimers);
  }
  if (!(await isAgentEnabled(ctx.flags))) return { summary: `operator agent off; expired=${expired}`, rows: 0 };
  const cap = await readCap(ctx.flags, TIMERS_DAILY_MAX_FLAG, TIMERS_DAILY_MAX);
  const used = await timersQueuedOn(db, now);
  const room = Math.max(0, Math.min(ctx.ceilings.maxRows ?? TIMERS_PER_RUN, cap - used));
  if (room === 0) return { summary: `daily cap reached (${used} of ${cap}); expired=${expired}`, rows: 0 };
  let queued = 0;
  for (const timer of await dueTimers(db, now, room)) {
    if (ctx.signal.aborted) break;
    if (!(await transitionTimer(db, timer.id, ["pending"], "queued", { queuedAt: now.toISOString() }, now))) continue;
    try {
      await ctx.env.CHAT_QUEUE.send(timerQueueMessage(timer));
      queued += 1;
    } catch (error) {
      ctx.log.warn("a due timer could not be queued; the next run tries again", { timer: timer.id, error: sanitizeErrorMessage(error) });
      try {
        await transitionTimer(db, timer.id, ["queued"], "pending", { queuedAt: null }, now);
      } catch {
        // Left queued, it expires as not delivered; it can never fire twice either way.
      }
    }
  }
  return { summary: `queued=${queued} expired=${expired}`, rows: queued };
}

/**
 * The operator_timers job. Add it to the Worker's jobs: without it the agent never offers timer_set.
 * It runs only while operator:timers_enabled is on. Pass `operator` so timers that expire are reported.
 */
export function createOperatorTimerJobs<E extends Env = Env>(options: OperatorTimerJobOptions<E> = {}): Array<JobDefinition<E>> {
  return [
    {
      name: TIMERS_JOB,
      schedule: options.schedule ?? TIMERS_SCHEDULE,
      flag: TIMERS_FLAG,
      ceilings: { maxDurationMs: 30_000, maxRows: Math.max(1, Math.floor(options.maxPerRun ?? TIMERS_PER_RUN)) },
      rerunnable: true,
      run: (ctx) => queueDueTimers(ctx, options.operator),
    },
  ];
}

export const TIMERS_HELP_LINE = "/timers  timers the agent set in this chat; /timers cancel <id> or /timers cancel all";

function firstLine(text: string, max = 80): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * /timers, /timers cancel <id> and /timers cancel all, for this chat's session. Listing and
 * cancelling work whatever the flag says, so the operator can always see and stop what is waiting.
 * Throws on a database error; the caller reports it.
 */
export async function runTimersCommand(deps: { db: D1Database; flags?: FlagReader; now: Date }, args: string, session: { sessionKey: string }): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const open = await listOpenTimers(deps.db, session.sessionKey);
    const on = deps.flags ? await isTimersEnabled(deps.flags) : true;
    const state = on ? [] : ["Timers are off for this deployment (operator:timers_enabled), so nothing below fires until they are on."];
    if (open.length === 0) return [...state, "No timers are waiting in this chat."].join("\n");
    return [
      ...state,
      `Timers waiting in this chat (${open.length} of ${TIMER_PENDING_MAX}):`,
      ...open.map((t) => `${t.id}  due ${minuteUtc(t.dueAt)}${t.status === "queued" ? " (firing now)" : ""}${t.taint === "none" ? "" : `, carries ${t.taint} taint`}: ${firstLine(t.note)}`),
      "Cancel one with /timers cancel <id>, or all with /timers cancel all.",
    ].join("\n");
  }
  if (words[0]?.toLowerCase() === "cancel" && words.length === 2) {
    const target = words[1] ?? "";
    if (target.toLowerCase() === "all") {
      const n = await cancelSessionTimers(deps.db, session.sessionKey, "cancelled by the operator", deps.now);
      return n === 0 ? "No timers were waiting in this chat." : `Cancelled ${n} timer${n === 1 ? "" : "s"}.`;
    }
    return (await cancelTimer(deps.db, session.sessionKey, target, "cancelled by the operator", deps.now))
      ? `Cancelled timer ${target}.`
      : `No waiting timer ${target.slice(0, 40)} in this chat. Send /timers for the list.`;
  }
  return "Send /timers for this chat's timers, /timers cancel <id> to cancel one, or /timers cancel all.";
}
