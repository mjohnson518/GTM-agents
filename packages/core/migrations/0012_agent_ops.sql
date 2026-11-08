-- GTM-agents: agent operations: the audit log, provider runs, delegations, tasks, evaluations,
-- autonomy evidence, learnings, MCP servers, plans, goals and the memory search index.
--
-- The audit log is bookkeeping: writes to it are fire-and-forget and never block the action they
-- record. execution_runs and cost_events (earlier migrations) complete the picture of what ran and
-- what it cost.

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  run_id TEXT,
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action, created_at);
CREATE INDEX IF NOT EXISTS audit_log_run ON audit_log (run_id);

-- One row per call batch to a data provider, with its spend and yield.
CREATE TABLE IF NOT EXISTS provider_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ingested', 'failed', 'abandoned')),
  effort TEXT,
  cost_micro_cents INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  run_id TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS provider_runs_provider ON provider_runs (provider, created_at);

-- Each delegation from the hub agent to a worker, with a capped preview of the task.
CREATE TABLE IF NOT EXISTS delegation_tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  agent TEXT NOT NULL,
  task_preview TEXT NOT NULL,
  outcome TEXT,
  revision_number INTEGER NOT NULL DEFAULT 0,
  response_length INTEGER,
  tools_used TEXT CHECK (tools_used IS NULL OR json_valid(tools_used)),
  rounds INTEGER,
  duration_ms INTEGER,
  cost_micro_cents INTEGER,
  final_taint TEXT CHECK (final_taint IS NULL OR final_taint IN ('none', 'metadata', 'structured', 'full')),
  run_id TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS delegation_tasks_parent ON delegation_tasks (parent_id);

-- Multi-step tasks the agent is working through.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed', 'cancelled', 'archived')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  context TEXT CHECK (context IS NULL OR json_valid(context)),
  agent TEXT NOT NULL,
  parent_task_id TEXT,
  deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, priority);

-- Scored runs of the behavior eval suite.
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  scenario_count INTEGER NOT NULL,
  scores TEXT NOT NULL CHECK (json_valid(scores)),
  aggregate_score REAL NOT NULL,
  artifact_versions TEXT CHECK (artifact_versions IS NULL OR json_valid(artifact_versions)),
  cost_micro_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A daily composite of how well the system is doing, one row per day.
CREATE TABLE IF NOT EXISTS fitness_scores (
  date TEXT PRIMARY KEY CHECK (length(date) = 10),
  components TEXT NOT NULL CHECK (json_valid(components)),
  composite_score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Attempts to improve a prompt or template by generating and scoring candidates.
CREATE TABLE IF NOT EXISTS evolution_runs (
  id TEXT PRIMARY KEY,
  artifact_key TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  candidates_generated INTEGER NOT NULL DEFAULT 0,
  winner_index INTEGER,
  pre_score REAL,
  post_score REAL,
  fitness_delta REAL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  failure_traces TEXT CHECK (failure_traces IS NULL OR json_valid(failure_traces)),
  cost_micro_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Evidence for earned autonomy: how the operator treated each action of a class.
CREATE TABLE IF NOT EXISTS autonomy_events (
  id TEXT PRIMARY KEY,
  action_class TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved_unchanged', 'approved_edited', 'rejected', 'auto_sent', 'incident')),
  subject_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS autonomy_events_class ON autonomy_events (action_class, created_at);

-- Proposed edits to the brain or the agent's learnings, approved by a person byte for byte.
CREATE TABLE IF NOT EXISTS learnings_proposals (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  section TEXT NOT NULL,
  proposed_text TEXT NOT NULL,
  proposed_digest TEXT NOT NULL CHECK (length(proposed_digest) = 64),
  rationale TEXT,
  source_run_id TEXT,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'expired')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS learnings_proposals_status ON learnings_proposals (status);

-- Remote MCP servers the agent may call. Credentials are referenced by secret name, never stored.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  auth_type TEXT CHECK (auth_type IS NULL OR auth_type IN ('none', 'bearer', 'header')),
  auth_secret_name TEXT,
  allowed_tools TEXT CHECK (allowed_tools IS NULL OR json_valid(allowed_tools)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Business goals and the weekly plans made against them.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  target_value REAL NOT NULL,
  target_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('target', 'milestone')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'missed', 'retired')),
  achieved_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plans (
  week_start TEXT NOT NULL CHECK (length(week_start) = 10),
  goal_id TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (json_valid(plan)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  reported_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (week_start, goal_id)
);
CREATE INDEX IF NOT EXISTS plans_goal ON plans (goal_id);

-- Full-text search over memory text, alongside the vector index. Memory text is sanitized before
-- it is stored. A virtual table is not included in `wrangler d1 export`; it is rebuilt from memory.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, kind UNINDEXED, text);
