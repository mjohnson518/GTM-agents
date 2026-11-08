// GTM-agents: the sequence state on a campaign contact row, and the two writes everything else uses
// to change it.
//
// A cold sequence lives on its campaign_contacts row: sequence_step, sequence_active, next_send_at,
// sequence_paused_at and sequence_pause_reason. Anything that learns a sequence must end (a reply,
// an opt-out, a hard bounce, a booked meeting) calls stopSequences; anything that learns it must
// wait (an out-of-office reply with a return date) calls holdSequences. Both are bookkeeping: the
// follow-up sweep re-checks replies, suppression and warmth itself before every step, so a stop or
// hold that fails to write never lets a step through. Callers catch and log their errors.
//
// SEQUENCE_STOPPING_CLASSIFICATIONS is the contract between reply detection (which writes
// inbound_emails) and the sweep (which reads it): mail with one of these classifications, or none
// yet, from the contact or anyone at the same account stops the sequence.

/** Inbound classifications that stop a sequence. Mail not yet classified (NULL) stops it too. */
export const SEQUENCE_STOPPING_CLASSIFICATIONS = ["reply", "new_inquiry", "unsubscribe", "unclassified"] as const;

/** The campaign row status a stop leaves behind. Rows already past "sent" keep their status. */
export type SequenceStopStatus = "replied" | "opted_out" | "bounced" | "converted";

export interface SequenceScope {
  /** Stop or hold these contacts' sequences. */
  contactIds?: readonly string[];
  /** And every contact at this account (the lowercased registrable domain). */
  accountKey?: string;
}

const scopeSql = (scope: SequenceScope, contactsParam: string, accountParam: string): string => {
  const parts: string[] = [];
  if (scope.contactIds && scope.contactIds.length > 0) parts.push(`contact_id IN (SELECT value FROM json_each(${contactsParam}))`);
  if (scope.accountKey) parts.push(`contact_id IN (SELECT id FROM contacts WHERE account_key = ${accountParam})`);
  return parts.length > 0 ? `(${parts.join(" OR ")})` : "0";
};

const hasScope = (scope: SequenceScope) => (scope.contactIds?.length ?? 0) > 0 || Boolean(scope.accountKey);

/**
 * End the sequences in scope: rows go inactive with no next send, keep the first pause time and
 * reason, and move from pending, sent or skipped to `status`; running sequence runs are cancelled.
 * Idempotent. Throws on a database error (the caller logs it; the sweep re-checks before sending).
 * Returns the number of campaign rows it stopped.
 */
export async function stopSequences(db: D1Database, scope: SequenceScope, stop: { reason: string; status: SequenceStopStatus; now: Date }): Promise<number> {
  if (!hasScope(scope)) return 0;
  const at = stop.now.toISOString();
  const ids = JSON.stringify(scope.contactIds ?? []);
  const account = scope.accountKey ?? null;
  const [rows] = await db.batch([
    db
      .prepare(
        `UPDATE campaign_contacts
            SET sequence_active = 0, next_send_at = NULL,
                sequence_paused_at = COALESCE(sequence_paused_at, ?3), sequence_pause_reason = COALESCE(sequence_pause_reason, ?4),
                status = CASE WHEN status IN ('pending', 'sent', 'skipped') THEN ?5 ELSE status END, updated_at = ?3
          WHERE ${scopeSql(scope, "?1", "?2")} AND (sequence_active = 1 OR status IN ('pending', 'sent', 'skipped'))`,
      )
      .bind(ids, account, at, stop.reason.slice(0, 200), stop.status),
    db
      .prepare(
        `UPDATE outreach_sequence_runs SET status = 'cancelled', exit_reason = ?4, completed_at = ?3, last_event_at = ?3
          WHERE ${scopeSql(scope, "?1", "?2")} AND status IN ('running', 'awaiting_decision')`,
      )
      .bind(ids, account, at, stop.reason.slice(0, 200)),
  ]);
  return rows?.meta.changes ?? 0;
}

/**
 * Hold the active sequences in scope until `until`: the next step is due no earlier than that
 * time. A hold never brings a step forward and never wakes a stopped sequence. Throws on a database
 * error. Returns the number of rows it moved.
 */
export async function holdSequences(db: D1Database, scope: SequenceScope, hold: { until: Date; reason: string; now: Date }): Promise<number> {
  if (!hasScope(scope)) return 0;
  const until = hold.until.toISOString();
  const result = await db
    .prepare(
      `UPDATE campaign_contacts
          SET next_send_at = ?3, sequence_pause_reason = ?4, updated_at = ?5
        WHERE ${scopeSql(scope, "?1", "?2")} AND sequence_active = 1 AND (next_send_at IS NULL OR next_send_at < ?3)`,
    )
    .bind(JSON.stringify(scope.contactIds ?? []), scope.accountKey ?? null, until, hold.reason.slice(0, 200), hold.now.toISOString())
    .run();
  return result.meta.changes ?? 0;
}

// The writes the follow-up sweep and the operator's sequence commands make to one row. A paused row
// (sequence_paused_at set while sequence_active stays 1) is skipped by the sweep until an operator
// resumes it; an ended or stopped row (sequence_active 0) is never woken again. The statement
// builders return prepared statements, so the sweep can write many rows in one batch.

/** One campaign contact row. */
export interface SequenceRowKey {
  campaignId: string;
  contactId: string;
}

/** The pause reason a finished sequence carries: its last step went out, or no step is left. */
export const EXHAUSTED_REASON = "exhausted";

/**
 * End one active sequence for a reason that is not a stop status (person fit, a job move, the last
 * step sent): the row goes inactive with no next send and keeps its campaign status.
 */
export function endSequenceStatement(db: D1Database, row: SequenceRowKey, end: { reason: string; now: Date }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE campaign_contacts SET sequence_active = 0, next_send_at = NULL, sequence_pause_reason = ?3, updated_at = ?4
        WHERE campaign_id = ?1 AND contact_id = ?2 AND sequence_active = 1`,
    )
    .bind(row.campaignId, row.contactId, end.reason.slice(0, 200), end.now.toISOString());
}

/**
 * Pause one active sequence until an operator resumes it (resumeSequences). A row already paused
 * keeps its first pause time and reason.
 */
export function pauseSequenceStatement(db: D1Database, row: SequenceRowKey, pause: { reason: string; now: Date }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE campaign_contacts SET sequence_paused_at = ?3, sequence_pause_reason = ?4, updated_at = ?3
        WHERE campaign_id = ?1 AND contact_id = ?2 AND sequence_active = 1 AND sequence_paused_at IS NULL`,
    )
    .bind(row.campaignId, row.contactId, pause.now.toISOString(), pause.reason.slice(0, 200));
}

/**
 * Record that `step` went out: the row moves to that step and is due again at `nextAt`, or, with
 * nextAt null, the sequence is finished (inactive, reason EXHAUSTED_REASON). The step never moves
 * backwards, and a sequence stopped in the meantime is left alone.
 */
export function advanceSequenceStatement(db: D1Database, row: SequenceRowKey, advance: { step: number; nextAt: string | null; now: Date }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE campaign_contacts
          SET sequence_step = MAX(COALESCE(sequence_step, 0), ?3),
              sequence_active = CASE WHEN ?4 IS NULL THEN 0 ELSE 1 END,
              next_send_at = ?4,
              sequence_pause_reason = CASE WHEN ?4 IS NULL THEN ?6 ELSE sequence_pause_reason END,
              updated_at = ?5
        WHERE campaign_id = ?1 AND contact_id = ?2 AND sequence_active = 1 AND COALESCE(sequence_step, 0) <= ?3`,
    )
    .bind(row.campaignId, row.contactId, advance.step, advance.nextAt, advance.now.toISOString(), EXHAUSTED_REASON);
}

/** Make an active row due at `until` instead (a deferral, a wait for a manual touch). */
export function rescheduleSequenceStatement(db: D1Database, row: SequenceRowKey, reschedule: { until: string; now: Date }): D1PreparedStatement {
  return db
    .prepare("UPDATE campaign_contacts SET next_send_at = ?3, updated_at = ?4 WHERE campaign_id = ?1 AND contact_id = ?2 AND sequence_active = 1")
    .bind(row.campaignId, row.contactId, reschedule.until, reschedule.now.toISOString());
}

/**
 * Resume a contact's paused sequences: the pause is cleared and the next step is due no earlier than
 * now. Stopped and ended sequences are never woken. Every check runs again before the step goes.
 * Throws on a database error. Returns the number of rows resumed.
 */
export async function resumeSequences(db: D1Database, contactId: string, resume: { now: Date }): Promise<number> {
  const at = resume.now.toISOString();
  const result = await db
    .prepare(
      `UPDATE campaign_contacts
          SET sequence_paused_at = NULL, sequence_pause_reason = NULL,
              next_send_at = CASE WHEN next_send_at IS NULL OR next_send_at < ?2 THEN ?2 ELSE next_send_at END, updated_at = ?2
        WHERE contact_id = ?1 AND sequence_active = 1 AND sequence_paused_at IS NOT NULL`,
    )
    .bind(contactId, at)
    .run();
  return result.meta.changes ?? 0;
}
