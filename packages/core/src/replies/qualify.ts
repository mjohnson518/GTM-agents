// GTM-agents: the meeting qualifier: book, ask or pass, for an interested reply or a question.
//
// Four checks, each a pass or a gap:
//   - problem: triage found a verbatim quote of the sender describing a problem or need;
//   - role: the contact's title in the CRM classifies as a persona keep (scoring/titles.ts with the
//     brain's personas). Never from the email: what someone says about their role is not read;
//   - timing: a verbatim reason or timeline, a meeting request, or a proposed time;
//   - fit: the account's fit score is at or above LOW_FIT_SCORE. An unscored account counts as fit.
// The decision: no gaps books; a proposed time always books; a meeting request with at most one gap
// books; three or more gaps pass (no booking language); anything else asks one question about the
// first gap. A proposed time forces the draft to confirm that time, say a calendar invite will
// follow, and include no link.
//
// The rule text the writer gets is fixed text from this file, chosen by the decision. It never
// holds the sender's words.
import { classifyTitle } from "../scoring/titles.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import type { PersonaRule } from "../sourcing/brain.ts";
import type { ContactRow, StoredTriage } from "./rows.ts";

export type QualifierStatus = "book" | "ask" | "pass";
export type QualifierGap = "problem" | "role" | "timing" | "fit";

export interface Qualification {
  status: QualifierStatus;
  gaps: QualifierGap[];
  /** "keep: <persona>", "maybe", "drop" or "unknown". */
  roleFit: string;
  /** "fit", "unscored" or "low: <score>". */
  icpFit: string;
  problemQuote: string | null;
  timing: string | null;
  meetingRequested: boolean;
  proposedTime: string | null;
  /** The instruction for the writer: fixed text, never the sender's words. */
  rule: string;
}

const ASK_ABOUT: Readonly<Record<QualifierGap, string>> = Object.freeze({
  problem: "what they are trying to solve, or what prompted them to reply",
  role: "who else on their side would look at this with them",
  timing: "what is driving the timing, or when they would want to look at this",
  fit: "a little about their team and how they work today",
});

export interface QualifierInput {
  triage: Pick<StoredTriage, "problem_quote" | "timing_quote" | "meeting_requested" | "proposed_time">;
  roleKeep: boolean;
  roleFit: string;
  accountFit: boolean;
  icpFit: string;
}

/** Decide book, ask or pass. Pure. */
export function decideQualification(input: QualifierInput): Qualification {
  const { triage } = input;
  const timing = triage.timing_quote ?? (triage.proposed_time ? "proposed a time" : triage.meeting_requested ? "asked for a meeting" : null);
  const gaps: QualifierGap[] = [];
  if (!triage.problem_quote) gaps.push("problem");
  if (!input.roleKeep) gaps.push("role");
  if (!timing) gaps.push("timing");
  if (!input.accountFit) gaps.push("fit");
  let status: QualifierStatus;
  if (gaps.length === 0 || triage.proposed_time) status = "book";
  else if (triage.meeting_requested && gaps.length <= 1) status = "book";
  else if (gaps.length >= 3) status = "pass";
  else status = "ask";
  return {
    status,
    gaps,
    roleFit: input.roleFit,
    icpFit: input.icpFit,
    problemQuote: triage.problem_quote,
    timing,
    meetingRequested: triage.meeting_requested,
    proposedTime: triage.proposed_time,
    rule: qualifierRule(status, gaps, Boolean(triage.proposed_time)),
  };
}

/** The writer's instruction for a decision. Fixed text. */
export function qualifierRule(status: QualifierStatus, gaps: readonly QualifierGap[], proposedTime: boolean): string {
  if (proposedTime) return "They proposed a time to meet. Confirm that time in your own words, say a calendar invite will follow, and include no link of any kind.";
  if (status === "book") return "Offer a short call. If a booking link is listed, include it once, on its own line; otherwise ask which times suit them.";
  if (status === "pass") return "Do not propose a meeting and use no booking language. Answer what they wrote, briefly.";
  const gap = gaps[0] ?? "problem";
  return `Ask exactly one short question, about ${ASK_ABOUT[gap]}. Do not propose a meeting yet.`;
}

/** Run the four checks for a contact and decide. Throws on a database error. */
export async function qualifyReply(db: D1Database, input: { triage: StoredTriage; contact: ContactRow; personas: readonly PersonaRule[] }): Promise<Qualification> {
  const title = classifyTitle(input.contact.job_title, input.personas);
  const roleKeep = title.decision === "keep";
  const roleFit = input.contact.job_title ? (roleKeep ? `keep: ${title.persona ?? "persona"}` : title.decision) : "unknown";
  let accountFit = true;
  let icpFit = "unscored";
  if (input.contact.account_key) {
    const row = await db.prepare("SELECT fit_score FROM account_fit WHERE account_key = ?1").bind(input.contact.account_key).first<{ fit_score: number | null }>();
    if (row && typeof row.fit_score === "number") {
      accountFit = row.fit_score >= LOW_FIT_SCORE;
      icpFit = accountFit ? "fit" : `low: ${row.fit_score}`;
    }
  }
  return decideQualification({ triage: input.triage, roleKeep, roleFit, accountFit, icpFit });
}

/** Write the decision to reply_qualifications (one row per inbound message). Throws on a database error. */
export async function saveQualification(db: D1Database, inboundId: string, contactId: string, q: Qualification, now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reply_qualifications (inbound_id, contact_id, status, problem_quote, role_fit, icp_fit, timing, meeting_requested, proposed_time, gaps, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (inbound_id) DO UPDATE SET status = excluded.status, problem_quote = excluded.problem_quote, role_fit = excluded.role_fit,
         icp_fit = excluded.icp_fit, timing = excluded.timing, meeting_requested = excluded.meeting_requested, proposed_time = excluded.proposed_time, gaps = excluded.gaps`,
    )
    .bind(inboundId, contactId, q.status, q.problemQuote, q.roleFit, q.icpFit, q.timing, q.meetingRequested ? 1 : 0, q.proposedTime, JSON.stringify(q.gaps), now.toISOString())
    .run();
}
