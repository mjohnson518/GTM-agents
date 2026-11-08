-- GTM-agents: the cost ledger. One row per paid call: model tokens, provider credits, sends.
--
-- Costs are stored in micro-cents (10,000 per cent) so that calls costing less than half a cent do
-- not round to zero. Every row carries the job, run and chat turn it belongs to, so per-job caps,
-- run ceilings and turn ceilings see provider spend as well as model spend.
CREATE TABLE IF NOT EXISTS cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  model TEXT,
  units INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_micro_cents INTEGER NOT NULL CHECK (cost_micro_cents >= 0),
  job TEXT,
  run_id TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS cost_events_created ON cost_events (created_at);
CREATE INDEX IF NOT EXISTS cost_events_job_created ON cost_events (job, created_at);
CREATE INDEX IF NOT EXISTS cost_events_run ON cost_events (run_id);
CREATE INDEX IF NOT EXISTS cost_events_turn ON cost_events (turn_id);
