-- GTM-agents: operator chat sessions and their history.
--
-- A session is one operator conversation, keyed by the chat it happens in. Its taint is the least
-- trusted text the session has read so far (none, metadata, structured, full). Taint only rises
-- while the session lives; /clean deletes the history and resets the taint together, and records
-- when that happened in cleared_at. A turn that started before a /clean never writes its taint or
-- history into the clean session.
--
-- chat_messages keeps the operator's messages and the agent's final replies, one row each, with
-- the turn that produced them. Tool results are not stored: a reply that quotes what the session
-- read is covered by the session's taint, which is recorded before the reply joins the history.
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  taint TEXT NOT NULL DEFAULT 'none' CHECK (taint IN ('none', 'metadata', 'structured', 'full')),
  cleared_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS chat_sessions_chat ON chat_sessions (chat_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL REFERENCES chat_sessions (session_key) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (json_valid(content)),
  turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages (session_key, id);
