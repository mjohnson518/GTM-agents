-- GTM-agents: where a chat draft came from (docs/OPERATOR.md#decisions-in-the-session).
--
-- With operator:decision_lines_enabled on, a hub turn that creates drafts records, for each one, the
-- session and turn that created it and the session's cleared_at as the turn loaded it. When the
-- operator approves or rejects that draft, by a tap or in the dashboard, core appends one line to
-- that session's history, and only while the session's cleared_at still equals the recorded one, so
-- a session /clean ended never hears about a conversation it no longer has. A draft no turn created
-- has no row here and never writes a line.
--
-- A row holds no personal data. It goes with its draft (erasing a person deletes their drafts) and
-- with its session.
CREATE TABLE IF NOT EXISTS chat_draft_origins (
  draft_id TEXT PRIMARY KEY REFERENCES drafts (id) ON DELETE CASCADE,
  session_key TEXT NOT NULL REFERENCES chat_sessions (session_key) ON DELETE CASCADE,
  session_cleared_at TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS chat_draft_origins_session ON chat_draft_origins (session_key);
