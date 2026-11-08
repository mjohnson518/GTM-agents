// GTM-agents: per-field evidence, and conflicts held for a person.
//
// Each enriched field (the email, the job title, the employer domain) is recorded in
// contact_evidence with the provider that supplied it, its source URL, its confidence, when it was
// verified and a retention date (365 days). Rows belong to a candidate, a contact, or both once the
// candidate is promoted.
//
// A conflict is a different provider giving a different value for the same field of the same
// person: another email, another employer domain, or a title in another seniority band. The same
// provider repeating itself is an update, not a conflict. A conflict is never resolved by guessing
// which provider is right: both rows are marked (conflict = 1, each naming the other), and the
// person is held, not promoted and not selected for cold mail, until a person resolves it by
// setting resolved_at.
import { seniorityOf } from "../scoring/titles.ts";
import { accountKey } from "../data/keys.ts";

export const EVIDENCE_FIELDS = ["email", "job_title", "employer_domain"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

export const EVIDENCE_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

export interface EvidenceInput {
  candidateId?: string | null;
  contactId?: string | null;
  field: EvidenceField;
  value: string;
  provider: string;
  sourceUrl?: string | null;
  confidence?: number | null;
  verifiedAt?: string | null;
  now: Date;
}

export interface EvidenceResult {
  id: string;
  /** Ids of the rows this one conflicts with. Empty when there is no conflict. */
  conflictsWith: string[];
}

/** Whether two values of a field disagree. Titles disagree only across seniority bands. */
export function valuesConflict(field: EvidenceField, a: string, b: string): boolean {
  if (field === "job_title") return seniorityOf(a) !== seniorityOf(b);
  if (field === "employer_domain") return (accountKey(a) ?? a.trim().toLowerCase()) !== (accountKey(b) ?? b.trim().toLowerCase());
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

interface EvidenceRow {
  id: string;
  value: string;
  provider: string;
  conflict_with: string | null;
}

const parseIds = (json: string | null): string[] => {
  try {
    const parsed: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Record one field's evidence and mark any conflict with what other providers said about the same
 * person (the same candidate, or the same contact). Throws on a database error.
 */
export async function recordEvidence(db: D1Database, input: EvidenceInput): Promise<EvidenceResult> {
  if (!input.candidateId && !input.contactId) throw new TypeError("evidence belongs to a candidate or a contact");
  const { results: existing } = await db
    .prepare(
      `SELECT id, value, provider, conflict_with FROM contact_evidence
        WHERE field = ?1 AND resolved_at IS NULL AND ((?2 IS NOT NULL AND candidate_id = ?2) OR (?3 IS NOT NULL AND contact_id = ?3))`,
    )
    .bind(input.field, input.candidateId ?? null, input.contactId ?? null)
    .all<EvidenceRow>();
  const conflicting = existing.filter((row) => row.provider !== input.provider && valuesConflict(input.field, row.value, input.value));
  const id = crypto.randomUUID();
  const stamp = input.now.toISOString();
  const retention = new Date(input.now.getTime() + EVIDENCE_RETENTION_DAYS * DAY_MS).toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO contact_evidence (id, contact_id, candidate_id, field, value, provider, source_url, fetched_at, verified_at, confidence,
           conflict, conflict_with, retention_until, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?8)`,
      )
      .bind(
        id,
        input.contactId ?? null,
        input.candidateId ?? null,
        input.field,
        input.value.slice(0, 254),
        input.provider,
        input.sourceUrl ?? null,
        stamp,
        input.verifiedAt ?? null,
        input.confidence ?? null,
        conflicting.length > 0 ? 1 : 0,
        conflicting.length > 0 ? JSON.stringify(conflicting.map((r) => r.id)) : null,
        retention,
      ),
    ...conflicting.map((row) =>
      db
        .prepare("UPDATE contact_evidence SET conflict = 1, conflict_with = ?2 WHERE id = ?1")
        .bind(row.id, JSON.stringify([...new Set([...parseIds(row.conflict_with), id])])),
    ),
  ];
  await db.batch(statements);
  return { id, conflictsWith: conflicting.map((r) => r.id) };
}

/** True when the candidate (or contact) has an unresolved conflict. Throws on a database error. */
export async function hasOpenConflict(db: D1Database, subject: { candidateId?: string | null; contactId?: string | null }): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM contact_evidence
        WHERE conflict = 1 AND resolved_at IS NULL AND ((?1 IS NOT NULL AND candidate_id = ?1) OR (?2 IS NOT NULL AND contact_id = ?2)) LIMIT 1`,
    )
    .bind(subject.candidateId ?? null, subject.contactId ?? null)
    .first();
  return row !== null;
}
