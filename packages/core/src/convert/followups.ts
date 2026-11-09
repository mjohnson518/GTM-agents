// GTM-agents: what follows a booked meeting, run every 15 minutes: reminders, the held or no-show
// question, the recap, and the post-demo follow-ups. No model call; nothing is sent to anyone but
// the operator.
//
// For each attributed meeting that is not cancelled and starts between 14 days ago and 25 hours
// from now:
//   - reminders: the operator is reminded once when the meeting is 24 hours away (with the prep
//     brief) and once when it is 1 hour away. Each is claimed in the effects ledger per start time,
//     so a moved meeting is reminded again and a failed notice is retried;
//   - after it ends, the operator is asked once whether it was held, with the meeting-held and
//     meeting-noshow commands. With no answer 24 hours after asking, the recap is drafted for review
//     (drafts.ts); a later no-show answer withdraws it;
//   - post-demo follow-ups (convert:post_demo_enabled): once the recap is approved (the operator's
//     sign that it went out), step 2 is drafted 4 days after the meeting and, once step 2 is
//     approved, step 3 at day 10. Each waits for approval. They stop, and open step drafts are
//     withdrawn, on any mail from the contact or anyone at the account after the meeting, a
//     suppressed address, a sign-up, or a newer meeting with the contact or the account. A no-show
//     never gets them.
import type { GtmConfig } from "../config/schema.ts";
import { PRODUCT_STATES } from "../data/enums.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { readOn } from "../outreach/flags.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { label } from "../reports/format.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { SEQUENCE_STOPPING_CLASSIFICATIONS } from "../sequences/state.ts";
import { dealFor } from "./booked.ts";
import { displayName, loadContactBrief, renderPrepBrief, when } from "./brief.ts";
import { convertDraftStatus, createConvertDraft, withdrawConvertDrafts, type ConvertDraftKind } from "./drafts.ts";
import { CONVERT_FLAGS, CONVERT_LIMITS } from "./flags.ts";
import { meetingEffectKey } from "./state.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const STOPPING = SEQUENCE_STOPPING_CLASSIFICATIONS.map((c) => `'${c}'`).join(", ");

export interface FollowupDeps {
  db: D1Database;
  config: GtmConfig;
  flags: FlagReader;
  operator?: OperatorChannel | undefined;
  shown?: ShownStore | undefined;
  chatId?: string | undefined;
  now: Date;
  log: JobLogger;
  maxRows: number;
}

export interface FollowupResult {
  meetings: number;
  reminders: number;
  asked: number;
  recaps: number;
  steps: number;
  stopped: number;
  failed: number;
}

export interface FollowupRow {
  event_id: string;
  code: string;
  contact_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  attribution: string | null;
  outcome: string | null;
  held_asked_at: string | null;
  sequence_step: number | null;
  sequence_stopped: number;
  first_name: string | null;
  last_name: string | null;
  email: string;
  job_title: string | null;
  timezone: string | null;
  account_key: string | null;
}

const OPEN_OR_DONE = new Set(["approved", "sent"]);

/** The reminder due for a meeting at `now`, or null. Pure. */
export function dueReminder(startsAt: string, now: Date): "24h" | "1h" | null {
  const until = Date.parse(startsAt) - now.getTime();
  if (!(until > 0)) return null;
  if (until <= HOUR_MS) return "1h";
  if (until <= 24 * HOUR_MS) return "24h";
  return null;
}

/** The post-demo step due for a meeting at `now`, or null. Pure. */
export function dueStep(row: Pick<FollowupRow, "ends_at" | "sequence_step">, recap: string | null, step2: string | null, now: Date): 2 | 3 | null {
  const ended = Date.parse(row.ends_at);
  const step = row.sequence_step ?? 0;
  if (step < 2 && recap !== null && OPEN_OR_DONE.has(recap) && now.getTime() >= ended + CONVERT_LIMITS.postDemoStepDays[2] * DAY_MS) return 2;
  if (step === 2 && step2 !== null && OPEN_OR_DONE.has(step2) && now.getTime() >= ended + CONVERT_LIMITS.postDemoStepDays[3] * DAY_MS) return 3;
  return null;
}

/**
 * Why a meeting's post-demo follow-ups must stop, or null. A read error throws: the caller skips the
 * meeting for this run (nothing is drafted) and checks again on the next.
 */
export async function postDemoStopReason(db: D1Database, row: FollowupRow): Promise<string | null> {
  const account = row.account_key ?? "";
  const [mail, newer, signedUp] = await db.batch([
    db
      .prepare(
        `SELECT 1 AS hit FROM inbound_emails ie
          WHERE ie.received_at > ?1 AND (ie.classification IS NULL OR ie.classification IN (${STOPPING}))
            AND (ie.contact_id = ?2 OR lower(ie.sender_email) = ?3
              OR (?4 <> '' AND (ie.account_key = ?4 OR ie.contact_id IN (SELECT id FROM contacts WHERE account_key = ?4))))
          LIMIT 1`,
      )
      .bind(row.ends_at, row.contact_id, row.email.toLowerCase(), account),
    db
      .prepare(
        `SELECT 1 AS hit FROM calendar_meetings m JOIN contacts c ON c.id = m.contact_id
          WHERE m.event_id <> ?1 AND m.status <> 'cancelled' AND m.starts_at > ?2 AND (m.contact_id = ?3 OR (?4 <> '' AND c.account_key = ?4))
          LIMIT 1`,
      )
      .bind(row.event_id, row.starts_at, row.contact_id, account),
    db
      .prepare(`SELECT 1 AS hit FROM contact_lifecycle WHERE contact_id = ?1 AND (signed_up_at IS NOT NULL OR state IN (${PRODUCT_STATES.map((s) => `'${s}'`).join(", ")})) LIMIT 1`)
      .bind(row.contact_id),
  ]);
  if ((mail?.results.length ?? 0) > 0) return "mail arrived from them or their account";
  if ((newer?.results.length ?? 0) > 0) return "a newer meeting is booked";
  if ((signedUp?.results.length ?? 0) > 0) return "they signed up";
  const suppression = await checkSuppression(db, [row.email]);
  if (suppression.blocked.some((b) => b.reason === "check_failed")) throw new Error("the suppression list could not be read");
  if (!suppression.ok) return "their address is suppressed";
  return null;
}

/** Send a notice once per (meeting, effect). "sent" now, "already" sent before, "none" with no channel, "failed" to retry. */
async function notifyOnce(deps: FollowupDeps, code: string, effect: string, text: string): Promise<"sent" | "already" | "none" | "failed"> {
  if (!deps.operator) return "none";
  const key = meetingEffectKey(code);
  if (!(await claimEffect(deps.db, key, effect))) return "already";
  try {
    await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    return "sent";
  } catch (error) {
    await releaseEffect(deps.db, key, effect);
    deps.log.warn("a meeting notice could not be sent; the next run tries again", { code, effect, error: sanitizeErrorMessage(error) });
    return "failed";
  }
}

const who = (row: FollowupRow) => `${displayName(row)}${row.job_title ? ` (${label(row.job_title, 40)})` : ""}`;

/** One run. Throws only when the meetings cannot be read. */
export async function runMeetingFollowups(deps: FollowupDeps): Promise<FollowupResult> {
  const { db, now, log } = deps;
  const result: FollowupResult = { meetings: 0, reminders: 0, asked: 0, recaps: 0, steps: 0, stopped: 0, failed: 0 };
  const postDemo = await readOn(deps.flags, CONVERT_FLAGS.postDemo);
  const { results: rows } = await db
    .prepare(
      `SELECT cm.event_id, ce.code, cm.contact_id, cm.starts_at, cm.ends_at, cm.status, cm.attribution, cm.outcome, cm.held_asked_at,
              cm.sequence_step, cm.sequence_stopped, c.first_name, c.last_name, c.email, c.job_title, c.timezone, c.account_key
         FROM calendar_meetings cm
         JOIN calendar_events ce ON ce.event_id = cm.event_id AND ce.state = 'attributed'
         JOIN contacts c ON c.id = cm.contact_id
        WHERE cm.status <> 'cancelled' AND cm.starts_at >= ?1 AND cm.starts_at <= ?2
        ORDER BY cm.starts_at ASC LIMIT ?3`,
    )
    .bind(new Date(now.getTime() - CONVERT_LIMITS.followUpLookbackDays * DAY_MS).toISOString(), new Date(now.getTime() + 25 * HOUR_MS).toISOString(), deps.maxRows)
    .all<FollowupRow>();
  result.meetings = rows.length;
  const draftDeps = { db, config: deps.config, operator: deps.operator, shown: deps.shown, chatId: deps.chatId, now, log };

  for (const row of rows) {
    try {
      const reminder = dueReminder(row.starts_at, now);
      if (reminder) {
        const head = `Reminder: meeting with ${who(row)} ${reminder === "1h" ? "in about an hour" : "in about 24 hours"}, ${when(row.starts_at)} [${row.code}].`;
        let text = `${head}\nPrep brief on demand: prep-${row.contact_id}`;
        if (reminder === "24h") {
          const brief = await loadContactBrief(db, row.contact_id);
          if (brief) text = `${head}\n\n${renderPrepBrief(brief, { code: row.code, starts_at: row.starts_at, ends_at: row.ends_at, attribution: row.attribution }, now)}`;
        }
        if ((await notifyOnce(deps, row.code, `meeting_reminder_${reminder}:${row.starts_at}`, text)) === "sent") {
          result.reminders += 1;
          const column = reminder === "24h" ? "reminded_24h_at" : "reminded_1h_at";
          await db.prepare(`UPDATE calendar_meetings SET ${column} = ?2, updated_at = ?2 WHERE event_id = ?1`).bind(row.event_id, now.toISOString()).run();
        }
        continue;
      }
      if (Date.parse(row.ends_at) > now.getTime()) continue;

      if (row.outcome === null && row.held_asked_at === null) {
        const text = [
          `Did the meeting with ${who(row)} on ${when(row.starts_at)} [${row.code}] take place?${row.attribution === "domain_contacted" ? " It was matched by company domain, not by address: if it was someone else, meeting-unlink-" + row.code + " makes it inert." : ""}`,
          `Answer meeting-held-${row.code} or meeting-noshow-${row.code}. Add notes with meeting-notes-${row.code} <notes>.`,
          `With no answer in ${CONVERT_LIMITS.recapAfterHours} hours, a recap is drafted for your review. Nothing is sent.`,
        ].join("\n");
        // Asked now, asked before, or no channel to ask on: the 24-hour clock for the recap starts.
        const asked = await notifyOnce(deps, row.code, `meeting_held_ask:${row.starts_at}`, text);
        if (asked !== "failed") {
          if (asked === "sent") result.asked += 1;
          await db.prepare("UPDATE calendar_meetings SET held_asked_at = ?2, updated_at = ?2 WHERE event_id = ?1 AND held_asked_at IS NULL").bind(row.event_id, now.toISOString()).run();
        }
        continue;
      }

      if (row.outcome === null && row.held_asked_at !== null && now.getTime() - Date.parse(row.held_asked_at) >= CONVERT_LIMITS.recapAfterHours * HOUR_MS) {
        const deal = await dealFor(db, row.contact_id, row.account_key);
        const draft = await createConvertDraft(draftDeps, {
          code: row.code,
          kind: "recap",
          contact: { id: row.contact_id, email: row.email, first_name: row.first_name, timezone: row.timezone },
          dealId: deal?.id ?? null,
          meetingStart: row.starts_at,
          attribution: row.attribution,
        });
        if (draft.status === "created") {
          result.recaps += 1;
          await db.prepare("UPDATE calendar_meetings SET sequence_step = MAX(COALESCE(sequence_step, 0), 1), updated_at = ?2 WHERE event_id = ?1").bind(row.event_id, now.toISOString()).run();
          await notifyOnce(deps, row.code, "meeting_recap_unanswered", `No answer about the meeting with ${who(row)} [${row.code}], so a recap was drafted for your review. If they did not show, meeting-noshow-${row.code} withdraws it and drafts a rebook.`);
        }
      }

      if (!postDemo || row.outcome === "no_show" || row.sequence_stopped === 1 || (row.sequence_step ?? 0) < 1 || (row.sequence_step ?? 0) >= 3) continue;
      const stop = await postDemoStopReason(db, row);
      if (stop) {
        await db.prepare("UPDATE calendar_meetings SET sequence_stopped = 1, sequence_next_at = NULL, updated_at = ?2 WHERE event_id = ?1").bind(row.event_id, now.toISOString()).run();
        const withdrawn = await withdrawConvertDrafts(db, row.code, ["step2", "step3"], now);
        result.stopped += 1;
        log.info("post-demo follow-ups stopped", { code: row.code, reason: stop, withdrawn });
        continue;
      }
      const [recap, step2] = await Promise.all([convertDraftStatus(db, row.code, "recap"), convertDraftStatus(db, row.code, "step2")]);
      const due = dueStep(row, recap, step2, now);
      if (!due) continue;
      const kind: ConvertDraftKind = due === 2 ? "step2" : "step3";
      const deal = await dealFor(db, row.contact_id, row.account_key);
      const draft = await createConvertDraft(draftDeps, {
        code: row.code,
        kind,
        contact: { id: row.contact_id, email: row.email, first_name: row.first_name, timezone: row.timezone },
        dealId: deal?.id ?? null,
        meetingStart: row.starts_at,
        attribution: row.attribution,
      });
      if (draft.status === "created" || draft.status === "exists") {
        const nextAt = due === 2 ? new Date(Date.parse(row.ends_at) + CONVERT_LIMITS.postDemoStepDays[3] * DAY_MS).toISOString() : null;
        await db
          .prepare("UPDATE calendar_meetings SET sequence_step = MAX(COALESCE(sequence_step, 0), ?2), sequence_next_at = ?3, updated_at = ?4 WHERE event_id = ?1")
          .bind(row.event_id, due, nextAt, now.toISOString())
          .run();
        if (draft.status === "created") result.steps += 1;
      }
    } catch (error) {
      result.failed += 1;
      log.warn("a meeting follow-up failed; the next run tries again", { code: row.code, error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}
