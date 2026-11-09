-- GTM-agents: calendar sync's baseline and freshness.
--
-- calendar_sync_state holds one row (id 'calendar'):
--   - last_synced_at: when the last sync finished listing the calendar. Every event that listing
--     returned has calendar_events.last_seen_at at least this, so an attributed meeting whose event
--     is older dropped out of the listing (moved past the window, or deleted without a cancelled
--     marker), and its time is stale: reminders and the held question wait until it is seen again;
--   - baseline_at: when the first sync ran, after calendar sync was turned on. It never moves.
--     Meetings first seen then that had already started were booked before anyone was watching,
--     and are marked before_baseline.
-- calendar_meetings.before_baseline is 1 for those meetings. They still stop outreach and get the
-- held question, but they are not new bookings: the one definition of a booked meeting
-- (packages/core/src/metrics/meetings.ts) leaves them out.

CREATE TABLE IF NOT EXISTS calendar_sync_state (
  id TEXT PRIMARY KEY CHECK (id = 'calendar'),
  baseline_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file exactly once.
ALTER TABLE calendar_meetings ADD COLUMN before_baseline INTEGER NOT NULL DEFAULT 0 CHECK (before_baseline IN (0, 1));
