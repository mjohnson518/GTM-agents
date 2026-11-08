-- GTM-agents: the ship loop and link intake (optional modules): product feedback, themes, ship
-- tasks and operator-supplied links.
--
-- Feedback text is full taint: it is fenced whenever an agent reads it, and nothing in it is an
-- instruction. Merging code is permanently human; a ship task ends at an open pull request.

CREATE TABLE IF NOT EXISTS feedback_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  product_user_id TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  category TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'critical')),
  triage_summary TEXT,
  affected_area TEXT,
  theme_id TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'themed', 'declined', 'shipped')),
  triaged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS feedback_items_theme ON feedback_items (theme_id);
CREATE INDEX IF NOT EXISTS feedback_items_status ON feedback_items (status, created_at);
CREATE INDEX IF NOT EXISTS feedback_items_contact ON feedback_items (contact_id);
CREATE INDEX IF NOT EXISTS feedback_items_product_user ON feedback_items (product_user_id);

-- Feedback grouped into themes, weighted by demand and by the revenue of the people asking.
CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  category TEXT NOT NULL,
  affected_area TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'spec_ready', 'approved', 'building', 'pr_open', 'merged', 'shipped', 'declined', 'failed')),
  demand_count INTEGER NOT NULL DEFAULT 0,
  paying_requesters INTEGER NOT NULL DEFAULT 0,
  requester_mrr_cents INTEGER NOT NULL DEFAULT 0,
  max_priority TEXT,
  priority_score REAL NOT NULL DEFAULT 0,
  spec TEXT CHECK (spec IS NULL OR json_valid(spec)),
  spec_risk TEXT,
  spec_generated_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  declined_reason TEXT,
  adoption_event TEXT,
  shipped_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS themes_status ON themes (status, priority_score DESC);

CREATE TABLE IF NOT EXISTS ship_tasks (
  id TEXT PRIMARY KEY,
  theme_id TEXT NOT NULL REFERENCES themes (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'proposed', 'refused', 'pr_open', 'merged', 'deployed', 'failed', 'parked', 'closed')),
  workflow_instance_id TEXT,
  risk TEXT,
  policy_reasons TEXT CHECK (policy_reasons IS NULL OR json_valid(policy_reasons)),
  diff_key TEXT,
  log_key TEXT,
  files_changed INTEGER,
  lines_changed INTEGER,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  checks_state TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  merge_commit_sha TEXT,
  merged_at TEXT,
  deployed_at TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ship_tasks_theme ON ship_tasks (theme_id);
CREATE INDEX IF NOT EXISTS ship_tasks_status ON ship_tasks (status);

-- Links the operator sends in for evaluation: fetched safely, scored against four gates, and
-- routed to a learning, a bounded setting change or a code-change request.
CREATE TABLE IF NOT EXISTS link_items (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  source TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'fetching', 'analyzing', 'proposed', 'approved', 'routed', 'dropped', 'failed')),
  content_key TEXT,
  content_digest TEXT CHECK (content_digest IS NULL OR length(content_digest) = 64),
  gate_scores TEXT CHECK (gate_scores IS NULL OR json_valid(gate_scores)),
  classification TEXT,
  proposal_text TEXT,
  drop_gate TEXT,
  drop_reason TEXT,
  routed_table TEXT,
  routed_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS link_items_canonical ON link_items (canonical_url);
CREATE INDEX IF NOT EXISTS link_items_status ON link_items (status, created_at);
