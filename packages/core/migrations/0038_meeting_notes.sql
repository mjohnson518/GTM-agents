-- GTM-agents: meeting notes (docs/MEETING-NOTES.md).
--
-- The meeting_notes_ingest job reads recordings from a meeting-notes tool (a MeetingNotesProvider
-- adapter) and keeps a recording only when one of its invitees is a known contact. The transcript
-- goes to blob storage under meetings.transcript_key, and the meeting_notes_extract job fills the
-- meetings row's pain points, objections, next steps, competitors and sentiment with quotes found
-- word for word in it.
--
-- meeting_notes_state holds, per provider, how far listing has got. meeting_recordings records each
-- recording seen once, matched (with the meetings row it became) or skipped (with a reason code), so
-- a recording is never read twice and a skip can be explained. It holds the provider's id and no
-- address, name or text. Erasing a person deletes their meetings rows (cascade) and the transcript
-- blobs, and a matched recording row keeps only its id and status.
CREATE TABLE IF NOT EXISTS meeting_notes_state (
  provider TEXT PRIMARY KEY,
  since_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS meeting_recordings (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'skipped')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('no_contact', 'ambiguous', 'suppressed', 'no_transcript', 'invalid')),
  meeting_id TEXT REFERENCES meetings (id) ON DELETE SET NULL,
  started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider, external_id)
);

-- Model calls tried on a meeting's transcript without a usable answer; extraction stops at 3.
-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file once.
ALTER TABLE meetings ADD COLUMN extract_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS meetings_processed ON meetings (processed_at);
CREATE INDEX IF NOT EXISTS meetings_transcript_age ON meetings (occurred_at) WHERE transcript_key IS NOT NULL;
