// GTM-agents: the operator outbox: quiet hours, an hourly limit and retries for the notices the
// system sends the operator (docs/OPERATOR.md#quiet-hours-and-the-outbox).
//
// withOperatorOutbox wraps the deployment's operator channel once, where the Worker builds it, so
// every job and module that notifies the operator goes through it unchanged. While
// operator:outbox_enabled is on, notify() treats a message by its kind (ports/operator.ts):
//   - reply, an answer to something the operator just sent: straight to the channel, always;
//   - page, a failing job or an alert: straight to the channel, silently during quiet hours;
//   - notice, the default: held during operator.quietHours until they end, and held once
//     operator:outbox_hourly_max notices went to its chat this UTC hour, until the next hour.
//     Otherwise it goes at once and is counted. A message with buttons is never held.
// A page or notice the channel refuses with a retryable error (rate limited, unavailable) is kept and
// retried; any other error is thrown, as without the outbox. requestApproval goes straight to the
// channel, silently during quiet hours: an approval binds to what was shown, so it is never held.
// The other methods pass through. With the flag off, or unreadable, every call passes through.
//
// A held notice resolves notify() with the message id "outbox:<id>": accepted, delivered later.
// Nothing edits a notice by its id, so callers treat it as sent. The outbox never loses a notice to
// its own failures: when a row cannot be written, the message goes to the channel now.
//
// The operator_outbox job (every five minutes, no model call) delivers held notices that are due,
// folding each chat's notices into as few messages as fit, oldest first. It has no flag, so notices
// held while the outbox was on still go out after it is turned off: with the flag off it delivers
// everything held at once. During quiet hours it delivers only pages and notices the operator
// released with /outbox send; a flag that cannot be read keeps quiet hours rather than draining. A
// delivery the channel refuses is tried again with backoff; notices in it are dropped a day after
// they were written, pages after a week. Sent and dropped rows are deleted after two days. The table
// holds notice text only while it waits. Held notices are not ordered against ones delivered at
// once: a notice sent in the same minute a fold goes out can arrive before it. The hourly limit is
// counted per chat id as callers pass it, so the default chat (no id) and the same chat named by id
// have separate counts.
//
// A caller that binds an approval to what was shown must not count a held notice as shown:
// isHeldMessageId tells it apart (lifecycle/followups.ts, tellOperator).
import { minuteUtc } from "../agents/timers.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { Env } from "../env.ts";
import type { FlagReader, JobContext, JobDefinition, JobLogger, JobResult } from "../jobs/registry.ts";
import type { OperatorChannel, OperatorMessage } from "../ports/operator.ts";
import { AdapterError } from "../ports/types.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { isFlagOn } from "../jobs/loop.ts";
import { localParts, zonedTimeToUtc } from "../sending/window.ts";
import { OUTBOX_FLAG, isOutboxEnabled } from "./access.ts";

export type QuietHours = NonNullable<GtmConfig["operator"]["quietHours"]>;

export const OUTBOX_JOB = "operator_outbox";
export const OUTBOX_SCHEDULE = "*/5 * * * *";
export const OUTBOX_HOURLY_MAX_FLAG = "operator:outbox_hourly_max";
export const OUTBOX_HOURLY_MAX = { default: 12, max: 100 } as const;
/** Held notices one run delivers at most. */
export const OUTBOX_PER_RUN = 50;
/**
 * The most text folded into one message; a chat's other notices go in the next one. Under Telegram's
 * 4,096 characters, so a fold is one message and a retry never repeats part of one.
 */
export const OUTBOX_FOLD_MAX_CHARS = 3_800;
/** Notices the channel still refuses this long after they were written are dropped. */
export const OUTBOX_GIVE_UP_MS = 24 * 3_600_000;
/** Pages the channel still refuses this long after they were written are dropped. */
export const OUTBOX_PAGE_GIVE_UP_MS = 7 * 86_400_000;
/** A row left sending this long, by a run that stopped mid-delivery, is tried again. */
export const OUTBOX_STALE_SENDING_MS = 15 * 60_000;
/** Sent and dropped rows are kept this long. */
export const OUTBOX_KEEP_MS = 2 * 86_400_000;
const RETRY_MIN_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const HOUR_MS = 3_600_000;
const HELD_PREFIX = "outbox:";

type HeldReason = "quiet_hours" | "hourly_cap" | "channel_error" | "released";
type OutboxKind = "page" | "notice";

/**
 * When the quiet hours that `at` falls in end, or null when `at` is outside them. The window is in
 * whole local hours, start inclusive and end exclusive, and may cross midnight. Throws RangeError for
 * a time zone the runtime does not know (gtm.config.ts validates it at startup).
 */
export function quietHoursEnd(at: Date, quiet: QuietHours): Date | null {
  const p = localParts(at, quiet.timeZone);
  const inside = quiet.start < quiet.end ? p.hour >= quiet.start && p.hour < quiet.end : p.hour >= quiet.start || p.hour < quiet.end;
  if (!inside) return null;
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + (p.hour < quiet.end ? 0 : 1)));
  const end = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), quiet.end, quiet.timeZone);
  return end.getTime() > at.getTime() ? end : new Date(at.getTime() + HOUR_MS);
}

/** Quiet hours' end for `at`, or null when there are none, `at` is outside them or they cannot be computed. */
function quietEndAt(quiet: QuietHours | undefined, at: Date): Date | null {
  if (!quiet) return null;
  try {
    return quietHoursEnd(at, quiet);
  } catch {
    return null;
  }
}

const hourStart = (at: Date) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
const nextHour = (at: Date) => new Date(hourStart(at).getTime() + HOUR_MS);

/** When a delivery that failed for the `attempts`th time is tried next: 5, 10, 20, 40, then 60 minutes, or later when the channel asked. */
export function retryAt(now: Date, attempts: number, retryAfterMs?: number): Date {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + Math.max(backoff, Math.min(retryAfterMs ?? 0, RETRY_MAX_MS)));
}

/** True when notify() resolved with a notice the outbox is holding: accepted, not yet delivered. */
export function isHeldMessageId(messageId: string): boolean {
  return messageId.startsWith(HELD_PREFIX);
}

/**
 * The hourly limit. It only paces notices, so a value that cannot be read, or is not a whole number,
 * falls back to the default rather than holding everything.
 */
async function readHourlyMax(flags: FlagReader): Promise<number> {
  let raw: string | null;
  try {
    raw = await flags.get(OUTBOX_HOURLY_MAX_FLAG);
  } catch {
    return OUTBOX_HOURLY_MAX.default;
  }
  if (raw === null || raw.trim() === "") return OUTBOX_HOURLY_MAX.default;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? Math.min(n, OUTBOX_HOURLY_MAX.max) : OUTBOX_HOURLY_MAX.default;
}

/** The flag as the job reads it: an unreadable flag is not "off", so held notices keep waiting. */
async function outboxState(flags: FlagReader): Promise<"on" | "off" | "unknown"> {
  let raw: string | null;
  try {
    raw = await flags.get(OUTBOX_FLAG);
  } catch {
    return "unknown";
  }
  return isFlagOn(raw) ? "on" : "off";
}

export function newOutboxId(): string {
  return `ob_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

interface HeldInsert {
  id: string;
  chatId: string | undefined;
  kind: OutboxKind;
  text: string;
  silent: boolean;
  reason: HeldReason;
  releaseAt: Date;
  attempts: number;
  lastError: string | null;
}

async function insertHeld(db: D1Database, row: HeldInsert, now: Date): Promise<void> {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO operator_outbox (id, chat_id, kind, text, silent, status, reason, release_at, attempts, last_error, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'held', ?6, ?7, ?8, ?9, ?10, ?10)`,
    )
    .bind(row.id, row.chatId ?? null, row.kind, row.text, row.silent ? 1 : 0, row.reason, row.releaseAt.toISOString(), row.attempts, row.lastError, at)
    .run();
}

/** Count a notice delivered at once toward its chat's hourly limit. The row holds no text. */
async function recordSent(db: D1Database, chatId: string | undefined, now: Date): Promise<void> {
  const id = newOutboxId();
  const at = now.toISOString();
  await db
    .prepare("INSERT INTO operator_outbox (id, chat_id, kind, status, delivery_id, sent_at, created_at, updated_at) VALUES (?1, ?2, 'notice', 'sent', ?1, ?3, ?3, ?3)")
    .bind(id, chatId ?? null, at)
    .run();
}

/** Messages of notices delivered to this chat in the current UTC hour; several folded into one message count once. */
export async function noticesSentThisHour(db: D1Database, chatId: string | undefined, now: Date): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(DISTINCT delivery_id) AS n FROM operator_outbox WHERE status = 'sent' AND kind = 'notice' AND chat_id IS ?1 AND sent_at >= ?2")
    .bind(chatId ?? null, hourStart(now).toISOString())
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface OutboxDeps {
  db: D1Database;
  flags: FlagReader;
  /** operator.quietHours from gtm.config.ts. Without it nothing is held for quiet hours. */
  quietHours?: QuietHours | undefined;
  now?: () => Date;
  log?: Pick<JobLogger, "warn">;
}

const inner = new WeakMap<OperatorChannel, OperatorChannel>();

/** The channel an outbox wraps, or the channel itself when it is not wrapped. */
export function unwrapOutbox(channel: OperatorChannel): OperatorChannel {
  return inner.get(channel) ?? channel;
}

/** Wrap an operator channel in the outbox. Wrapping an already wrapped channel wraps the channel itself. */
export function withOperatorOutbox(channel: OperatorChannel, deps: OutboxDeps): OperatorChannel {
  const raw = unwrapOutbox(channel);
  const wrapped: OperatorChannel = {
    name: raw.name,
    notify: (message) => outboxNotify(raw, deps, message),
    requestApproval: async (req) => {
      const quiet = deps.quietHours && (await isOutboxEnabled(deps.flags)) ? quietEndAt(deps.quietHours, clockOf(deps)) : null;
      return raw.requestApproval(quiet ? { ...req, silent: true } : req);
    },
    editMessage: (messageId, message) => raw.editMessage(messageId, message),
    acknowledgeCallback: (callbackId, text) => raw.acknowledgeCallback(callbackId, text),
    parseUpdate: (request) => raw.parseUpdate(request),
    registerWebhook: (url) => raw.registerWebhook(url),
  };
  inner.set(wrapped, raw);
  return wrapped;
}

const clockOf = (deps: Pick<OutboxDeps, "now">) => deps.now?.() ?? new Date();

async function outboxNotify(channel: OperatorChannel, deps: OutboxDeps, message: OperatorMessage): Promise<{ messageId: string }> {
  if (message.kind === "reply" || !(await isOutboxEnabled(deps.flags))) return channel.notify(message);
  const now = clockOf(deps);
  const quietEnd = quietEndAt(deps.quietHours, now);
  if (message.kind === "page") return deliverNow(channel, deps, quietEnd ? { ...message, silent: true } : message, "page", now);
  // Buttons are not kept in the table, so a message that carries them is never held.
  if (message.buttons?.length) return deliverNow(channel, deps, message, "notice", now);
  if (quietEnd) return hold(channel, deps, message, "quiet_hours", quietEnd, now);
  const cap = await readHourlyMax(deps.flags);
  let used: number;
  try {
    used = await noticesSentThisHour(deps.db, message.chatId, now);
  } catch (error) {
    // The limit only paces notices: one that cannot be counted is delivered.
    deps.log?.warn("the outbox could not count this hour's notices; this one is delivered now", { error: sanitizeErrorMessage(error) });
    used = 0;
  }
  if (used >= cap) return hold(channel, deps, message, "hourly_cap", nextHour(now), now);
  return deliverNow(channel, deps, message, "notice", now);
}

async function deliverNow(channel: OperatorChannel, deps: OutboxDeps, message: OperatorMessage, kind: OutboxKind, now: Date): Promise<{ messageId: string }> {
  let result: { messageId: string };
  try {
    result = await channel.notify(message);
  } catch (error) {
    if (!(error instanceof AdapterError) || !error.retryable || message.buttons?.length) throw error;
    const id = newOutboxId();
    try {
      await insertHeld(
        deps.db,
        { id, chatId: message.chatId, kind, text: message.text, silent: message.silent === true, reason: "channel_error", releaseAt: retryAt(now, 1, error.retryAfterMs), attempts: 1, lastError: sanitizeErrorMessage(error) },
        now,
      );
    } catch (writeError) {
      deps.log?.warn("a message the channel refused could not be kept for a retry", { error: sanitizeErrorMessage(writeError) });
      throw error;
    }
    return { messageId: `${HELD_PREFIX}${id}` };
  }
  if (kind === "notice") {
    try {
      await recordSent(deps.db, message.chatId, now);
    } catch (error) {
      // Bookkeeping: an uncounted notice only loosens the hourly limit.
      deps.log?.warn("a delivered notice could not be counted", { error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}

async function hold(channel: OperatorChannel, deps: OutboxDeps, message: OperatorMessage, reason: HeldReason, releaseAt: Date, now: Date): Promise<{ messageId: string }> {
  const id = newOutboxId();
  try {
    await insertHeld(deps.db, { id, chatId: message.chatId, kind: "notice", text: message.text, silent: message.silent === true, reason, releaseAt, attempts: 0, lastError: null }, now);
  } catch (error) {
    deps.log?.warn("a notice could not be held, so it was delivered now", { reason, error: sanitizeErrorMessage(error) });
    return deliverNow(channel, deps, message, "notice", now);
  }
  return { messageId: `${HELD_PREFIX}${id}` };
}

interface HeldRow {
  id: string;
  chat_id: string | null;
  kind: OutboxKind;
  text: string | null;
  silent: number;
  reason: HeldReason | null;
  attempts: number;
  created_at: string;
}

const HELD_COLUMNS = "id, chat_id, kind, text, silent, reason, attempts, created_at";

/** The text of one message carrying these notices, oldest first. A notice that waited says since when. */
export function foldNotices(rows: ReadonlyArray<Pick<HeldRow, "text" | "reason" | "created_at">>): string {
  const [only] = rows;
  if (rows.length === 1 && only) return only.reason === "channel_error" ? (only.text ?? "") : `[Held from ${minuteUtc(only.created_at)}]\n${only.text ?? ""}`;
  const reasons = new Set(rows.map((r) => r.reason));
  const why = reasons.size === 1 && reasons.has("quiet_hours") ? " during quiet hours" : reasons.size === 1 && reasons.has("hourly_cap") ? " over the hourly limit" : "";
  return [`${rows.length} notices held${why}, oldest first:`, ...rows.map((r) => `[${minuteUtc(r.created_at)}]\n${r.text ?? ""}`)].join("\n\n");
}

/** Split one chat's due notices into folds of at most OUTBOX_FOLD_MAX_CHARS, keeping their order. */
function folds(rows: readonly HeldRow[]): HeldRow[][] {
  const out: HeldRow[][] = [];
  let current: HeldRow[] = [];
  let size = 0;
  for (const row of rows) {
    const length = (row.text ?? "").length + 40;
    if (current.length > 0 && size + length > OUTBOX_FOLD_MAX_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * One run of the operator_outbox job: deliver the held notices that are due through the channel
 * itself (never back through the outbox), then delete old sent and dropped rows. Throws on a
 * database error, so the run is recorded as failed; a channel error is recorded on the notices and
 * tried again later.
 */
export async function deliverHeldNotices<E extends Env>(ctx: JobContext<E>, channel: OperatorChannel | undefined): Promise<JobResult> {
  const db = ctx.env.DB;
  const now = ctx.now;
  const at = now.toISOString();
  const state = await outboxState(ctx.flags);
  // Only a flag that reads off drains everything at once; an unreadable one keeps quiet hours.
  const on = state !== "off";
  const quietEnd = on ? quietEndAt(ctx.config.operator.quietHours, now) : null;
  try {
    await db
      .prepare("UPDATE operator_outbox SET status = 'held', release_at = ?1, delivery_id = NULL, updated_at = ?1 WHERE status = 'sending' AND updated_at < ?2")
      .bind(at, new Date(now.getTime() - OUTBOX_STALE_SENDING_MS).toISOString())
      .run();
  } catch (error) {
    // A deployment that never applied migration 0033 has nothing held. With the outbox on, it is an error.
    if (state === "off" && /no such table/i.test(String(error))) return { summary: "no operator_outbox table (apply migration 0033); nothing is held", rows: 0 };
    throw error;
  }
  if (quietEnd) {
    // In quiet hours only pages and released notices go; the rest wait for the morning.
    await db
      .prepare("UPDATE operator_outbox SET release_at = ?1, updated_at = ?2 WHERE status = 'held' AND kind = 'notice' AND reason IS NOT 'released' AND release_at <= ?2")
      .bind(quietEnd.toISOString(), at)
      .run();
  }
  const limit = Math.max(1, ctx.ceilings.maxRows ?? OUTBOX_PER_RUN);
  const { results } = await db
    .prepare(`SELECT ${HELD_COLUMNS} FROM operator_outbox WHERE status = 'held' AND (?1 = 0 OR release_at <= ?2) ORDER BY created_at, id LIMIT ?3`)
    .bind(on ? 1 : 0, at, limit)
    .all<HeldRow>();
  const byChat = new Map<string, HeldRow[]>();
  for (const row of results ?? []) {
    const key = row.chat_id ?? "";
    const list = byChat.get(key);
    if (list) list.push(row);
    else byChat.set(key, [row]);
  }

  let delivered = 0;
  let messages = 0;
  let retried = 0;
  let dropped = 0;
  const raw = channel ? unwrapOutbox(channel) : undefined;
  if (raw) {
    deliver: for (const [chat, rows] of byChat) {
      for (const fold of folds(rows)) {
        if (ctx.signal.aborted) break deliver;
        const deliveryId = newOutboxId();
        await db
          .prepare("UPDATE operator_outbox SET status = 'sending', delivery_id = ?1, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?3)) AND status = 'held'")
          .bind(deliveryId, at, JSON.stringify(fold.map((r) => r.id)))
          .run();
        const claimed =
          (await db.prepare(`SELECT ${HELD_COLUMNS} FROM operator_outbox WHERE delivery_id = ?1 AND status = 'sending' ORDER BY created_at, id`).bind(deliveryId).all<HeldRow>()).results ?? [];
        if (claimed.length === 0) continue;
        const silent = quietEnd !== null || claimed.every((r) => r.silent === 1);
        try {
          await raw.notify({ text: foldNotices(claimed), ...(chat ? { chatId: chat } : {}), ...(silent ? { silent: true } : {}) });
        } catch (error) {
          const giveUpBefore = new Date(now.getTime() - OUTBOX_GIVE_UP_MS).toISOString();
          const pageGiveUpBefore = new Date(now.getTime() - OUTBOX_PAGE_GIVE_UP_MS).toISOString();
          const attempts = Math.max(...claimed.map((r) => r.attempts)) + 1;
          const after = error instanceof AdapterError ? error.retryAfterMs : undefined;
          await db
            .prepare(
              `UPDATE operator_outbox SET
                 status = CASE WHEN created_at < (CASE WHEN kind = 'page' THEN ?6 ELSE ?3 END) THEN 'dropped' ELSE 'held' END,
                 text = CASE WHEN created_at < (CASE WHEN kind = 'page' THEN ?6 ELSE ?3 END) THEN NULL ELSE text END,
                 reason = CASE WHEN reason = 'released' THEN reason ELSE 'channel_error' END,
                 attempts = attempts + 1, last_error = ?4, release_at = ?5, delivery_id = NULL, updated_at = ?2
               WHERE delivery_id = ?1 AND status = 'sending'`,
            )
            .bind(deliveryId, at, giveUpBefore, sanitizeErrorMessage(error).slice(0, 300), retryAt(now, attempts, after).toISOString(), pageGiveUpBefore)
            .run();
          const gone = claimed.filter((r) => r.created_at < (r.kind === "page" ? pageGiveUpBefore : giveUpBefore)).length;
          dropped += gone;
          retried += claimed.length - gone;
          if (gone > 0) ctx.log.error("held operator messages the channel kept refusing were dropped", { dropped: gone, error: sanitizeErrorMessage(error) });
          // A channel that is rate limited or down fails the next delivery too: stop this run.
          if (error instanceof AdapterError && error.retryable) break deliver;
          continue;
        }
        await db.prepare("UPDATE operator_outbox SET status = 'sent', text = NULL, sent_at = ?2, updated_at = ?2 WHERE delivery_id = ?1 AND status = 'sending'").bind(deliveryId, at).run();
        delivered += claimed.length;
        messages += 1;
      }
    }
  }
  const pruned = await db
    .prepare("DELETE FROM operator_outbox WHERE id IN (SELECT id FROM operator_outbox WHERE status IN ('sent', 'dropped') AND updated_at < ?1 LIMIT 500)")
    .bind(new Date(now.getTime() - OUTBOX_KEEP_MS).toISOString())
    .run();
  const mode = state === "off" ? ", outbox off" : state === "unknown" ? ", flag unreadable" : quietEnd ? ", quiet hours" : "";
  const missing = raw ? "" : `, no operator channel (${results?.length ?? 0} waiting)`;
  return { summary: `delivered=${delivered} in ${messages} message(s) retried=${retried} dropped=${dropped} pruned=${pruned.meta.changes ?? 0}${mode}${missing}`, rows: delivered };
}

export interface OperatorOutboxJobOptions<E> {
  /** The operator channel, wrapped in the outbox or not: the job always delivers through the channel itself. */
  operator: (env: E) => OperatorChannel | undefined;
  /** Defaults to every five minutes. */
  schedule?: string;
  /** Held notices one run delivers at most. Defaults to OUTBOX_PER_RUN. */
  maxPerRun?: number;
}

/**
 * The operator_outbox job. Register it whenever the channel is wrapped with withOperatorOutbox:
 * without it, held notices are never delivered. It has no flag, so notices held while
 * operator:outbox_enabled was on still go out after it is turned off.
 */
export function createOperatorOutboxJobs<E extends Env = Env>(options: OperatorOutboxJobOptions<E>): Array<JobDefinition<E>> {
  return [
    {
      name: OUTBOX_JOB,
      schedule: options.schedule ?? OUTBOX_SCHEDULE,
      ceilings: { maxDurationMs: 60_000, maxRows: Math.max(1, Math.floor(options.maxPerRun ?? OUTBOX_PER_RUN)) },
      rerunnable: true,
      run: (ctx) => {
        let channel: OperatorChannel | undefined;
        try {
          channel = options.operator(ctx.env);
        } catch (error) {
          ctx.log.warn("the operator channel could not be built; held notices wait for the next run", { error: sanitizeErrorMessage(error) });
          channel = undefined;
        }
        return deliverHeldNotices(ctx, channel);
      },
    },
  ];
}

export const OUTBOX_HELP_LINE = "/outbox  notices held for quiet hours or the hourly limit; /outbox send delivers them with the next outbox run";

const REASON_LABEL: Record<HeldReason, string> = { quiet_hours: "quiet hours", hourly_cap: "hourly limit", channel_error: "channel error, retrying", released: "released" };

function firstLine(text: string | null, max = 80): string {
  const line = ((text ?? "").split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/**
 * /outbox and /outbox send. Listing and releasing work whatever the flag says, so the operator can
 * always see and get what is waiting. Throws on a database error; the caller reports it.
 */
export async function runOutboxCommand(deps: { db: D1Database; flags?: FlagReader; quietHours?: QuietHours | undefined; now: Date }, args: string): Promise<string> {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const on = deps.flags ? await isOutboxEnabled(deps.flags) : true;
    const q = deps.quietHours;
    const state = !on
      ? "The outbox is off (operator:outbox_enabled): notices go straight to this chat, and anything still held below goes out with the next outbox run."
      : q
        ? `Quiet hours: ${hh(q.start)} to ${hh(q.end)} ${q.timeZone}${quietEndAt(q, deps.now) ? ", and it is quiet now" : ""}.`
        : "No quiet hours are set (operator.quietHours in gtm.config.ts); notices are held only over the hourly limit.";
    const total = await deps.db.prepare("SELECT COUNT(*) AS n FROM operator_outbox WHERE status IN ('held', 'sending')").first<{ n: number }>();
    const n = Number(total?.n ?? 0);
    if (n === 0) return [state, "No notices are held."].join("\n");
    const { results } = await deps.db
      .prepare("SELECT id, kind, text, reason, release_at FROM operator_outbox WHERE status IN ('held', 'sending') ORDER BY created_at, id LIMIT 20")
      .all<{ id: string; kind: OutboxKind; text: string | null; reason: HeldReason | null; release_at: string | null }>();
    return [
      state,
      `Held notices, oldest first (${n}):`,
      ...(results ?? []).map((r) => `${r.id}  ${r.reason ? REASON_LABEL[r.reason] : "held"}${r.kind === "page" ? ", page" : ""}, due ${minuteUtc(r.release_at ?? "")}: ${firstLine(r.text)}`),
      ...(n > 20 ? [`and ${n - 20} more.`] : []),
      "Send /outbox send to have them delivered with the next outbox run, quiet hours or not.",
    ].join("\n");
  }
  if (words.length === 1 && words[0] === "send") {
    const at = deps.now.toISOString();
    const result = await deps.db.prepare("UPDATE operator_outbox SET reason = 'released', release_at = ?1, updated_at = ?1 WHERE status = 'held'").bind(at).run();
    const n = result.meta.changes ?? 0;
    return n === 0 ? "No notices are held." : `Released ${n} held notice${n === 1 ? "" : "s"}. They arrive together with the next outbox run, within five minutes on the default schedule.`;
  }
  return "Send /outbox for the notices held for quiet hours or the hourly limit, or /outbox send to have them delivered now.";
}
