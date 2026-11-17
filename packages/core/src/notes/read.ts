// GTM-agents: reading what calls produced, for your briefs and recap drafts (docs/MEETING-NOTES.md).
//
// Only processed meetings from a meeting-notes tool are read (external_id not calendar:, which marks
// your own notes), so text from a call never poses as your notes. Every item is a quote found word
// for word in the transcript; it is still the prospect's text, so a brief labels it as theirs and a
// recap that carries it waits for your review.
import { NOTES_LIMITS } from "./flags.ts";

export const CALL_NOTES_HEADING = "From call recordings (their words, checked against the transcript)";

export interface CallNotes {
  occurred_at: string | null;
  pain_points: string[];
  objections: string[];
  next_steps: Array<{ quote: string; owner: "us" | "them" }>;
}

function list(raw: unknown): string[] {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch {
    return [];
  }
}

function steps(raw: unknown): CallNotes["next_steps"] {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    if (!Array.isArray(value)) return [];
    return value.flatMap((v: { quote?: unknown; owner?: unknown }) => (typeof v?.quote === "string" && (v.owner === "us" || v.owner === "them") ? [{ quote: v.quote, owner: v.owner }] : []));
  } catch {
    return [];
  }
}

interface Row {
  occurred_at: string | null;
  pain_points: string | null;
  objections: string | null;
  next_steps: string | null;
}

const fromRow = (r: Row): CallNotes => ({ occurred_at: r.occurred_at, pain_points: list(r.pain_points), objections: list(r.objections), next_steps: steps(r.next_steps) });

/** The SQL a brief batches: the contact's last processed recordings. ?1 is the contact id. */
export const CALL_NOTES_SQL = `SELECT occurred_at, pain_points, objections, next_steps FROM meetings
  WHERE contact_id = ?1 AND processed_at IS NOT NULL AND external_id IS NOT NULL AND external_id NOT LIKE 'calendar:%'
  ORDER BY occurred_at DESC LIMIT ${NOTES_LIMITS.briefMeetings}`;

export function callNotesFromRows(rows: readonly unknown[]): CallNotes[] {
  return (rows as Row[]).map(fromRow).filter((c) => c.pain_points.length + c.objections.length + c.next_steps.length > 0);
}

/** The contact's last processed recordings that produced anything. */
export async function loadCallNotes(db: D1Database, contactId: string): Promise<CallNotes[]> {
  const { results } = await db.prepare(CALL_NOTES_SQL).bind(contactId).all<Row>();
  return callNotesFromRows(results);
}

/**
 * Next steps agreed on the recorded call for a calendar meeting: the contact's processed recording
 * that started within 30 minutes of it, at most NOTES_LIMITS.recapNextSteps. Empty when there is none.
 */
export async function recapNextSteps(db: D1Database, contactId: string, meetingStart: string): Promise<string[]> {
  const started = Date.parse(meetingStart);
  if (!Number.isFinite(started)) return [];
  const window = NOTES_LIMITS.matchWindowMinutes * 60_000;
  const row = await db
    .prepare(
      `SELECT next_steps FROM meetings
        WHERE contact_id = ?1 AND processed_at IS NOT NULL AND external_id IS NOT NULL AND external_id NOT LIKE 'calendar:%'
          AND occurred_at >= ?2 AND occurred_at <= ?3
        ORDER BY occurred_at DESC LIMIT 1`,
    )
    .bind(contactId, new Date(started - window).toISOString(), new Date(started + window).toISOString())
    .first<{ next_steps: string | null }>();
  return steps(row?.next_steps ?? null)
    .map((s) => s.quote)
    .slice(0, NOTES_LIMITS.recapNextSteps);
}
