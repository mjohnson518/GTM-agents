-- GTM-agents: experiments: pre-registered tests, assignments, subject-line tests and proposals.
--
-- An experiment concludes on its pre-registered metric with a holdout. Counts here are caches for
-- the dashboard; the per-send ledger (outreach_sends) and the metrics module are the source of
-- truth, so every report and promotion check agrees.

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  variable TEXT NOT NULL,
  control_template_id TEXT,
  treatment_template_id TEXT,
  primary_metric TEXT NOT NULL CHECK (primary_metric IN ('positive_reply', 'meeting_booked', 'conversation_started', 'signed_up', 'activated', 'paid')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'registered', 'running', 'concluded', 'stopped', 'promoted')),
  population TEXT,
  exclusions TEXT,
  metric_window_days INTEGER,
  baseline_rate REAL,
  min_detectable_effect REAL,
  target_cohort_size INTEGER,
  max_sample_per_arm INTEGER,
  max_duration_days INTEGER NOT NULL DEFAULT 42,
  stopping_rule TEXT,
  parent_experiment_id TEXT,
  approver TEXT,
  approved_at TEXT,
  prereg_locked_at TEXT,
  started_at TEXT,
  concluded_at TEXT,
  promoted_at TEXT,
  confidence REAL,
  conclusion_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS experiments_status ON experiments (status);

-- Assignment of a unit (usually an account, so colleagues share an arm) to an arm.
CREATE TABLE IF NOT EXISTS experiment_assignments (
  scope TEXT NOT NULL CHECK (scope IN ('template_experiment', 'subject_test', 'send_slot')),
  test_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  arm TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  campaign_id TEXT,
  seed TEXT,
  stratum TEXT,
  assigned_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope, test_id, unit_key)
);
CREATE INDEX IF NOT EXISTS experiment_assignments_contact ON experiment_assignments (contact_id);

-- Proposed changes from the weekly review, each waiting for a person.
CREATE TABLE IF NOT EXISTS experiment_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('template_weight', 'holdout_rate', 'signal_source', 'send_time_experiment', 'copy_change')),
  target TEXT NOT NULL,
  current TEXT,
  proposed TEXT NOT NULL,
  reason TEXT,
  prediction TEXT,
  predicted_effect REAL,
  needed_sample INTEGER,
  evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'superseded', 'stale')),
  outcome TEXT,
  outcome_detail TEXT,
  outcome_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS experiment_proposals_status ON experiment_proposals (status);

CREATE TABLE IF NOT EXISTS subject_tests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  template_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'concluded')),
  winner_variant_id TEXT,
  concluded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS subject_variants (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES subject_tests (id) ON DELETE CASCADE,
  subject_text TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS subject_variants_test ON subject_variants (test_id);

CREATE TABLE IF NOT EXISTS subject_assignments (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES subject_tests (id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES subject_variants (id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  campaign_id TEXT,
  draft_id TEXT,
  send_id TEXT,
  replied_at TEXT,
  bounced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS subject_assignments_variant ON subject_assignments (variant_id);
CREATE INDEX IF NOT EXISTS subject_assignments_test ON subject_assignments (test_id);
CREATE INDEX IF NOT EXISTS subject_assignments_contact ON subject_assignments (contact_id);

-- Proposed changes to a tunable setting (a flag value), each waiting for a person.
CREATE TABLE IF NOT EXISTS knob_proposals (
  id TEXT PRIMARY KEY,
  knob TEXT NOT NULL,
  current TEXT,
  proposed TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'superseded', 'stale')),
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS knob_proposals_status ON knob_proposals (status);

-- Win and loss rates per attribute, learned from deal outcomes, for qualification.
CREATE TABLE IF NOT EXISTS qualification_weights (
  attribute TEXT PRIMARY KEY,
  win_count INTEGER NOT NULL DEFAULT 0,
  loss_count INTEGER NOT NULL DEFAULT 0,
  sample_size INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  log_odds REAL,
  confidence REAL,
  last_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
