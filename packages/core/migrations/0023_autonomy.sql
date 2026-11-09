-- GTM-agents: earned autonomy: every change to an action class's level, and the changes that wait
-- for the operator's confirmation (packages/core/src/autonomy/, docs/AUTONOMY.md).
--
--   - autonomy_level_changes: one row per change to a class's level, in order of id. The operator's
--     confirmed autonomy-set or promotion writes source 'operator'; an automatic demotion writes
--     source 'demotion'. A class acts at the lower of its autonomy:<class> flag and the latest row
--     here, so a row can only ever lower what the flag says: once a class has a row, raising it
--     past that row needs a confirmed operator row, and a demotion lowers it even when the flag
--     store cannot be written;
--   - autonomy_proposals: a change waiting for the operator: an autonomy-set waiting for its
--     confirmation, or a promotion the weekly review proposed with its evidence. Only the
--     operator's autonomy-confirm command applies one, and only while the class's level and its
--     latest change (based_on_change, 0 for none) are still the ones it was made against.
-- The permanently human-only classes (PERMANENT_HUMAN in packages/core/src/autonomy/levels.ts) can
-- never be recorded above level 1 in either table; a test keeps this list equal to that constant.

CREATE TABLE IF NOT EXISTS autonomy_level_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_class TEXT NOT NULL,
  from_level INTEGER CHECK (from_level IS NULL OR from_level BETWEEN 0 AND 3),
  to_level INTEGER NOT NULL CHECK (to_level BETWEEN 0 AND 3),
  source TEXT NOT NULL CHECK (source IN ('operator', 'demotion')),
  actor TEXT NOT NULL,
  reason TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (to_level <= 1 OR action_class NOT IN ('merge_code', 'pricing_billing_auth', 'offers', 'proof_of_value_send', 'data_deletion'))
);
CREATE INDEX IF NOT EXISTS autonomy_level_changes_class ON autonomy_level_changes (action_class, id);
CREATE UNIQUE INDEX IF NOT EXISTS autonomy_level_changes_proposal ON autonomy_level_changes (proposal_id) WHERE proposal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS autonomy_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) = 10 AND id NOT GLOB '*[^0-9a-f]*'),
  code TEXT NOT NULL CHECK (length(code) = 6 AND code NOT GLOB '*[^0-9a-f]*'),
  action_class TEXT NOT NULL,
  from_level INTEGER NOT NULL CHECK (from_level BETWEEN 0 AND 3),
  to_level INTEGER NOT NULL CHECK (to_level BETWEEN 0 AND 3),
  origin TEXT NOT NULL CHECK (origin IN ('operator', 'review')),
  based_on_change INTEGER NOT NULL DEFAULT 0,
  evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence)),
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'refused', 'expired')),
  decided_by TEXT,
  decided_at TEXT,
  detail TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (to_level <= 1 OR action_class NOT IN ('merge_code', 'pricing_billing_auth', 'offers', 'proof_of_value_send', 'data_deletion'))
);
CREATE INDEX IF NOT EXISTS autonomy_proposals_class ON autonomy_proposals (action_class, origin, created_at);

-- Incident evidence is read by class and time (autonomy_events_class); the hourly watch also reads
-- recent suppression entries by time.
CREATE INDEX IF NOT EXISTS suppression_created ON suppression (created_at);
