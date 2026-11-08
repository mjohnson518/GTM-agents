// GTM-agents: whether the reply check in front of every follow-up can see replies at all.
//
// The reply check reads inbound_emails, so "no inbound mail" only means "nobody replied" while the
// inbox is recording. This gate runs before the sweep sends or drafts anything and before a release
// sends: it passes only when inbox:enabled is on and intake is current. With poll intake (the
// default, sequences:reply_intake unset or "poll") the newest inbox_poll run must have completed
// within SEQUENCE_LIMITS.intakeFreshMinutes and actually listed the mailbox (its summary starts with
// POLL_LISTED_MARK). A failed, skipped (halted, flag off), mailbox-less or missing poll holds every step, so a step never goes out on replies that arrived while the poll was stopped and
// have not been recorded yet. With "routed" intake (Cloudflare Email Routing only, recorded as it
// arrives) inbox:enabled alone is enough.
//
// It fails closed: an unreadable flag, an unknown intake value or a database error holds the steps.
import { INBOX_POLL_JOB, POLL_LISTED_MARK } from "../inbox/jobs.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { SEQUENCE_FLAGS, SEQUENCE_LIMITS } from "./flags.ts";

/** The job whose runs show that poll intake is current. */
export const INTAKE_POLL_JOB = INBOX_POLL_JOB;
const INBOX_ENABLED = "inbox:enabled";

export type IntakeVerdict = { ok: true } | { ok: false; reason: string };

export async function checkReplyIntake(db: D1Database, flags: FlagReader, now: Date): Promise<IntakeVerdict> {
  let enabled: string | null;
  let mode: string | null;
  try {
    [enabled, mode] = await Promise.all([flags.get(INBOX_ENABLED), flags.get(SEQUENCE_FLAGS.replyIntake)]);
  } catch {
    return { ok: false, reason: "the inbox flags could not be read, so replies may be going unseen" };
  }
  if (enabled?.trim().toLowerCase() !== "true") return { ok: false, reason: "inbox:enabled is off, so replies are not being recorded and the reply check would be blind" };
  const intake = (mode ?? "poll").trim().toLowerCase();
  if (intake === "routed") return { ok: true };
  if (intake !== "poll") return { ok: false, reason: `sequences:reply_intake is "${intake.slice(0, 20)}", which is neither poll nor routed` };
  // The newest finished run: one still running says nothing yet, and must not hold a sweep that
  // happens to fire in the same minute.
  let latest: { status: string; finished_at: string | null; summary: string | null } | null;
  try {
    latest = await db
      .prepare("SELECT status, finished_at, summary FROM execution_runs WHERE task_name = ?1 AND status <> 'running' ORDER BY started_at DESC LIMIT 1")
      .bind(INTAKE_POLL_JOB)
      .first<{ status: string; finished_at: string | null; summary: string | null }>();
  } catch {
    return { ok: false, reason: "the inbox poll's runs could not be read, so replies may be going unseen" };
  }
  if (!latest) return { ok: false, reason: "the inbox poll has never run, so replies are not being recorded" };
  if (latest.status !== "completed") return { ok: false, reason: `the latest inbox poll was ${latest.status}, so recent replies may not be recorded yet` };
  if (!(latest.summary ?? "").startsWith(POLL_LISTED_MARK)) {
    return { ok: false, reason: "the latest inbox poll did not list the mailbox and record everything it saw (no mailbox, a missing secret, or a message it could not record)" };
  }
  const finished = latest.finished_at ? Date.parse(latest.finished_at) : Number.NaN;
  if (!(now.getTime() - finished <= SEQUENCE_LIMITS.intakeFreshMinutes * 60_000)) {
    return { ok: false, reason: `the inbox poll last completed more than ${SEQUENCE_LIMITS.intakeFreshMinutes} minutes ago, so recent replies may not be recorded yet` };
  }
  return { ok: true };
}
