-- GTM-agents: drafts of the product description and the ICP (docs/TARGETING.md).
--
-- A row is one draft started from the Product and ICP page, from the operator's site or from text
-- they pasted, or the operator's own edits saved without any draft (source manual). It never
-- steers anything: only a brain file a person approved is served. A row holds:
--   - status: running while the site is read and the model answers, then ready or failed, or
--     discarded when the operator drops it. A running row older than five minutes reads as failed;
--   - pages: what was read, as URL, title, bytes and SHA-256 per page. Page text is never stored;
--   - draft: the items that passed every filter, and dropped: what was left out and why;
--   - working: the operator's saved edits, per component, until they propose or discard them.
-- A draft holds no contact data, so erasure has nothing to delete here. Rows are kept for review.
CREATE TABLE IF NOT EXISTS targeting_drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'discarded')),
  source TEXT NOT NULL CHECK (source IN ('url', 'text', 'manual')),
  url TEXT,
  reason TEXT,
  pages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pages)),
  draft TEXT CHECK (draft IS NULL OR json_valid(draft)),
  dropped TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dropped)),
  working TEXT CHECK (working IS NULL OR json_valid(working)),
  requested_by TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS targeting_drafts_started ON targeting_drafts (started_at);
