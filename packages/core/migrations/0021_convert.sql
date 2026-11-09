-- GTM-agents: convert: what calendar sync has seen, and the indexes meeting metrics read by.
--
-- calendar_events holds one row per calendar event that looked like a booking: an outside person
-- accepted it, or the operator organized it with an outside invitee. It never holds a title, a
-- description or an attendee's address: only the times, whether the operator organized it, the
-- SHA-256 of each outside attendee's address (to match contacts and to erase) and their domains.
-- `attendees` holds the same per attendee ({h: exact hash, m: hash without a +tag, d: domain}), so
-- erasure can take one person off a meeting that belongs to someone else.
-- `code` is the short id the operator's meeting commands use. `series_id` is the recurring series an
-- instance belongs to: a series counts as one booking, its first instance seen. `other_contacts`
-- lists the other attributed contacts on the invite (ids, as JSON), whose outreach stops too. `state` is how attribution ended:
--   - attributed: a calendar_meetings row ties it to a contact (calendar_meetings.attribution says how);
--   - ambiguous: more than one contact could be the person; the operator was told once (noticed_at);
--   - unmatched: no contact matched; it stays until the sync window passes it;
--   - inert: the operator unlinked it; sync leaves it alone.
-- The states are defined once in packages/core/src/convert/state.ts. Erasure deletes the rows that
-- hold an erased person's address hash, and those linked to their contact.

CREATE TABLE IF NOT EXISTS calendar_events (
  event_id TEXT PRIMARY KEY,
  series_id TEXT,
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 12 AND code GLOB 'mg*' AND substr(code, 3) NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  operator_organized INTEGER NOT NULL DEFAULT 0 CHECK (operator_organized IN (0, 1)),
  attendee_hashes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attendee_hashes)),
  attendee_domains TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attendee_domains)),
  attendees TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attendees)),
  other_contacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(other_contacts)),
  state TEXT NOT NULL CHECK (state IN ('attributed', 'ambiguous', 'unmatched', 'inert')),
  noticed_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS calendar_events_state ON calendar_events (state, starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_series ON calendar_events (series_id) WHERE series_id IS NOT NULL;

-- Meetings booked are counted by when they were first seen, held meetings by when they started.
CREATE INDEX IF NOT EXISTS calendar_meetings_first_seen ON calendar_meetings (first_seen_at);
-- Briefs are looked up per deal and trigger. Each is written once because its writer claims it in
-- the effects ledger first; this index is not unique.
CREATE INDEX IF NOT EXISTS deal_handoffs_deal_trigger ON deal_handoffs (deal_id, trigger);
