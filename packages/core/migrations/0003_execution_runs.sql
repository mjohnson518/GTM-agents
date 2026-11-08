-- GTM-agents: one row per job run, delegated run or chat turn.
--
-- The job runner writes a row for every scheduled job, including runs it skips (halted, flag off,
-- over budget), so the cron health check can tell a job that never fired from one that was held.
-- Timestamps are ISO 8601 in UTC, so they compare correctly as strings.
CREATE TABLE IF NOT EXISTS execution_runs (
  id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'rerun', 'manual', 'chat', 'delegation')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  parent_run_id TEXT,
  turn_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  summary TEXT,
  error TEXT,
  error_class TEXT CHECK (error_class IS NULL OR error_class IN ('transient', 'config', 'unknown')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS execution_runs_task_started ON execution_runs (task_name, started_at);
