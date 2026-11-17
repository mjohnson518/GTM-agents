// GTM-agents: meeting notes ingest (docs/MEETING-NOTES.md#ingest). No model call and no spend.
//
// Each run lists a provider's recordings created since its cursor (meeting_notes_state.since_at,
// less a day of overlap; a provider's first run looks back 7 days), and looks at up to
// NOTES_LIMITS.ingestPerRun recordings it has not seen before (meeting_recordings):
//   - match: the invitees the provider does not mark internal, by address and by mailbox, against
//     existing contacts. Contacts that are suppressed, tombstoned or opted out are set aside. One
//     contact left is the match. Several: the one calendar sync attributed a meeting to that started
//     within 30 minutes of the recording, or nobody. A recording that matches nobody is skipped with
//     a reason (no_contact, suppressed, ambiguous) and its transcript is never fetched;
//   - a recording with no usable start time is skipped (invalid); a match whose transcript is not
//     ready yet is left for a later run; one whose transcript the provider says is gone or invalid
//     (a non-retryable not_found or invalid error) is skipped (no_transcript), so it never blocks
//     the recordings after it;
//   - otherwise the transcript is fetched, the meetings row (external_id <provider>:<recording id>,
//     the contact, their deal, the time, a cleaned title, no summary) and the meeting_recordings row
//     are written in one batch, and then the transcript goes to blob storage
//     (transcripts/<meeting id>.json, capped, speech and sides only). If the blob cannot be written,
//     both rows are deleted again and the recording is tried on a later run, so no blob is ever left
//     without the row that erasure and retention find it by.
// Any other provider error stops the run and is returned. A suppression check that cannot be read stops the
// run too (fail closed). The cursor moves only after a run that read every page to its end.
// Everything the provider returns is untrusted text: it is stored as data and read again only by
// the extraction call, fenced.
import { dealFor } from "../convert/booked.ts";
import { AdapterError } from "../ports/types.ts";
import { contactEmailFields } from "../data/contacts.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { MeetingNotesProvider, MeetingRecording, TranscriptSegment } from "../ports/business.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { cleanProviderText } from "../sourcing/text.ts";
import { NOTES_LIMITS } from "./flags.ts";

const DAY_MS = 86_400_000;

export type SkipReason = "no_contact" | "ambiguous" | "suppressed" | "no_transcript" | "invalid";

export interface IngestDeps {
  db: D1Database;
  bucket: Pick<R2Bucket, "put" | "delete">;
  provider: MeetingNotesProvider;
  now: Date;
  log: JobLogger;
  limit?: number;
  signal?: AbortSignal;
}

export interface IngestStats {
  listed: number;
  matched: number;
  skipped: Record<SkipReason, number>;
  /** Matches whose transcript was not ready. */
  waiting: number;
  /** Set when a provider error stopped the run, sanitized. */
  error?: string;
}

/** The stored transcript: what the extraction reads back. */
export interface StoredTranscript {
  provider: string;
  recording: string;
  segments: TranscriptSegment[];
  truncated: boolean;
}

export const transcriptKey = (meetingId: string): string => `transcripts/${meetingId}.json`;

/** A provider call failed: the run stops and reports it. */
class ProviderFailure extends Error {}

async function fromProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new ProviderFailure(sanitizeErrorMessage(error), { cause: error });
  }
}

/** Where listing starts: the cursor less the overlap, or the first-run lookback. */
async function listSince(db: D1Database, provider: string, now: Date): Promise<string> {
  const row = await db.prepare("SELECT since_at FROM meeting_notes_state WHERE provider = ?1").bind(provider).first<{ since_at: string }>();
  const from = row ? Date.parse(row.since_at) - NOTES_LIMITS.overlapHours * 3_600_000 : now.getTime() - NOTES_LIMITS.firstLookbackDays * DAY_MS;
  return new Date(from).toISOString();
}

interface MatchedContact {
  id: string;
  email: string;
  account_key: string | null;
}

/** The one contact a recording belongs to, or why there is none. Throws when suppression cannot be read. */
export async function matchRecording(db: D1Database, recording: MeetingRecording): Promise<{ contact: MatchedContact } | { skip: SkipReason }> {
  const fields = (await Promise.all(recording.invitees.filter((i) => i.external !== false).map((i) => contactEmailFields(i.email)))).filter((f): f is NonNullable<typeof f> => f !== null);
  const hashes = [...new Set(fields.flatMap((f) => [f.email_sha256, f.mailbox_sha256]))];
  if (hashes.length === 0) return { skip: "no_contact" };
  const { results: found } = await db
    .prepare(
      `SELECT id, email, account_key FROM contacts
        WHERE email_sha256 IN (SELECT value FROM json_each(?1)) OR mailbox_sha256 IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(hashes))
    .all<MatchedContact>();
  if (found.length === 0) return { skip: "no_contact" };
  const check = await checkSuppression(
    db,
    found.map((c) => c.email),
  );
  if (check.blocked.some((b) => b.reason === "check_failed")) throw new Error("the suppression list could not be read");
  const blocked = new Set(check.blocked.map((b) => b.recipient));
  const allowed = found.filter((c) => !blocked.has(c.email));
  if (allowed.length === 0) return { skip: "suppressed" };
  if (allowed.length === 1) return { contact: allowed[0] as MatchedContact };
  const window = NOTES_LIMITS.matchWindowMinutes * 60_000;
  const started = Date.parse(recording.startedAt);
  const { results: booked } = await db
    .prepare(
      `SELECT DISTINCT contact_id FROM calendar_meetings
        WHERE contact_id IN (SELECT value FROM json_each(?1)) AND status <> 'cancelled' AND starts_at >= ?2 AND starts_at <= ?3`,
    )
    .bind(JSON.stringify(allowed.map((c) => c.id)), new Date(started - window).toISOString(), new Date(started + window).toISOString())
    .all<{ contact_id: string }>();
  if (booked.length !== 1) return { skip: "ambiguous" };
  const contact = allowed.find((c) => c.id === booked[0]?.contact_id);
  return contact ? { contact } : { skip: "ambiguous" };
}

/** The segments as stored: speech and side only, cleaned of control characters, capped at transcriptMaxBytes. */
export function storedTranscript(provider: string, recording: string, segments: readonly TranscriptSegment[]): StoredTranscript {
  const kept: TranscriptSegment[] = [];
  let bytes = 0;
  let truncated = false;
  for (const s of segments) {
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    const text = typeof s.text === "string" ? s.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
    if (!text) continue;
    // Speaker names are not kept: nothing reads them, and the side is all extraction needs.
    const segment: TranscriptSegment = {
      side: s.side === "us" || s.side === "them" ? s.side : "unknown",
      text,
      ...(Number.isFinite(s.startMs) ? { startMs: s.startMs } : {}),
    };
    const size = new TextEncoder().encode(JSON.stringify(segment)).length;
    if (bytes + size > NOTES_LIMITS.transcriptMaxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    kept.push(segment);
  }
  return { provider, recording, segments: kept, truncated };
}

async function recordSkip(db: D1Database, provider: string, recording: MeetingRecording, reason: SkipReason, now: Date): Promise<void> {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO meeting_recordings (provider, external_id, status, reason, started_at, created_at, updated_at)
       VALUES (?1, ?2, 'skipped', ?3, ?4, ?5, ?5)`,
    )
    .bind(provider, recording.externalId, reason, recording.startedAt, at)
    .run();
}

/** Ingest one provider's new recordings. Throws only on a database or storage error. */
export async function runNotesIngest(deps: IngestDeps): Promise<IngestStats> {
  const { db, provider, now } = deps;
  const stats: IngestStats = {
    listed: 0,
    matched: 0,
    skipped: {
      no_contact: 0,
      ambiguous: 0,
      suppressed: 0,
      no_transcript: 0,
      invalid: 0,
    },
    waiting: 0,
  };
  const limit = deps.limit ?? NOTES_LIMITS.ingestPerRun;
  const since = await listSince(db, provider.name, now);
  let cursor: string | undefined;
  let complete = false;
  let stoppedEarly = false;
  let looked = 0;
  try {
    for (;;) {
      if (deps.signal?.aborted) break;
      const page = await fromProvider(() =>
        provider.listRecordings({
          since,
          ...(cursor ? { cursor } : {}),
          limit: NOTES_LIMITS.pageSize,
        }),
      );
      for (const recording of page.items) {
        stats.listed += 1;
        const seen = await db.prepare("SELECT 1 AS hit FROM meeting_recordings WHERE provider = ?1 AND external_id = ?2").bind(provider.name, recording.externalId).first();
        if (seen) continue;
        if (looked >= limit) {
          stoppedEarly = true;
          break;
        }
        looked += 1;
        const startedMs = Date.parse(recording.startedAt);
        if (!Number.isFinite(startedMs)) {
          stats.skipped.invalid += 1;
          await recordSkip(db, provider.name, recording, "invalid", now);
          continue;
        }
        const startedAt = new Date(startedMs).toISOString();
        const match = await matchRecording(db, { ...recording, startedAt });
        if ("skip" in match) {
          stats.skipped[match.skip] += 1;
          await recordSkip(db, provider.name, recording, match.skip, now);
          continue;
        }
        if (!recording.transcriptAvailable) {
          stats.waiting += 1;
          continue;
        }
        let transcript: Awaited<ReturnType<MeetingNotesProvider["getTranscript"]>>;
        try {
          transcript = await provider.getTranscript(recording.externalId);
        } catch (error) {
          // Gone or invalid at the provider: skipped for good, so it never blocks the rest.
          if (error instanceof AdapterError && !error.retryable && (error.code === "not_found" || error.code === "invalid")) {
            stats.skipped.no_transcript += 1;
            await recordSkip(db, provider.name, recording, "no_transcript", now);
            continue;
          }
          throw new ProviderFailure(sanitizeErrorMessage(error), {
            cause: error,
          });
        }
        const meetingId = `mt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
        const key = transcriptKey(meetingId);
        const deal = await dealFor(db, match.contact.id, match.contact.account_key);
        const ended = recording.endedAt ? Date.parse(recording.endedAt) : NaN;
        const minutes = Number.isFinite(ended) ? Math.max(0, Math.round((ended - startedMs) / 60_000)) : null;
        const at = now.toISOString();
        // Rows first, then the blob: a blob is never left without the row that finds it.
        await db.batch([
          db
            .prepare(
              `INSERT INTO meetings (id, external_id, deal_id, contact_id, title, occurred_at, duration_minutes, transcript_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
            )
            .bind(meetingId, `${provider.name}:${recording.externalId}`, deal?.id ?? null, match.contact.id, cleanProviderText(recording.title, 200), startedAt, minutes, key, at),
          db
            .prepare(
              `INSERT INTO meeting_recordings (provider, external_id, status, meeting_id, started_at, created_at, updated_at)
                 VALUES (?1, ?2, 'matched', ?3, ?4, ?5, ?5)`,
            )
            .bind(provider.name, recording.externalId, meetingId, startedAt, at),
        ]);
        try {
          await deps.bucket.put(key, JSON.stringify(storedTranscript(provider.name, recording.externalId, transcript.segments)), { httpMetadata: { contentType: "application/json" } });
        } catch (error) {
          // The blob was not written: the rows go again, and a later run tries the recording anew.
          await db.batch([
            db.prepare("DELETE FROM meeting_recordings WHERE provider = ?1 AND external_id = ?2").bind(provider.name, recording.externalId),
            db.prepare("DELETE FROM meetings WHERE id = ?1").bind(meetingId),
          ]);
          throw error;
        }
        stats.matched += 1;
      }
      if (stoppedEarly || !page.cursor) {
        // The cursor moves only when every page was read to its end.
        complete = !stoppedEarly && !page.cursor;
        break;
      }
      cursor = page.cursor;
    }
  } catch (error) {
    if (!(error instanceof ProviderFailure)) throw error;
    stats.error = error.message;
    deps.log.warn("meeting notes ingest stopped", {
      provider: provider.name,
      error: stats.error,
    });
    return stats;
  }
  if (complete) {
    const at = now.toISOString();
    await db
      .prepare(
        `INSERT INTO meeting_notes_state (provider, since_at, updated_at, created_at) VALUES (?1, ?2, ?2, ?2)
         ON CONFLICT (provider) DO UPDATE SET since_at = excluded.since_at, updated_at = excluded.updated_at`,
      )
      .bind(provider.name, at)
      .run();
  }
  return stats;
}
