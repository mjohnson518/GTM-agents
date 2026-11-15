-- GTM-agents: the operator outbox (docs/OPERATOR.md#quiet-hours-and-the-outbox).
--
-- While operator:outbox_enabled is on, notices to the operator pass through this table:
--   - a notice delivered at once leaves a row with no text (status sent), so the hourly limit can be
--     counted;
--   - a notice held for quiet hours or the hourly limit, or one the channel could not deliver, keeps
--     its text until the operator_outbox job delivers it (status held, then sending, then sent, when
--     the text is cleared). reason says why it waited, release_at when it is due, and delivery_id
--     names the message it went out in, so several notices folded into one message count once;
--   - a held notice the channel still refuses a day after it was written is dropped, its text cleared.
-- Replies to the operator's own messages and approval requests never pass through it. Sent and
-- dropped rows are deleted after two days. Erasing a person deletes every held notice whose text
-- names one of their addresses.
CREATE TABLE IF NOT EXISTS operator_outbox (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'notice')),
  text TEXT,
  silent INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('held', 'sending', 'sent', 'dropped')),
  reason TEXT CHECK (reason IN ('quiet_hours', 'hourly_cap', 'channel_error', 'released')),
  release_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivery_id TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS operator_outbox_due ON operator_outbox (status, release_at);
CREATE INDEX IF NOT EXISTS operator_outbox_sent ON operator_outbox (sent_at);
CREATE INDEX IF NOT EXISTS operator_outbox_delivery ON operator_outbox (delivery_id);
