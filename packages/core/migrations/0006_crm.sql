-- GTM-agents: the CRM: accounts, contacts and what the system knows about them.
--
-- Conventions (docs/DATA-MODEL.md has the full list):
--   - account_key is the lowercased registrable domain (acme.example). Everything account-level
--     joins on it; a personal or shared-host domain is never an account.
--   - contact warmth runs cold -> contacted -> warming -> engaged -> hot -> customer, with churned
--     and opted_out as terminal side states. Warmth only moves forward, by compare-and-set, and a
--     trigger keeps terminal states terminal.
--   - domain-specific fields go in the attributes JSON column, never in new columns.
--   - timestamps are ISO 8601 UTC text, so they compare correctly as strings.
--   - per-contact state is deleted with the contact (ON DELETE CASCADE), so erasure is one delete.

CREATE TABLE IF NOT EXISTS accounts (
  account_key TEXT PRIMARY KEY CHECK (account_key = lower(account_key) AND instr(account_key, '.') > 0),
  name TEXT NOT NULL,
  domain TEXT,
  tier INTEGER NOT NULL DEFAULT 3 CHECK (tier BETWEEN 1 AND 3),
  segment TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'won', 'lost', 'dormant')),
  coverage_score REAL NOT NULL DEFAULT 0,
  coverage_gap TEXT CHECK (coverage_gap IS NULL OR json_valid(coverage_gap)),
  primary_contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS accounts_tier ON accounts (tier);
CREATE INDEX IF NOT EXISTS accounts_status ON accounts (status);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  -- The normalized address and its hashes. mailbox_sha256 drops any +tag, so suppression and
  -- erasure match every subaddress of one mailbox.
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  email_sha256 TEXT NOT NULL UNIQUE CHECK (length(email_sha256) = 64 AND email_sha256 NOT GLOB '*[^0-9a-f]*'),
  mailbox_sha256 TEXT NOT NULL CHECK (length(mailbox_sha256) = 64 AND mailbox_sha256 NOT GLOB '*[^0-9a-f]*'),
  account_key TEXT,
  job_title TEXT,
  department TEXT,
  location TEXT,
  timezone TEXT,
  source TEXT,
  candidate_id TEXT,
  discovery_query_id TEXT,
  warmth TEXT NOT NULL DEFAULT 'cold' CHECK (warmth IN ('cold', 'contacted', 'warming', 'engaged', 'hot', 'customer', 'churned', 'opted_out')),
  last_contacted_at TEXT,
  total_touches INTEGER NOT NULL DEFAULT 0,
  email_source TEXT,
  email_confidence TEXT CHECK (email_confidence IS NULL OR email_confidence IN ('high', 'medium', 'low')),
  verification_status TEXT CHECK (verification_status IS NULL OR verification_status IN ('deliverable', 'risky', 'undeliverable', 'unknown')),
  verified_at TEXT,
  enriched_at TEXT,
  employment_status TEXT CHECK (employment_status IS NULL OR employment_status IN ('current', 'moved', 'unknown')),
  employment_checked_at TEXT,
  declined_at TEXT,
  research_brief_key TEXT,
  notes TEXT,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS contacts_account ON contacts (account_key);
CREATE INDEX IF NOT EXISTS contacts_warmth ON contacts (warmth);
CREATE INDEX IF NOT EXISTS contacts_mailbox ON contacts (mailbox_sha256);
CREATE INDEX IF NOT EXISTS contacts_verified ON contacts (verified_at);
CREATE INDEX IF NOT EXISTS contacts_employment ON contacts (employment_status, employment_checked_at);

-- Terminal warmth is sticky in the database too, whatever code writes it: an opted_out contact
-- stays opted_out, and a churned contact can only opt out.
CREATE TRIGGER IF NOT EXISTS contacts_terminal_warmth
BEFORE UPDATE OF warmth ON contacts
WHEN (OLD.warmth = 'opted_out' AND NEW.warmth <> 'opted_out')
  OR (OLD.warmth = 'churned' AND NEW.warmth NOT IN ('churned', 'opted_out'))
BEGIN
  SELECT RAISE(ABORT, 'warmth cannot leave a terminal state');
END;

-- An opted-out contact can only be deleted once its opt-out is kept elsewhere (a tombstone or a
-- suppression entry), so deleting the row never makes the address sendable again. eraseContact
-- writes the tombstone first.
CREATE TRIGGER IF NOT EXISTS contacts_keep_opt_out
BEFORE DELETE ON contacts
WHEN OLD.warmth = 'opted_out'
  AND NOT EXISTS (SELECT 1 FROM erasure_tombstones WHERE email_sha256 IN (OLD.email_sha256, OLD.mailbox_sha256) OR mailbox_sha256 = OLD.mailbox_sha256)
  AND NOT EXISTS (SELECT 1 FROM suppression WHERE email_sha256 IN (OLD.email_sha256, OLD.mailbox_sha256))
BEGIN
  SELECT RAISE(ABORT, 'record the opt-out (tombstone or suppression) before deleting an opted-out contact');
END;

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (contact_id, tag)
);
CREATE INDEX IF NOT EXISTS contact_tags_tag ON contact_tags (tag);

-- The customer lifecycle state machine. One module writes it, by compare-and-set; attribution
-- fields are set once; first-time timestamps are never overwritten.
CREATE TABLE IF NOT EXISTS contact_lifecycle (
  contact_id TEXT PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'sighted', 'qualified', 'parked', 'contacted', 'engaged', 'nurturing', 'opted_out',
    'signed_up', 'stalled', 'activated', 'at_wall', 'paying', 'expanding', 'at_risk', 'churned',
    'deleted')),
  product_user_id TEXT UNIQUE,
  product_org_id TEXT,
  plan_tier TEXT,
  subscription_status TEXT,
  mrr_cents INTEGER NOT NULL DEFAULT 0,
  attribution_method TEXT CHECK (attribution_method IS NULL OR attribution_method IN ('ref_token', 'email', 'domain', 'inbound')),
  attributed_campaign_id TEXT,
  signup_ref TEXT,
  signed_up_at TEXT,
  activated_at TEXT,
  first_paid_at TEXT,
  churned_at TEXT,
  last_active_at TEXT,
  usage TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage)),
  state_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS contact_lifecycle_state ON contact_lifecycle (state, state_changed_at);
CREATE INDEX IF NOT EXISTS contact_lifecycle_org ON contact_lifecycle (product_org_id);

CREATE TABLE IF NOT EXISTS contact_scores (
  contact_id TEXT PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  total INTEGER NOT NULL,
  icp_points INTEGER NOT NULL,
  title_points INTEGER NOT NULL,
  signal_points INTEGER NOT NULL,
  angle_points INTEGER NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('first_touch', 'soft_touch', 'nurture', 'no_contact')),
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS contact_scores_total ON contact_scores (total DESC);

CREATE TABLE IF NOT EXISTS contact_engagement (
  contact_id TEXT PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  engagement_score REAL NOT NULL DEFAULT 0 CHECK (engagement_score BETWEEN 0 AND 1),
  trend TEXT CHECK (trend IS NULL OR trend IN ('rising', 'stable', 'declining', 'cold')),
  top_signals TEXT CHECK (top_signals IS NULL OR json_valid(top_signals)),
  last_event_at TEXT,
  last_recomputed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The reason to write to someone now: one angle per contact, from a dated signal.
CREATE TABLE IF NOT EXISTS contact_angles (
  contact_id TEXT PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  signal_id TEXT,
  angle_kind TEXT NOT NULL,
  why_them TEXT,
  why_now TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium')),
  do_not_mention TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-field evidence, with conflicts held for a person to resolve.
CREATE TABLE IF NOT EXISTS contact_evidence (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  candidate_id TEXT,
  field TEXT NOT NULL CHECK (field IN ('email', 'job_title', 'employer_domain')),
  value TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_url TEXT,
  fetched_at TEXT NOT NULL,
  verified_at TEXT,
  confidence REAL,
  conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
  conflict_with TEXT CHECK (conflict_with IS NULL OR json_valid(conflict_with)),
  resolved_at TEXT,
  resolved_by TEXT,
  retention_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (contact_id IS NOT NULL OR candidate_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS contact_evidence_contact ON contact_evidence (contact_id, field);
CREATE INDEX IF NOT EXISTS contact_evidence_candidate ON contact_evidence (candidate_id, field);
CREATE INDEX IF NOT EXISTS contact_evidence_open_conflict ON contact_evidence (conflict, resolved_at) WHERE conflict = 1;
CREATE INDEX IF NOT EXISTS contact_evidence_retention ON contact_evidence (retention_until);

CREATE TABLE IF NOT EXISTS contact_fit (
  contact_id TEXT PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('keep', 'maybe', 'drop')),
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('rule', 'model', 'brain')),
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS contact_fit_decision ON contact_fit (decision);

-- Which people at an account the system covers, and in which buying role (a persona id from the
-- brain's personas component).
CREATE TABLE IF NOT EXISTS account_contacts (
  account_key TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  persona TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_key, contact_id)
);
CREATE INDEX IF NOT EXISTS account_contacts_contact ON account_contacts (contact_id);

-- A pointer to the account's research context in blob storage, with recent activity counts.
CREATE TABLE IF NOT EXISTS account_context (
  account_key TEXT PRIMARY KEY,
  blob_key TEXT NOT NULL,
  signals_30d INTEGER NOT NULL DEFAULT 0,
  posts_30d INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A small relationship graph: people, accounts, products and topics, and the ties between them.
CREATE TABLE IF NOT EXISTS graph_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'account', 'product', 'event', 'topic', 'other')),
  name TEXT NOT NULL,
  canonical_id TEXT,
  aliases TEXT CHECK (aliases IS NULL OR json_valid(aliases)),
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS graph_entities_kind ON graph_entities (kind);
CREATE INDEX IF NOT EXISTS graph_entities_name ON graph_entities (name);
CREATE INDEX IF NOT EXISTS graph_entities_canonical ON graph_entities (canonical_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_edges_unique ON graph_edges (from_id, to_id, kind);
CREATE INDEX IF NOT EXISTS graph_edges_to ON graph_edges (to_id, kind);
