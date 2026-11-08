-- GTM-agents: discovery: search queries, candidates, signals and what is known about accounts.
--
-- Candidate statuses run raw -> enriched -> qualified | borderline | rejected -> promoted |
-- duplicate. A candidate becomes a contact only through promotion, after identity checks and the
-- fit gate. Account-level tables are keyed by account_key.

CREATE TABLE IF NOT EXISTS discovery_queries (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  source TEXT NOT NULL,
  search_type TEXT,
  category TEXT,
  include_domains TEXT CHECK (include_domains IS NULL OR json_valid(include_domains)),
  total_results INTEGER NOT NULL DEFAULT 0,
  total_promoted INTEGER NOT NULL DEFAULT 0,
  total_converted INTEGER NOT NULL DEFAULT 0,
  avg_qualification_score REAL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_run_at TEXT,
  first_promoted_at TEXT,
  deactivated_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS discovery_queries_active ON discovery_queries (is_active, last_run_at);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_ref TEXT,
  query_id TEXT REFERENCES discovery_queries (id) ON DELETE SET NULL,
  search_type TEXT,
  url TEXT,
  result_title TEXT,
  snippet TEXT,
  category TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  job_title TEXT,
  account_name TEXT,
  account_key TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('raw', 'enriched', 'qualified', 'borderline', 'rejected', 'promoted', 'duplicate')),
  qualification_score REAL,
  qualification_notes TEXT,
  icp_score REAL,
  intent_score REAL,
  intent_signals TEXT CHECK (intent_signals IS NULL OR json_valid(intent_signals)),
  email_source TEXT,
  email_steps_tried TEXT CHECK (email_steps_tried IS NULL OR json_valid(email_steps_tried)),
  email_recovery_attempts INTEGER NOT NULL DEFAULT 0,
  promoted_contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  source_contact_id TEXT,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS candidates_status ON candidates (status, created_at);
CREATE INDEX IF NOT EXISTS candidates_account ON candidates (account_key);
CREATE INDEX IF NOT EXISTS candidates_email ON candidates (email);
CREATE INDEX IF NOT EXISTS candidates_promoted ON candidates (promoted_contact_id);
CREATE INDEX IF NOT EXISTS candidates_query ON candidates (query_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_source_ref ON candidates (source, source_ref) WHERE source_ref IS NOT NULL;

-- A cached, generated summary of the ideal customer for search prompts, derived from the brain.
CREATE TABLE IF NOT EXISTS icp_snapshots (
  id TEXT PRIMARY KEY,
  brain_version TEXT,
  summary TEXT NOT NULL,
  search_prompt TEXT NOT NULL,
  micro_verticals TEXT NOT NULL CHECK (json_valid(micro_verticals)),
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Items from a provider's standing monitor or list-building agent, and what became of each.
CREATE TABLE IF NOT EXISTS monitor_items (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  url TEXT,
  candidate_id TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('promoted', 'duplicate', 'skipped', 'error')),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS monitor_items_monitor ON monitor_items (provider, monitor_id);
CREATE INDEX IF NOT EXISTS monitor_items_contact ON monitor_items (contact_id);

-- Dated reasons to write: a job change, a hire, a funding round, a launch.
CREATE TABLE IF NOT EXISTS signal_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('job_change', 'hiring', 'funding', 'launch', 'post', 'news', 'filing', 'product_usage', 'custom')),
  account_key TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  entity_id TEXT,
  headline TEXT NOT NULL,
  evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence)),
  source_url TEXT,
  source TEXT,
  severity REAL NOT NULL DEFAULT 0.5 CHECK (severity BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'actioned', 'dismissed', 'expired')),
  actioned_draft_id TEXT,
  event_date TEXT,
  detected_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS signal_events_status ON signal_events (status, detected_at);
CREATE INDEX IF NOT EXISTS signal_events_account ON signal_events (account_key, detected_at);
CREATE INDEX IF NOT EXISTS signal_events_contact ON signal_events (contact_id);

-- Account fit: a free nightly prescore, then a model score for accounts that pass it.
CREATE TABLE IF NOT EXISTS account_fit (
  account_key TEXT PRIMARY KEY,
  account_name TEXT,
  contacts_count INTEGER NOT NULL DEFAULT 0,
  buyer_count INTEGER NOT NULL DEFAULT 0,
  prescore INTEGER NOT NULL DEFAULT 0 CHECK (prescore BETWEEN 0 AND 100),
  prescore_detail TEXT CHECK (prescore_detail IS NULL OR json_valid(prescore_detail)),
  status TEXT NOT NULL DEFAULT 'prescored' CHECK (status IN ('prescored', 'scored', 'retry', 'unreachable')),
  attempts INTEGER NOT NULL DEFAULT 0,
  fit_score REAL,
  segment TEXT,
  team_size TEXT,
  fit_reasons TEXT CHECK (fit_reasons IS NULL OR json_valid(fit_reasons)),
  disqualifier TEXT,
  fit_model TEXT,
  scored_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS account_fit_status ON account_fit (status, prescore DESC);

-- Firmographic facts from a company data provider.
CREATE TABLE IF NOT EXISTS account_facts (
  account_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'found', 'not_found', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  headcount_band TEXT,
  employees_count INTEGER,
  hq_country TEXT,
  founded_year INTEGER,
  sector TEXT,
  industry TEXT,
  company_type TEXT,
  funding_stage TEXT,
  raised_usd INTEGER,
  technologies TEXT CHECK (technologies IS NULL OR json_valid(technologies)),
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Open roles seen on an account's job boards: hiring signals.
CREATE TABLE IF NOT EXISTS account_hiring_roles (
  account_key TEXT NOT NULL,
  board TEXT NOT NULL,
  role TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  signalled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_key, board, role)
);

-- Job boards found for an account, observed or guessed from its domain.
CREATE TABLE IF NOT EXISTS account_job_boards (
  account_key TEXT NOT NULL,
  board TEXT NOT NULL,
  token TEXT NOT NULL,
  found_by TEXT NOT NULL CHECK (found_by IN ('observed', 'guessed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gone')),
  first_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_key, board, token)
);

CREATE TABLE IF NOT EXISTS account_board_checks (
  account_key TEXT PRIMARY KEY,
  boards INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Company names resolved to domains, so the same name is not looked up twice.
CREATE TABLE IF NOT EXISTS domain_resolutions (
  name_key TEXT PRIMARY KEY,
  domain TEXT,
  method TEXT,
  resolved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Claims on re-sourcing an account (finding more people there), so two runs never do it at once
-- and an account is not re-sourced too often.
CREATE TABLE IF NOT EXISTS resource_claims (
  account_key TEXT PRIMARY KEY,
  resourced_at TEXT NOT NULL,
  previews INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  missing_in_provider INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Model reviews of job titles the rules could not place, cached by normalized title.
CREATE TABLE IF NOT EXISTS title_fit_reviews (
  title_key TEXT PRIMARY KEY,
  decision TEXT NOT NULL CHECK (decision IN ('keep', 'drop')),
  reason TEXT NOT NULL,
  model TEXT,
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
