-- GTM-agents: run-row retention reads execution_runs by job, status and start time.
--
-- The run_retention job (packages/core/src/runtime/retention.ts, behind ops:retention_enabled)
-- finds the newest run of each job and status, which it always keeps, and deletes older rows of
-- that job and status in batches. This index serves both reads without scanning the table.
CREATE INDEX IF NOT EXISTS execution_runs_task_status_started ON execution_runs (task_name, status, started_at);
