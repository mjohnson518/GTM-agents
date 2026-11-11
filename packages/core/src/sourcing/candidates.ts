// GTM-agents: reading and writing candidate rows.
//
// A candidate is a sourced account or person that is not a contact yet. Its status follows the
// canonical enum exactly (data/enums.ts): raw -> enriched -> qualified | borderline | rejected ->
// promoted | duplicate. Every status change here is a compare-and-set on the status the stage read,
// so two runs racing over the same row cannot move it twice. Fields with no column of their own
// (the person-fit verdict, a profile URL, retry counters) live in the attributes JSON column.
import type { CandidateStatus } from "../data/enums.ts";
import type { TitleClass } from "../scoring/titles.ts";
import type { RejectReason } from "./reasons.ts";

export interface CandidateRow {
  id: string;
  source: string;
  source_ref: string | null;
  query_id: string | null;
  search_type: string | null;
  url: string | null;
  result_title: string | null;
  snippet: string | null;
  category: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_title: string | null;
  account_name: string | null;
  account_key: string | null;
  status: CandidateStatus;
  qualification_score: number | null;
  qualification_notes: string | null;
  email_source: string | null;
  email_steps_tried: string | null;
  promoted_contact_id: string | null;
  attributes: string;
  created_at: string;
  updated_at: string;
}

export interface CandidateAttributes {
  segment?: string;
  intent?: string;
  person_fit?: Pick<TitleClass, "decision" | "persona" | "role" | "seat" | "seniority" | "rank" | "reason">;
  profile_url?: string;
  /** Lookups that failed for reasons other than the budget. */
  enrich_attempts?: number;
  /** Verifications that came back unknown at promotion. */
  verify_attempts?: number;
  /** Verifications that failed with an error at promotion. */
  verify_errors?: number;
  /** Why the candidate stopped short of promotion, on every rejected, borderline or duplicate row. */
  reject_reason?: RejectReason;
  [key: string]: unknown;
}

export function parseAttributes(json: string | null | undefined): CandidateAttributes {
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CandidateAttributes) : {};
  } catch {
    return {};
  }
}

export function parseSteps(json: string | null | undefined): string[] {
  try {
    const parsed: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

const COLUMNS = new Set([
  "status",
  "first_name",
  "last_name",
  "email",
  "job_title",
  "account_name",
  "qualification_score",
  "qualification_notes",
  "icp_score",
  "email_source",
  "email_steps_tried",
  "promoted_contact_id",
  "attributes",
]);

export type CandidateUpdate = Partial<{
  status: CandidateStatus;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_title: string | null;
  account_name: string | null;
  qualification_score: number | null;
  qualification_notes: string | null;
  icp_score: number | null;
  email_source: string | null;
  email_steps_tried: string | null;
  promoted_contact_id: string | null;
  attributes: string;
}>;

/** The statement for a compare-and-set update of a candidate that is still in `from`. */
export function candidateUpdate(db: D1Database, id: string, from: CandidateStatus, fields: CandidateUpdate, now: Date): D1PreparedStatement {
  const entries = Object.entries(fields).filter(([key]) => COLUMNS.has(key));
  const sets = entries.map(([key], i) => `${key} = ?${i + 4}`);
  return db
    .prepare(`UPDATE candidates SET ${[...sets, "updated_at = ?3"].join(", ")} WHERE id = ?1 AND status = ?2`)
    .bind(id, from, now.toISOString(), ...entries.map(([, value]) => value ?? null));
}

/** Apply a compare-and-set update. True when the row was still in `from` and changed. */
export async function updateCandidate(db: D1Database, id: string, from: CandidateStatus, fields: CandidateUpdate, now: Date): Promise<boolean> {
  const result = await candidateUpdate(db, id, from, fields, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export interface NewCandidate {
  source: string;
  sourceRef: string;
  queryId?: string | null;
  searchType: "account" | "person";
  url?: string | null;
  resultTitle?: string | null;
  snippet?: string | null;
  category?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  emailSource?: string | null;
  jobTitle?: string | null;
  accountName?: string | null;
  accountKey?: string | null;
  /**
   * raw or rejected. qualified is only for a source whose rows carry their own fixed score (a
   * webset row with a clean work address); promotion still runs every check on it.
   */
  status: Extract<CandidateStatus, "raw" | "rejected" | "qualified">;
  qualificationScore?: number | null;
  notes?: string | null;
  attributes?: CandidateAttributes;
}

/** Insert a candidate unless (source, source_ref) is already known. True when a row was added. */
export async function insertCandidate(db: D1Database, c: NewCandidate, now: Date): Promise<boolean> {
  const stamp = now.toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO candidates (id, source, source_ref, query_id, search_type, url, result_title, snippet, category, first_name, last_name,
         email, email_source, job_title, account_name, account_key, status, qualification_notes, attributes, created_at, updated_at, qualification_score)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, ?21)`,
    )
    .bind(
      crypto.randomUUID(),
      c.source,
      c.sourceRef,
      c.queryId ?? null,
      c.searchType,
      c.url ?? null,
      c.resultTitle ?? null,
      c.snippet ?? null,
      c.category ?? null,
      c.firstName ?? null,
      c.lastName ?? null,
      c.email ?? null,
      c.emailSource ?? null,
      c.jobTitle ?? null,
      c.accountName ?? null,
      c.accountKey ?? null,
      c.status,
      c.notes ?? null,
      JSON.stringify(c.attributes ?? {}),
      stamp,
      c.status === "qualified" ? (c.qualificationScore ?? null) : null,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** The person-fit verdict, as stored in attributes. */
export function fitAttribute(fit: TitleClass): NonNullable<CandidateAttributes["person_fit"]> {
  return { decision: fit.decision, persona: fit.persona, role: fit.role, seat: fit.seat, seniority: fit.seniority, rank: fit.rank, reason: fit.reason };
}

/** Cached model reviews of titles the rules could not place, keyed by title key. Empty on a read error. */
export async function loadTitleReviews(db: D1Database): Promise<Map<string, "keep" | "drop">> {
  try {
    const { results } = await db.prepare("SELECT title_key, decision FROM title_fit_reviews LIMIT 5000").all<{ title_key: string; decision: "keep" | "drop" }>();
    return new Map(results.map((r) => [r.title_key, r.decision]));
  } catch {
    return new Map();
  }
}
