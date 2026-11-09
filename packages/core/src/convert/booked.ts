// GTM-agents: what a booked meeting does, and how it is undone when the meeting stops counting.
//
// applyBooked runs once per meeting and contact, each step claimed in the effects ledger under
// `calendar:<code>:<contact id>` so a rerun repeats nothing that worked and retries what failed:
//   1. warmth: the contact and every other attributed contact on the invite move to hot (forward
//      only, advanceWarmth), so each of their accounts counts as in a conversation and the cold
//      batch, a release and the follow-up sweep refuse them at their own gates;
//   2. stop: every cold sequence for those contacts and everyone at their accounts ends
//      (stopSequences, status converted), their queued cold and sequence sends in the deferred
//      queue are cancelled, and open cold and follow-up drafts for them are rejected;
//   3. deal: the contact's open deal (else the account's newest) steps to demo_scheduled
//      (transitionDeal, forward only); with none, one is created. A contact or account that already
//      has a won deal gets no new one;
//   4. credit: the meeting is credited to the first touch that earned it (ledger.ts). Nothing else
//      counts it: meetings per template come from the ledger and metrics/meetings.ts, and the
//      templates.times_meeting column is not written;
//   5. brief: the static prep brief (brief.ts) is stored as a deal handoff and sent to the operator
//      with the booking notice;
//   6. lifecycle: the contact and every other attributed contact on the invite who has not signed
//      up yet move to engaged, through the lifecycle module, the state's only writer
//      (recordMeetingBooked).
// Each step is bookkeeping: a failure is logged, its claim released, and the next sync tries again.
// When all have worked, a final claim marks the meeting done, so later syncs skip it.
//
// withdrawBooked runs when a meeting stops counting (cancelled, unlinked, the outside person
// declined): the ledger credit is taken back, and the credit claim is released so a meeting that
// counts again is credited again. The withdrawal is recorded in the effects ledger first
// (`calendar-withdraw:<code>:<contact id>`, effect: the meeting's first sighting) and that record is
// cleared only once it has worked, so a withdrawal that failed is retried by the next calendar sync
// (retryCreditWithdrawals), unless the meeting counts again by then. Warmth, the deal stage and
// stopped sequences only move forward and are not reversed; the operator can resume a sequence by
// hand. Neither is the lifecycle state, which never moves backwards either.
import type { GtmConfig } from "../config/schema.ts";
import { advanceWarmth } from "../data/contacts.ts";
import { canTransitionDeal, transitionDeal } from "../data/deals.ts";
import type { DealStage } from "../data/enums.ts";
import { claimEffect, hasEffect, releaseEffect, runOnce } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { recordMeetingBooked } from "../lifecycle/apply.ts";
import type { MeetingRow } from "../metrics/meetings.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { label } from "../reports/format.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { stopSequences } from "../sequences/state.ts";
import { displayName, loadContactBrief, renderPrepBrief, when } from "./brief.ts";
import { creditMeeting, withdrawMeetingCredit } from "./ledger.ts";

export const BOOKED_STEPS = ["warmth", "stop", "deal", "credit", "brief", "lifecycle"] as const;
export type BookedStep = (typeof BOOKED_STEPS)[number];
const DONE = "meeting_booked_done";
const stepEffect = (step: BookedStep) => `meeting_booked_${step}`;

/** The effects-ledger event id for one meeting and contact. */
export const bookedKey = (code: string, contactId: string): string => `calendar:${code}:${contactId}`;

export interface BookedMeeting extends MeetingRow {
  event_id: string;
  code: string;
  contact_id: string;
  starts_at: string;
  ends_at: string;
  /** Other attributed contacts on the invite: their sequences and accounts are stopped too. */
  otherContactIds?: readonly string[];
}

export interface BookedDeps {
  db: D1Database;
  config: Pick<GtmConfig, "company" | "operator">;
  operator?: OperatorChannel | undefined;
  chatId?: string | undefined;
  now: Date;
  log: JobLogger;
  /** Skip the operator notice (a command answers in chat instead). The brief is still stored. */
  quiet?: boolean;
}

export interface BookedResult {
  /** Every step has worked, now or before. */
  complete: boolean;
  failed: BookedStep[];
  /** The prep brief, when this call built it. */
  brief: string | null;
  dealId: string | null;
}

/** The open deal for a contact (else the account's newest), or the won one, or null. Throws on a database error. */
export async function dealFor(db: D1Database, contactId: string, accountKey: string | null): Promise<{ id: string; stage: DealStage } | null> {
  return db
    .prepare(
      `SELECT id, stage FROM deals
        WHERE stage <> 'closed_lost' AND (contact_id = ?1 OR (?2 <> '' AND account_key = ?2))
        ORDER BY (stage = 'closed_won'), (contact_id = ?1) DESC, updated_at DESC LIMIT 1`,
    )
    .bind(contactId, accountKey ?? "")
    .first<{ id: string; stage: DealStage }>();
}

/** Step the contact's deal to demo_scheduled, creating one when there is none. Returns the deal id. Throws on a database error. */
export async function ensureDemoDeal(db: D1Database, contact: { id: string; account_key: string | null }, code: string, now: Date): Promise<string> {
  const existing = await dealFor(db, contact.id, contact.account_key);
  if (existing) {
    if (existing.stage !== "closed_won" && canTransitionDeal(existing.stage, "demo_scheduled")) {
      await transitionDeal(db, existing.id, "demo_scheduled", { reason: `meeting ${code} booked`, actor: "calendar_sync", now });
    }
    return existing.id;
  }
  const account = contact.account_key ? await db.prepare("SELECT name FROM accounts WHERE account_key = ?1").bind(contact.account_key).first<{ name: string }>() : null;
  const id = `deal_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const at = now.toISOString();
  const name = account?.name ? label(account.name, 80) : contact.account_key ? contact.account_key : `Meeting ${code}`;
  // One statement checks and inserts, so a deal the lifecycle opened for this contact in the
  // meantime is stepped instead of a second one being created.
  await db
    .prepare(
      `INSERT INTO deals (id, account_key, contact_id, name, stage, source, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'prospecting', 'calendar', ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM deals WHERE contact_id = ?3 AND stage NOT IN ('closed_won', 'closed_lost'))`,
    )
    .bind(id, contact.account_key, contact.id, name, at)
    .run();
  const deal = (await dealFor(db, contact.id, contact.account_key)) ?? { id, stage: "prospecting" as DealStage };
  if (deal.stage !== "closed_won" && canTransitionDeal(deal.stage, "demo_scheduled")) {
    await transitionDeal(db, deal.id, "demo_scheduled", { reason: `meeting ${code} booked`, actor: "calendar_sync", now });
  }
  return deal.id;
}

/** The booking notice: who, when, what was stopped, and the brief. Pure. */
export function bookingNotice(name: string, meeting: Pick<BookedMeeting, "code" | "starts_at">, brief: string | null, past: boolean): string {
  return [
    `Meeting booked with ${name}, ${when(meeting.starts_at)} [${meeting.code}]${past ? " (it already took place when calendar sync first saw it)" : ""}.`,
    "Cold outreach and follow-ups to them and their account are stopped. Reminders follow at 24 hours and 1 hour.",
    `Wrong person? meeting-unlink-${meeting.code} makes it inert.`,
    ...(brief ? ["", brief] : []),
  ].join("\n");
}

/** Apply a booked meeting's effects, each once. Never throws. */
export async function applyBooked(deps: BookedDeps, meeting: BookedMeeting): Promise<BookedResult> {
  const { db, log, now } = deps;
  const key = bookedKey(meeting.code, meeting.contact_id);
  const result: BookedResult = { complete: false, failed: [], brief: null, dealId: null };
  try {
    if (await hasEffect(db, key, DONE)) return { ...result, complete: true };
  } catch (error) {
    log.warn("booked effects could not be read", { code: meeting.code, error: sanitizeErrorMessage(error) });
    return { ...result, failed: [...BOOKED_STEPS] };
  }
  let contact: { id: string; account_key: string | null; first_name: string | null; last_name: string | null; email: string } | null;
  let others: Array<{ id: string; account_key: string | null }>;
  try {
    contact = await db.prepare("SELECT id, account_key, first_name, last_name, email FROM contacts WHERE id = ?1").bind(meeting.contact_id).first();
    const ids = JSON.stringify((meeting.otherContactIds ?? []).filter((id) => id !== meeting.contact_id));
    ({ results: others } = await db.prepare("SELECT id, account_key FROM contacts WHERE id IN (SELECT value FROM json_each(?1))").bind(ids).all<{ id: string; account_key: string | null }>());
  } catch (error) {
    log.warn("the booked contact could not be read", { code: meeting.code, error: sanitizeErrorMessage(error) });
    return { ...result, failed: [...BOOKED_STEPS] };
  }
  if (!contact) return { ...result, failed: [...BOOKED_STEPS] };
  const booked = contact;

  const step = async (name: BookedStep, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await runOnce(db, key, stepEffect(name), fn);
    } catch (error) {
      result.failed.push(name);
      log.warn("a booked-meeting step failed; the next sync retries it", { code: meeting.code, step: name, error: sanitizeErrorMessage(error) });
    }
  };

  await step("warmth", async () => {
    for (const c of [booked, ...others]) await advanceWarmth(db, c.id, "hot", now);
  });

  await step("stop", async () => {
    const everyone = [booked, ...others];
    const ids = everyone.map((c) => c.id);
    const accounts = [...new Set(everyone.map((c) => c.account_key).filter((k): k is string => typeof k === "string" && k !== ""))];
    const reason = `meeting ${meeting.code} booked`;
    await stopSequences(db, { contactIds: ids }, { reason, status: "converted", now });
    for (const account of accounts) await stopSequences(db, { accountKey: account }, { reason, status: "converted", now });
    await db
      .prepare(
        `UPDATE deferred_sends SET status = 'cancelled', last_error = ?3
          WHERE status = 'queued' AND send_path IN ('cold', 'sequence')
            AND (contact_id IN (SELECT value FROM json_each(?1)) OR contact_id IN (SELECT id FROM contacts WHERE account_key IN (SELECT value FROM json_each(?2))))`,
      )
      .bind(JSON.stringify(ids), JSON.stringify(accounts), `cancelled: ${reason}`)
      .run();
    await db
      .prepare(
        `UPDATE drafts SET status = 'rejected', updated_at = ?3
          WHERE kind IN ('cold_intro', 'follow_up', 'breakup') AND status IN ('draft', 'pending_approval', 'approved')
            AND (contact_id IN (SELECT value FROM json_each(?1)) OR contact_id IN (SELECT id FROM contacts WHERE account_key IN (SELECT value FROM json_each(?2))))`,
      )
      .bind(JSON.stringify(ids), JSON.stringify(accounts), now.toISOString())
      .run();
  });

  await step("deal", () => ensureDemoDeal(db, booked, meeting.code, now));

  // The stored row decides whether the meeting predates the baseline: every caller then credits by
  // the one definition, whatever fields it passed.
  await step("credit", async () => {
    const stored = await db.prepare("SELECT before_baseline FROM calendar_meetings WHERE event_id = ?1").bind(meeting.event_id).first<{ before_baseline: number | null }>();
    return creditMeeting(db, booked.id, { ...meeting, before_baseline: stored?.before_baseline ?? meeting.before_baseline ?? 0 });
  });

  await step("brief", async () => {
    const data = await loadContactBrief(db, booked.id);
    if (!data) return;
    const brief = renderPrepBrief(data, { code: meeting.code, starts_at: meeting.starts_at, ends_at: meeting.ends_at, attribution: meeting.attribution }, now);
    result.brief = brief;
    const deal = await dealFor(db, booked.id, booked.account_key);
    result.dealId = deal?.id ?? null;
    const trigger = `meeting_booked:${meeting.code}`;
    if (deal) {
      const stored = await db.prepare("SELECT id FROM deal_handoffs WHERE deal_id = ?1 AND trigger = ?2").bind(deal.id, trigger).first<{ id: string }>();
      if (!stored) {
        await db
          .prepare("INSERT INTO deal_handoffs (id, deal_id, trigger, brief_markdown, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)")
          .bind(`ho_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, deal.id, trigger, brief, now.toISOString())
          .run();
      }
    }
    if (deps.quiet || !deps.operator) return;
    const past = Date.parse(meeting.ends_at) < now.getTime();
    // The notice is an effect outside the database: a failure throws, the claim is released, and
    // the next sync sends it.
    await deps.operator.notify({ text: bookingNotice(displayName(booked), meeting, brief, past), ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    if (deal) await db.prepare("UPDATE deal_handoffs SET notified_at = ?3 WHERE deal_id = ?1 AND trigger = ?2").bind(deal.id, trigger, now.toISOString()).run();
  });

  await step("lifecycle", () => recordMeetingBooked({ db, now }, [booked, ...others].map((c) => ({ contactId: c.id, key: bookedKey(meeting.code, c.id), at: meeting.first_seen_at }))));

  if (result.failed.length === 0) {
    try {
      await claimEffect(db, key, DONE);
      result.complete = true;
    } catch (error) {
      log.warn("a booked meeting could not be marked done; the next sync checks it again", { code: meeting.code, error: sanitizeErrorMessage(error) });
    }
  }
  if (!result.dealId) {
    try {
      result.dealId = (await dealFor(db, booked.id, booked.account_key))?.id ?? null;
    } catch {
      // The deal id only labels drafts.
    }
  }
  return result;
}

/** The effects-ledger event id that records a credit withdrawal still to do. The effect is the meeting's first sighting. */
export const withdrawPendingKey = (code: string, contactId: string): string => `calendar-withdraw:${code}:${contactId}`;
const WITHDRAW_PREFIX = "calendar-withdraw:";

interface WithdrawMeeting {
  event_id: string;
  code: string;
  contact_id: string;
  first_seen_at: string;
}

/** Take back the credit and release its claims. True when nothing is left to do. Never throws. */
async function withdrawCredit(deps: Pick<BookedDeps, "db" | "log">, meeting: WithdrawMeeting): Promise<boolean> {
  const { db, log } = deps;
  const key = bookedKey(meeting.code, meeting.contact_id);
  try {
    if (!(await hasEffect(db, key, stepEffect("credit")))) return true;
    const changed = await withdrawMeetingCredit(db, meeting.contact_id, meeting);
    // A claim left behind would stop a meeting that counts again from being credited again.
    const released = (await releaseEffect(db, key, stepEffect("credit"))) && (await releaseEffect(db, key, DONE));
    if (!released) throw new Error("the credit claim could not be released");
    log.info("a meeting's credit was withdrawn", { code: meeting.code, ledgerChanged: changed });
    return true;
  } catch (error) {
    log.warn("a meeting's credit could not be withdrawn; the next calendar sync retries it", { code: meeting.code, error: sanitizeErrorMessage(error) });
    return false;
  }
}

/**
 * Take back a meeting's ledger credit after it stopped counting. Run it after the meeting row was
 * cancelled or deleted. The withdrawal is recorded first and cleared once it worked, so one that
 * fails is retried by retryCreditWithdrawals. True when it is done now. Never throws.
 */
export async function withdrawBooked(deps: Pick<BookedDeps, "db" | "log" | "now">, meeting: WithdrawMeeting): Promise<boolean> {
  const { db, log } = deps;
  const pending = withdrawPendingKey(meeting.code, meeting.contact_id);
  let recorded = false;
  try {
    await claimEffect(db, pending, meeting.first_seen_at);
    recorded = true;
  } catch (error) {
    log.warn("a credit withdrawal could not be recorded for retry; trying it now", { code: meeting.code, error: sanitizeErrorMessage(error) });
  }
  const done = await withdrawCredit(deps, meeting);
  if (done && recorded) await releaseEffect(db, pending, meeting.first_seen_at);
  return done;
}

/**
 * Retry the credit withdrawals that failed earlier, oldest first, at most `limit`. A meeting that
 * counts again (attributed, not cancelled) keeps its credit and its record is cleared. Returns how
 * many were finished. Throws only when the records cannot be read.
 */
export async function retryCreditWithdrawals(deps: Pick<BookedDeps, "db" | "log" | "now">, limit: number): Promise<number> {
  const { db } = deps;
  const { results } = await db
    .prepare("SELECT event_id, effect FROM event_effects WHERE event_id >= ?1 AND event_id < ?2 ORDER BY created_at LIMIT ?3")
    .bind(WITHDRAW_PREFIX, `${WITHDRAW_PREFIX.slice(0, -1)};`, limit)
    .all<{ event_id: string; effect: string }>();
  let finished = 0;
  for (const row of results) {
    const rest = row.event_id.slice(WITHDRAW_PREFIX.length);
    const split = rest.indexOf(":");
    if (split < 1) continue;
    const code = rest.slice(0, split);
    const contactId = rest.slice(split + 1);
    try {
      const current = await db
        .prepare(
          `SELECT ce.event_id, ce.state, cm.status FROM calendar_events ce
             LEFT JOIN calendar_meetings cm ON cm.event_id = ce.event_id AND cm.contact_id = ?2
            WHERE ce.code = ?1`,
        )
        .bind(code, contactId)
        .first<{ event_id: string; state: string; status: string | null }>();
      const countsAgain = current?.state === "attributed" && current.status !== null && current.status !== "cancelled";
      // Counting again: its credit may have gone with a withdrawal that half worked, so its credit
      // claim is released and the next sync's booked effects credit it again (crediting is
      // idempotent: the earliest sighting wins).
      const key = bookedKey(code, contactId);
      const done = countsAgain
        ? (await releaseEffect(db, key, stepEffect("credit"))) && (await releaseEffect(db, key, DONE))
        : await withdrawCredit(deps, { event_id: current?.event_id ?? "", code, contact_id: contactId, first_seen_at: row.effect });
      if (done && (await releaseEffect(db, row.event_id, row.effect))) finished += 1;
    } catch (error) {
      deps.log.warn("a credit withdrawal retry failed; the next calendar sync tries again", { code, error: sanitizeErrorMessage(error) });
    }
  }
  return finished;
}
