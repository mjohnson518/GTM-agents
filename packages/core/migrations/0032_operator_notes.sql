-- GTM-agents: operator notes (docs/OPERATOR.md#notes).
--
-- A note is a short fact or preference the hub agent saved with note_save, kept across sessions and
-- /clean, for the whole deployment (the operator chat and the dashboard read the same notes):
--   - taint: the saving session's taint at the moment of the call. Only notes saved with no taint
--     are loaded into every turn; a tainted note is read only on purpose, with notes_read, which
--     raises the reading session to the note's taint;
--   - saved_by: the session that saved it, and turn_id the turn, for tracing.
-- The operator forgets notes with /notes forget; that deletes the row. Erasing a person deletes every
-- note whose text names one of their addresses.
CREATE TABLE IF NOT EXISTS operator_notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  taint TEXT NOT NULL CHECK (taint IN ('none', 'metadata', 'structured', 'full')),
  saved_by TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS operator_notes_created ON operator_notes (created_at);
