// GTM-agents: transcript retention (docs/MEETING-NOTES.md#retention). A stored transcript is deleted
// from blob storage a year after its meeting (NOTES_LIMITS.retentionDays), and its key cleared, at
// most NOTES_LIMITS.retentionPerRun a run. The blob goes first, then the key, so a failure leaves the
// key for the next run, which deletes the blob again harmlessly. The extracted quotes stay with the
// meeting until the person is erased.
import { NOTES_LIMITS } from "./flags.ts";

const DAY_MS = 86_400_000;

/** Delete transcripts older than the retention window. Returns how many. Throws on a storage or database error. */
export async function runTranscriptRetention(deps: { db: D1Database; bucket: Pick<R2Bucket, "delete">; now: Date; limit?: number }): Promise<number> {
  const cutoff = new Date(deps.now.getTime() - NOTES_LIMITS.retentionDays * DAY_MS).toISOString();
  const { results } = await deps.db
    .prepare("SELECT id, transcript_key FROM meetings WHERE transcript_key IS NOT NULL AND COALESCE(occurred_at, created_at) < ?1 ORDER BY occurred_at LIMIT ?2")
    .bind(cutoff, deps.limit ?? NOTES_LIMITS.retentionPerRun)
    .all<{ id: string; transcript_key: string }>();
  if (results.length === 0) return 0;
  await deps.bucket.delete(results.map((r) => r.transcript_key));
  await deps.db
    .prepare("UPDATE meetings SET transcript_key = NULL WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}
