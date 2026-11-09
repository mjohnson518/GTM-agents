// GTM-agents: autonomy evidence: one row in autonomy_events for every decision about an action of a
// class, which the promotion review reads.
//
// The outcomes:
//   - approved_unchanged: a person approved it as the system wrote it;
//   - approved_edited: a person approved it after changing it;
//   - rejected: a person turned it down;
//   - auto_sent: it went out on its own, under an earned level or the operator's auto-approve switch;
//   - incident: harm after an automatic action (a hard bounce, a complaint, an unsubscribe), or a
//     delivery rate the class's automatic sends pushed over a limit (incidents.ts).
// Who writes what:
//   - the cold batch: approved_unchanged when a person releases a batch (one decision per batch,
//     written once), auto_sent when a batch goes out on its own (outreach/send.ts);
//   - the follow-up sweep and sequence-release: the same, under cold_batch;
//   - replies: approved_unchanged or approved_edited when an approved reply is sent, from chat or
//     from the mailbox, rejected when it is turned down, auto_sent when it went out automatically
//     (replies/evidence.ts);
//   - meeting drafts (the recap, the rebook and the post-demo follow-ups): approved_unchanged when
//     approved in chat, rejected when rejected there (recordDraftDecision, from the approval tap);
//   - incidents.ts: incident.
// Writing evidence is bookkeeping: it never throws, and a lost row never changes what was sent.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import { draftDigest } from "../security/approval-digest.ts";
import { DAY_MS } from "../metrics/window.ts";
import { EARNABLE_ACTION_CLASSES, type ActionClass } from "./levels.ts";

export const AUTONOMY_OUTCOMES = ["approved_unchanged", "approved_edited", "rejected", "auto_sent", "incident"] as const;
export type AutonomyOutcome = (typeof AUTONOMY_OUTCOMES)[number];

/** Days of evidence the promotion review and autonomy-status read. */
export const EVIDENCE_WINDOW_DAYS = 60;
/** Days an incident blocks a first promotion. */
export const RECENT_INCIDENT_DAYS = 30;

export interface EvidenceInput {
  actionClass: ActionClass;
  outcome: AutonomyOutcome;
  subjectId?: string | null;
  detail?: string;
  now: Date;
}

const newId = () => `ae_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** The insert for one evidence row, for callers that write it in a batch with other statements. */
export function evidenceStatement(db: D1Database, input: EvidenceInput): D1PreparedStatement {
  return db
    .prepare("INSERT INTO autonomy_events (id, action_class, outcome, subject_id, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(newId(), input.actionClass, input.outcome, input.subjectId ?? null, (input.detail ?? "").slice(0, 500) || null, input.now.toISOString());
}

/** Write one evidence row. True when it was written. Never throws. */
export async function recordAutonomyEvidence(db: D1Database, input: EvidenceInput): Promise<boolean> {
  try {
    await evidenceStatement(db, input).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one evidence row once per `onceKey` (claimed in the effects ledger). True when a row was
 * written now. A claim that cannot be taken writes nothing; a row that cannot be written releases
 * its claim, so a later decision on the same subject can still be recorded. Never throws.
 */
export async function recordAutonomyEvidenceOnce(db: D1Database, onceKey: string, input: EvidenceInput): Promise<boolean> {
  try {
    if (!(await claimEffect(db, onceKey, "autonomy_evidence"))) return false;
  } catch {
    return false;
  }
  if (await recordAutonomyEvidence(db, input)) return true;
  await releaseEffect(db, onceKey, "autonomy_evidence");
  return false;
}

/** The classes a person's decision on a chat-approved draft counts toward: the meeting drafts. */
const DRAFT_DECISION_CLASSES: ReadonlySet<string> = new Set<ActionClass>(["post_meeting_followup", "rebook"]);

/**
 * Record a person's approve or reject tap on a draft, for the classes whose drafts are decided in
 * chat and sent by hand (the meeting drafts). Reply drafts record their evidence when they are sent
 * or rejected (replies/evidence.ts) and are skipped here, as are drafts with no earnable class.
 * Approval in chat cannot change the text (an edit returns a draft to review), so an approval is
 * approved_unchanged. Once per draft content and decision. Never throws.
 */
export async function recordDraftDecision(db: D1Database, draftId: string, decision: "approved" | "rejected", now: Date): Promise<void> {
  try {
    const row = await db
      .prepare("SELECT id, kind, action_class, recipient_email, subject, body FROM drafts WHERE id = ?1")
      .bind(draftId)
      .first<{ id: string; kind: string; action_class: string | null; recipient_email: string | null; subject: string | null; body: string | null }>();
    if (!row || row.kind === "reply" || !row.action_class || !DRAFT_DECISION_CLASSES.has(row.action_class)) return;
    const digest = await draftDigest({ to: row.recipient_email, subject: row.subject, body: row.body });
    await recordAutonomyEvidenceOnce(db, `draft_decision:${row.id}:${digest.slice(0, 16)}`, {
      actionClass: row.action_class as ActionClass,
      outcome: decision === "approved" ? "approved_unchanged" : "rejected",
      subjectId: row.id,
      detail: decision === "approved" ? "approved in chat" : "rejected in chat",
      now,
    });
  } catch {
    // Bookkeeping: a lost decision never changes the draft.
  }
}

/** What the evidence says about one class over the window. */
export interface ClassEvidence {
  actionClass: string;
  approvedUnchanged: number;
  approvedEdited: number;
  rejected: number;
  autoSent: number;
  /** Incidents in the last RECENT_INCIDENT_DAYS. */
  incidentsRecent: number;
  /** Incidents in the whole window. */
  incidents: number;
  /** When the latest incident in the window was recorded. */
  lastIncidentAt: string | null;
}

export const emptyEvidence = (actionClass: string): ClassEvidence => ({ actionClass, approvedUnchanged: 0, approvedEdited: 0, rejected: 0, autoSent: 0, incidentsRecent: 0, incidents: 0, lastIncidentAt: null });

/** Decisions a person made: approvals, edited or not, and rejections. */
export const decisionsOf = (e: ClassEvidence): number => e.approvedUnchanged + e.approvedEdited + e.rejected;

/**
 * Evidence per class over the EVIDENCE_WINDOW_DAYS before `now`, every earnable class included
 * (with zeros when it has none). Throws on a database error.
 */
export async function loadEvidence(db: D1Database, now: Date): Promise<Map<string, ClassEvidence>> {
  const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString();
  const recent = new Date(now.getTime() - RECENT_INCIDENT_DAYS * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT action_class, outcome, COUNT(*) AS n,
              SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS recent,
              MAX(created_at) AS last_at
         FROM autonomy_events
        WHERE created_at >= ?1 AND created_at <= ?3
        GROUP BY action_class, outcome`,
    )
    .bind(since, recent, now.toISOString())
    .all<{ action_class: string; outcome: string; n: number; recent: number | null; last_at: string | null }>();
  const out = new Map<string, ClassEvidence>(EARNABLE_ACTION_CLASSES.map((c) => [c, emptyEvidence(c)]));
  for (const r of results) {
    const e = out.get(r.action_class) ?? emptyEvidence(r.action_class);
    const n = Number(r.n) || 0;
    if (r.outcome === "approved_unchanged") e.approvedUnchanged = n;
    else if (r.outcome === "approved_edited") e.approvedEdited = n;
    else if (r.outcome === "rejected") e.rejected = n;
    else if (r.outcome === "auto_sent") e.autoSent = n;
    else if (r.outcome === "incident") {
      e.incidents = n;
      e.incidentsRecent = Number(r.recent) || 0;
      e.lastIncidentAt = r.last_at;
    }
    out.set(r.action_class, e);
  }
  return out;
}

/** One line: "12 approved as written, 1 edited, 0 rejected, 4 sent automatically, 0 incidents (60 days)". */
export function evidenceLine(e: ClassEvidence): string {
  return `${e.approvedUnchanged} approved as written, ${e.approvedEdited} edited, ${e.rejected} rejected, ${e.autoSent} sent automatically, ${e.incidents} incidents (${EVIDENCE_WINDOW_DAYS} days)`;
}
