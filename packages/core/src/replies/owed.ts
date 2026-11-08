// GTM-agents: the reply-owed clock: remind the operator until every reply that needs them is
// answered, and surface threads that went quiet after an answer.
//
// Owed: inbound mail still new, notified or with a draft waiting, received in the clock window
// (14 days by default), that either triage read as needing a person (interested, question,
// referral, warm, objection, unclear, or an opt-out too uncertain to act on) or that comes from a known contact and is not triaged yet,
// so a failed triage can never hide a reply.
//
// Reminders escalate at 15 minutes, 2 hours and 4 hours. Each fires once per message, and a message
// first seen late gets only its highest due tier, not every one it skipped. Once a message is 12
// hours old it gets one reminder each morning (the configured UTC hour) instead. Every reminder is
// claimed in the effects ledger before it is sent and released if the notification fails, so a
// failed ping is retried on the next run rather than lost.
//
// Quiet threads: a warm thread answered at least 5 days ago, with nothing from them since and no
// meeting booked, is surfaced once. Nothing is ever sent to them from here.
//
// Operator messages carry the sender's address and at most a short sanitized preview, never the
// inbound text itself. This job makes no model calls.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { DAY_MS, daysAgo } from "./rows.ts";
import { operatorPreview, senderLabel } from "./text.ts";

export const REMINDER_TIERS: ReadonlyArray<{ key: string; minutes: number; label: string }> = Object.freeze([
  { key: "15m", minutes: 15, label: "15 minutes" },
  { key: "2h", minutes: 120, label: "2 hours" },
  { key: "4h", minutes: 240, label: "4 hours" },
]);
export const MORNING_MIN_AGE_HOURS = 12;
export const QUIET_THREAD_DAYS = 5;
/** Intents that need a person. Untriaged mail from known contacts is owed too. */
export const OWED_INTENTS = ["interested", "question", "referral", "warm", "objection", "unclear", "opt_out"] as const;
const QUIET_INTENTS = ["interested", "question", "referral", "warm"] as const;
const REMINDER_EFFECT = "reply_reminder";
const QUIET_EFFECT = "reply_quiet_thread";

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

/** The SQL condition "this message is owed", for an inbound_emails row aliased `i`. */
export const OWED_SQL = `i.status IN ('new', 'notified', 'draft_created')
  AND (i.intent IN (${quoted(OWED_INTENTS)})
       OR (i.intent IS NULL AND i.contact_id IS NOT NULL AND COALESCE(i.classification, 'unclassified') IN ('reply', 'new_inquiry', 'unclassified')))`;

/**
 * The reminder due now for a message received at `receivedAt`, given the keys already sent for it,
 * or null. After MORNING_MIN_AGE_HOURS only the morning reminder applies, once per UTC day, from
 * `morningHourUtc`. Before that, only the highest tier reached, once. Pure.
 */
export function dueReminder(receivedAt: Date, now: Date, sent: ReadonlySet<string>, morningHourUtc: number): string | null {
  const ageMinutes = (now.getTime() - receivedAt.getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return null;
  if (ageMinutes >= MORNING_MIN_AGE_HOURS * 60) {
    if (now.getUTCHours() < morningHourUtc) return null;
    const key = `morning:${now.toISOString().slice(0, 10)}`;
    return sent.has(key) ? null : key;
  }
  for (let i = REMINDER_TIERS.length - 1; i >= 0; i--) {
    const tier = REMINDER_TIERS[i];
    if (tier && ageMinutes >= tier.minutes) return sent.has(tier.key) ? null : tier.key;
  }
  return null;
}

/** "45m", "3h", "2d". */
export function waitedFor(receivedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - receivedAt.getTime()) / 60_000));
  if (minutes < 120) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export interface OwedDeps {
  db: D1Database;
  operator: OperatorChannel | undefined;
  /** Where reminders go; the channel's default chat when omitted. */
  chatId?: string;
  now: Date;
  log: JobLogger;
  morningHourUtc: number;
  windowDays: number;
  maxRows: number;
}

interface OwedRow {
  id: string;
  sender_email: string;
  received_at: string;
  intent: string | null;
  body_preview: string | null;
  draft_id: string | null;
  draft_status: string | null;
}

const reminderKey = (id: string, key: string) => `reply_owed:${id}:${key}`;

async function notify(deps: OwedDeps, text: string): Promise<boolean> {
  if (!deps.operator) return false;
  try {
    await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    return true;
  } catch (error) {
    deps.log.warn("a reply reminder could not be sent; it will be retried", { error: sanitizeErrorMessage(error) });
    return false;
  }
}

export interface OwedResult {
  owed: number;
  reminded: number;
  quiet: number;
}

/** One pass of the clock: due reminders, then quiet threads. Throws only on a database read error. */
export async function runReplyClock(deps: OwedDeps): Promise<OwedResult> {
  const { db, now } = deps;
  const { results: rows } = await db
    .prepare(
      `SELECT i.id, i.sender_email, i.received_at, i.intent, i.body_preview, i.draft_id, d.status AS draft_status
         FROM inbound_emails i LEFT JOIN drafts d ON d.id = i.draft_id
        WHERE ${OWED_SQL} AND i.received_at >= ?1 AND i.received_at <= ?2
        ORDER BY i.received_at ASC LIMIT ?3`,
    )
    .bind(daysAgo(now, deps.windowDays), new Date(now.getTime() - (REMINDER_TIERS[0]?.minutes ?? 15) * 60_000).toISOString(), deps.maxRows)
    .all<OwedRow>();
  const result: OwedResult = { owed: rows.length, reminded: 0, quiet: 0 };

  const due: Array<{ id: string; key: string; line: string }> = [];
  if (rows.length > 0 && deps.operator) {
    const keys = rows.flatMap((r) => [...REMINDER_TIERS.map((t) => t.key), `morning:${now.toISOString().slice(0, 10)}`].map((k) => reminderKey(r.id, k)));
    const claimed = new Set<string>();
    for (let i = 0; i < keys.length; i += 90) {
      const chunk = keys.slice(i, i + 90);
      const { results } = await db
        .prepare(`SELECT event_id FROM event_effects WHERE effect = ?1 AND event_id IN (${chunk.map((_, k) => `?${k + 2}`).join(", ")})`)
        .bind(REMINDER_EFFECT, ...chunk)
        .all<{ event_id: string }>();
      for (const row of results) claimed.add(row.event_id);
    }
    for (const row of rows) {
      const receivedAt = new Date(row.received_at);
      const sent = new Set([...REMINDER_TIERS.map((t) => t.key), `morning:${now.toISOString().slice(0, 10)}`].filter((k) => claimed.has(reminderKey(row.id, k))));
      const key = dueReminder(receivedAt, now, sent, deps.morningHourUtc);
      if (!key) continue;
      let won: boolean;
      try {
        won = await claimEffect(db, reminderKey(row.id, key), REMINDER_EFFECT);
      } catch {
        won = false;
      }
      if (!won) continue;
      const preview = operatorPreview(row.body_preview);
      const draft = row.draft_id ? `, draft ${row.draft_id} ${row.draft_status ?? ""}`.trimEnd() : "";
      due.push({
        id: row.id,
        key,
        line: `- ${senderLabel(row.sender_email)} (${row.intent ?? "not triaged yet"}, waiting ${waitedFor(receivedAt, now)}${draft}) [${row.id}]${preview ? `: "${preview}"` : ""}`,
      });
    }
  }
  if (due.length > 0) {
    const text = [
      `Replies waiting on you (${due.length}):`,
      ...due.map((d) => d.line),
      "",
      "Approve the draft, or answer from your mailbox. /replies lists everything owed; /reply_done <id> marks one answered, /reply_ignore <id> needs no answer.",
    ].join("\n");
    if (await notify(deps, text)) {
      result.reminded = due.length;
      try {
        await db
          .prepare(`UPDATE inbound_emails SET status = 'notified', updated_at = ?1 WHERE status = 'new' AND id IN (SELECT value FROM json_each(?2))`)
          .bind(now.toISOString(), JSON.stringify(due.map((d) => d.id)))
          .run();
      } catch {
        // Bookkeeping: the reminders went out either way.
      }
    } else {
      for (const d of due) await releaseEffect(db, reminderKey(d.id, d.key), REMINDER_EFFECT);
    }
  }

  result.quiet = await surfaceQuietThreads(deps);
  return result;
}

/** Warm threads answered QUIET_THREAD_DAYS ago with nothing since, each surfaced once. */
async function surfaceQuietThreads(deps: OwedDeps): Promise<number> {
  const { db, now } = deps;
  if (!deps.operator) return 0;
  const { results } = await db
    .prepare(
      `SELECT i.id, i.sender_email FROM inbound_emails i
        WHERE i.status = 'responded' AND i.contact_id IS NOT NULL AND i.intent IN (${quoted(QUIET_INTENTS)})
          AND i.received_at >= ?1
          AND MAX(i.updated_at,
                  COALESCE((SELECT MAX(s.sent_at) FROM outreach_sends s WHERE s.contact_id = i.contact_id), ''),
                  COALESCE((SELECT MAX(l.created_at) FROM outreach_log l WHERE l.contact_id = i.contact_id AND l.direction = 'outbound'), '')) <= ?2
          AND NOT EXISTS (SELECT 1 FROM inbound_emails later WHERE later.contact_id = i.contact_id AND later.received_at > i.received_at)
          AND NOT EXISTS (SELECT 1 FROM calendar_meetings m WHERE m.contact_id = i.contact_id AND m.status <> 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'quiet_thread:' || i.id AND ee.effect = ?3)
        ORDER BY i.received_at ASC LIMIT 20`,
    )
    .bind(daysAgo(now, 30), new Date(now.getTime() - QUIET_THREAD_DAYS * DAY_MS).toISOString(), QUIET_EFFECT)
    .all<{ id: string; sender_email: string }>();
  const claimed: Array<{ id: string; sender: string }> = [];
  for (const row of results) {
    try {
      if (await claimEffect(db, `quiet_thread:${row.id}`, QUIET_EFFECT)) claimed.push({ id: row.id, sender: senderLabel(row.sender_email) });
    } catch {
      // Not claimed, so not surfaced this time.
    }
  }
  if (claimed.length === 0) return 0;
  const text = [
    `Gone quiet after your answer (${QUIET_THREAD_DAYS}+ days, no meeting):`,
    ...claimed.map((c) => `- ${c.sender} [${c.id}]`),
    "",
    "Worth one short note with something new, or leave them. Nothing is sent automatically.",
  ].join("\n");
  if (await notify(deps, text)) return claimed.length;
  for (const c of claimed) await releaseEffect(db, `quiet_thread:${c.id}`, QUIET_EFFECT);
  return 0;
}
