// GTM-agents: handing approved steps to the send function, and what each outcome does to the row.
//
// Every step goes out on path "sequence" under its idempotency key, threaded (In-Reply-To and
// References), with the draft id and its approved digest, so the send function re-checks the
// approval against the content it is about to send. The send function runs every boundary check
// itself and claims the key in the effects ledger right before sending, so a step is never sent
// twice, whoever retries.
//
// What happens to the row, per outcome (each write is bookkeeping: it is logged and dropped on
// failure, and the next sweep reconciles the row from the send ledger):
//   - sent: the row moves to that step and is due again after the next step's delay, or the
//     sequence is finished after the last step;
//   - duplicate (the key was already claimed: sent before, or an attempt whose acceptance was
//     unclear): treated as sent, so it is never sent again;
//   - deferred (a send window, a cap, the kill switch, the breaker): the row is due again at the time
//     the send function named. Nothing is put in the deferred queue, so every check here runs again;
//   - blocked as suppressed, undeliverable or unparseable: the sequence ends. Any other refusal
//     (the content lint, an approval mismatch, an invalid item) pauses the contact's sequence;
//   - failed and retryable (delivery off, a missing secret, a state that could not be read): the row
//     stays due and the next sweep tries again;
// Right before the send function is called, the reply check and the row's state are read again for
// every step (the sweep's checks and its provider calls take time): a step whose account wrote in,
// or whose row stopped, paused or moved on meanwhile, is withheld; if either read fails, nothing is
// sent and every step stays due.
//   - failed and not retryable (the provider refused it, or it is unclear whether it was accepted),
//     or no outcome at all: the contact's sequence pauses until an operator resumes it.
import type { JobLogger } from "../jobs/registry.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { runWrites } from "../sending/ledger.ts";
import { contactsWithReplies } from "./checks.ts";
import { SEQUENCE_LIMITS } from "./flags.ts";
import { keyOf, loadRows, rowKey } from "./rows.ts";
import type { OutreachItem, OutreachOutcome, SendOutreach } from "../sending/types.ts";
import { advanceSequenceStatement, endSequenceStatement, pauseSequenceStatement, rescheduleSequenceStatement, type SequenceRowKey } from "./state.ts";
import type { Thread } from "./threading.ts";

const DAY_MS = 86_400_000;

export interface ReadyStep {
  row: SequenceRowKey;
  step: number;
  /** Days until the step after this one, or null when this is the last step. */
  nextDelayDays: number | null;
  idempotencyKey: string;
  draft: {
    id: string;
    to: string;
    toName: string | null;
    subject: string;
    body: string;
    templateId: string | null;
    approvedDigest: string;
    /** Measurement bookkeeping from the draft: the template file's SHA-256 and the send's cohort. */
    templateSha256?: string | null;
    cohort?: string | null;
  };
  thread: Thread;
}

export interface StepChange {
  row: SequenceRowKey;
  step: number;
  /** For an operator message: what happened to the row and why. */
  reason: string;
}

export interface SendReport {
  submitted: number;
  sent: number;
  duplicate: number;
  deferred: number;
  blocked: number;
  /** Failed and retryable: the row stays due. */
  retry: number;
  failed: number;
  /** Withheld by the last check before sending: mail from the account, or the row changed. */
  withheld: number;
  paused: StepChange[];
  ended: StepChange[];
  outcomes: Map<string, OutreachOutcome>;
}

export interface SendStepsDeps {
  db: D1Database;
  send: SendOutreach;
  now: Date;
  log?: JobLogger;
}

const END_REFUSALS = new Set(["suppressed", "undeliverable", "unparseable"]);

export function toItem(step: ReadyStep): OutreachItem {
  return {
    idempotencyKey: step.idempotencyKey,
    path: "sequence",
    contactId: step.row.contactId,
    to: step.draft.to,
    ...(step.draft.toName ? { toName: step.draft.toName } : {}),
    subject: step.draft.subject,
    body: step.draft.body,
    draftId: step.draft.id,
    campaignId: step.row.campaignId,
    ...(step.draft.templateId ? { templateId: step.draft.templateId } : {}),
    sequenceStep: step.step,
    inReplyTo: step.thread.inReplyTo,
    references: step.thread.references,
    approvedDigest: step.draft.approvedDigest,
    ...(step.draft.templateSha256 ? { templateSha256: step.draft.templateSha256 } : {}),
    ...(step.draft.cohort ? { cohort: step.draft.cohort } : {}),
  };
}

/** The statement that records a step as gone out at `at`. */
export function advanceAfter(db: D1Database, row: SequenceRowKey, step: number, nextDelayDays: number | null, at: Date, now: Date): D1PreparedStatement {
  return advanceSequenceStatement(db, row, { step, nextAt: nextDelayDays === null ? null : new Date(at.getTime() + nextDelayDays * DAY_MS).toISOString(), now });
}

/** Send ready steps once each and record what happened to each row. Never throws. */
export async function sendSteps(deps: SendStepsDeps, ready: readonly ReadyStep[]): Promise<SendReport> {
  let steps = ready;
  const report: SendReport = { submitted: 0, sent: 0, duplicate: 0, deferred: 0, blocked: 0, retry: 0, failed: 0, withheld: 0, paused: [], ended: [], outcomes: new Map() };
  if (steps.length === 0) return report;
  const { db, now } = deps;
  // The last check before sending. A read error sends nothing; every step stays due.
  try {
    const rows = new Map((await loadRows(db, steps.map((s) => s.row))).map((r) => [rowKey(keyOf(r)), r]));
    const replied = await contactsWithReplies(db, [...rows.values()], new Date(now.getTime() - SEQUENCE_LIMITS.replyLookbackDays * DAY_MS));
    const kept = steps.filter((s) => {
      const r = rows.get(rowKey(s.row));
      return r !== undefined && r.sequence_active === 1 && r.sequence_paused_at === null && (r.sequence_step ?? 0) + 1 === s.step && !replied.has(r.contact_id);
    });
    report.withheld = steps.length - kept.length;
    steps = kept;
  } catch (error) {
    deps.log?.warn("the last check before sending could not be read; nothing was sent and the steps stay due", { error: sanitizeErrorMessage(error) });
    report.withheld = steps.length;
    return report;
  }
  if (steps.length === 0) return report;
  const items = steps.map(toItem);
  report.submitted = items.length;
  let outcomes: OutreachOutcome[] = [];
  let threw = false;
  try {
    outcomes = await deps.send(items);
  } catch (error) {
    threw = true;
    deps.log?.error("the send function threw; the steps it was given pause until an operator checks the send ledger", { error: sanitizeErrorMessage(error) });
  }
  const byKey = new Map((Array.isArray(outcomes) ? outcomes : []).filter((o) => o && typeof o.idempotencyKey === "string").map((o) => [o.idempotencyKey, o]));
  const statements: D1PreparedStatement[] = [];
  const pause = (s: ReadyStep, reason: string) => {
    report.paused.push({ row: s.row, step: s.step, reason });
    statements.push(pauseSequenceStatement(db, s.row, { reason, now }));
  };
  const end = (s: ReadyStep, reason: string) => {
    report.ended.push({ row: s.row, step: s.step, reason });
    statements.push(endSequenceStatement(db, s.row, { reason, now }));
  };
  for (const s of steps) {
    const outcome = threw ? undefined : byKey.get(s.idempotencyKey);
    if (!outcome) {
      report.failed++;
      pause(s, threw ? "the send function failed, so it is unclear whether the step went out; check the send ledger before resuming" : "the send function returned no outcome for the step; check the send ledger before resuming");
      continue;
    }
    report.outcomes.set(s.idempotencyKey, outcome);
    switch (outcome.status) {
      case "sent":
        report.sent++;
        statements.push(advanceAfter(db, s.row, s.step, s.nextDelayDays, now, now));
        break;
      case "duplicate":
        report.duplicate++;
        statements.push(advanceAfter(db, s.row, s.step, s.nextDelayDays, now, now));
        break;
      case "deferred":
        report.deferred++;
        statements.push(rescheduleSequenceStatement(db, s.row, { until: outcome.nextAttemptAt, now }));
        break;
      case "blocked":
        report.blocked++;
        if (END_REFUSALS.has(outcome.reason)) end(s, outcome.message);
        else pause(s, outcome.message);
        break;
      case "failed":
        if (outcome.retryable) report.retry++;
        else {
          report.failed++;
          pause(s, outcome.message);
        }
        break;
    }
  }
  const written = await runWrites(db, statements);
  const lost = written.filter((ok) => !ok).length;
  if (lost > 0) deps.log?.warn("some sequence rows could not be updated after sending; the next sweep reconciles them from the send ledger", { lost });
  return report;
}

/** One line for operator messages. */
export function sendLine(report: SendReport): string {
  const parts = [`${report.sent} sent`, `${report.deferred} waiting for a send window or a cap`, `${report.blocked} refused`, `${report.failed} failed`];
  if (report.duplicate) parts.push(`${report.duplicate} already sent`);
  if (report.retry) parts.push(`${report.retry} to retry`);
  if (report.withheld) parts.push(`${report.withheld} withheld by the last check (mail from the account, or the sequence changed)`);
  return parts.join(", ");
}
