-- GTM-agents: suggested search queries and personas on the Product and ICP page (docs/TARGETING.md).
--
-- A suggestion is one model call that reads only the approved product and ICP (and the served
-- personas and queries, so it does not repeat them) and proposes keyword-portfolio and personas
-- items. Nothing here is served: the operator picks and edits suggestions, and only a brain proposal
-- a person approves adds them to the brain. Status runs running -> ready | failed, and any row may end
-- discarded; every move out of running is a compare-and-set. Suggested items hold queries, job titles
-- and short descriptions, never a person's data.
CREATE TABLE IF NOT EXISTS targeting_suggestions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'discarded')),
  reason TEXT,
  suggestions TEXT CHECK (suggestions IS NULL OR json_valid(suggestions)),
  dropped TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dropped)),
  working TEXT CHECK (working IS NULL OR json_valid(working)),
  requested_by TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS targeting_suggestions_started ON targeting_suggestions (started_at);
