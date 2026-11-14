-- GTM-agents: operator timers (docs/OPERATOR.md#timers).
--
-- A timer is a later hub turn the agent set for itself in one operator chat session, with the
-- timer_set tool. The row holds everything that turn needs, so the message queued for it carries
-- only the timer's id:
--   - taint: the session's taint when the timer was set. The turn the timer starts begins at least
--     this tainted, so a note written after reading third-party text is gated like that text;
--   - session_cleared_at: the session's cleared_at when the timer was set. A session cleared since
--     (the operator's /clean) never runs the timer: it is cancelled instead, so its note never
--     reaches the clean session;
--   - status: pending (waiting), queued (sent to the chat queue), fired (its turn started),
--     cancelled (/timers cancel, /clean, an operator no longer allowed) or expired (more than six
--     hours late, or queued and never delivered). Every change is a compare-and-set on status.
CREATE TABLE IF NOT EXISTS operator_timers (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  taint TEXT NOT NULL CHECK (taint IN ('none', 'metadata', 'structured', 'full')),
  session_cleared_at TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'fired', 'cancelled', 'expired')),
  set_by_turn_id TEXT,
  fired_turn_id TEXT,
  reason TEXT,
  queued_at TEXT,
  fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS operator_timers_due ON operator_timers (status, due_at);
CREATE INDEX IF NOT EXISTS operator_timers_session ON operator_timers (session_key, status);
CREATE INDEX IF NOT EXISTS operator_timers_queued ON operator_timers (queued_at);
