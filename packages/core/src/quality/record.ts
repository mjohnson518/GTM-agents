// GTM-agents: quality_checks rows: one per gate decision, with its rule codes and verdict.
//
// Recording is bookkeeping: it never throws and never fails the path that made the decision. Each
// row holds the verdict, the score, every finding (code, severity, detail) and, when the model
// reviewer ran, its verdict. subject_id is the draft id, or for a contact whose copy could not be
// built (a missing variable), the item's idempotency key.
import type { QualityResult } from "./gate.ts";
import type { ReviewVerdict } from "./reviewer.ts";

export type QualitySubject = "draft" | "batch" | "reply" | "followup";

export interface QualityRecord {
  subjectType: QualitySubject;
  subjectId: string;
  result: QualityResult;
  review?: ReviewVerdict | null;
}

const newId = () => `qc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** The insert for one record, for callers that batch their writes. */
export function qualityCheckStatement(db: D1Database, record: QualityRecord, now: Date = new Date()): D1PreparedStatement {
  return db
    .prepare("INSERT INTO quality_checks (id, subject_type, subject_id, verdict, score, findings, judge, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(
      newId(),
      record.subjectType,
      record.subjectId,
      record.result.verdict,
      record.result.score,
      JSON.stringify(record.result.findings),
      record.review ? JSON.stringify(record.review) : null,
      now.toISOString(),
    );
}

/** Write quality_checks rows. Returns how many were written; never throws. */
export async function recordQualityChecks(db: D1Database, records: readonly QualityRecord[], now: Date = new Date()): Promise<number> {
  let written = 0;
  for (let i = 0; i < records.length; i += 50) {
    const chunk = records.slice(i, i + 50);
    try {
      await db.batch(chunk.map((r) => qualityCheckStatement(db, r, now)));
      written += chunk.length;
    } catch {
      // Bookkeeping: a lost verdict row never changes the decision it records.
    }
  }
  return written;
}
