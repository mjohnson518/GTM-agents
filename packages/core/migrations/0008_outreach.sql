-- GTM-agents: outreach: campaigns, templates, drafts, the send ledger, sequences, deliverability
-- and reply handling.
--
-- Mail is plain text with no tracking pixels or click tracking, so nothing here counts opens or
-- clicks: replies are the metric. Draft statuses run draft -> pending_approval -> approved ->
-- sent | rejected, and an approval binds to approved_digest (see security/approval-digest.ts).
-- "Do this send exactly once" is the effects ledger (event_effects), not a table of its own.

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  tier INTEGER CHECK (tier IS NULL OR tier BETWEEN 1 AND 3),
  template_id TEXT,
  target_count INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS campaigns_status ON campaigns (status);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  draft_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'replied', 'converted', 'bounced', 'opted_out', 'skipped')),
  sequence_step INTEGER,
  next_send_at TEXT,
  sequence_active INTEGER NOT NULL DEFAULT 0 CHECK (sequence_active IN (0, 1)),
  sequence_paused_at TEXT,
  sequence_pause_reason TEXT,
  experiment_id TEXT,
  experiment_arm TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS campaign_contacts_contact ON campaign_contacts (contact_id);
CREATE INDEX IF NOT EXISTS campaign_contacts_due ON campaign_contacts (sequence_active, next_send_at);

-- The templates uploaded from templates/, with usage counts. The file is the source of truth for
-- content; body_sha256 ties each send to the exact version used.
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('cold_intro', 'follow_up', 'breakup', 'check_in', 'proposal', 'lifecycle')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
  step INTEGER,
  angle TEXT,
  subject TEXT,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  volume_weight REAL NOT NULL DEFAULT 1 CHECK (volume_weight >= 0),
  segments TEXT CHECK (segments IS NULL OR json_valid(segments)),
  personas TEXT CHECK (personas IS NULL OR json_valid(personas)),
  team_sizes TEXT CHECK (team_sizes IS NULL OR json_valid(team_sizes)),
  times_used INTEGER NOT NULL DEFAULT 0,
  times_replied INTEGER NOT NULL DEFAULT 0,
  times_meeting INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS templates_kind ON templates (kind, status);

-- Operator-written lines that templates assemble: one per segment, team size or persona.
CREATE TABLE IF NOT EXISTS copy_lines (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('segment', 'team_size', 'persona')),
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (kind, key)
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  deal_id TEXT REFERENCES deals (id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES campaigns (id) ON DELETE SET NULL,
  template_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('cold_intro', 'follow_up', 'breakup', 'check_in', 'proposal', 'lifecycle', 'reply', 'warm_intro', 'recap', 'referral_ask', 'proof_of_value')),
  recipient_email TEXT,
  recipient_name TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'rejected')),
  approved_digest TEXT CHECK (approved_digest IS NULL OR length(approved_digest) = 64),
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  idempotency_key TEXT UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status <> 'approved' OR approved_digest IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS drafts_status ON drafts (status, created_at);
CREATE INDEX IF NOT EXISTS drafts_contact ON drafts (contact_id);
CREATE INDEX IF NOT EXISTS drafts_campaign ON drafts (campaign_id);
CREATE INDEX IF NOT EXISTS drafts_deal ON drafts (deal_id);
CREATE INDEX IF NOT EXISTS drafts_recipient ON drafts (recipient_email);

-- Editing the content of an approved draft returns it to review, whatever code makes the edit:
-- an approval covers exactly the content that was approved.
CREATE TRIGGER IF NOT EXISTS drafts_edit_returns_to_review
AFTER UPDATE OF recipient_email, subject, body ON drafts
WHEN OLD.status = 'approved'
  AND (NEW.recipient_email IS NOT OLD.recipient_email OR NEW.subject IS NOT OLD.subject OR NEW.body IS NOT OLD.body)
BEGIN
  UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL WHERE id = NEW.id;
END;

-- Every touch, inbound or outbound, on any channel, for the contact's history. Manual channels
-- (a LinkedIn message the operator sent by hand) are recorded here; nothing posts automatically.
CREATE TABLE IF NOT EXISTS outreach_log (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'linkedin', 'x', 'phone', 'meeting', 'other')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  subject TEXT,
  summary TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'replied', 'bounced', 'opted_out', 'no_response')),
  provider TEXT,
  provider_message_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS outreach_log_contact ON outreach_log (contact_id, created_at);

-- The per-send ledger: one row per email sent, the basis of every outreach metric and experiment.
-- Rows outlive the contact (contact_id is cleared on erasure) so measurement stays honest.
CREATE TABLE IF NOT EXISTS outreach_sends (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  account_key TEXT,
  campaign_id TEXT,
  draft_id TEXT,
  template_id TEXT,
  template_sha256 TEXT,
  body_sha256 TEXT,
  subject TEXT,
  subject_test_id TEXT,
  subject_variant_id TEXT,
  experiment_id TEXT,
  experiment_arm TEXT,
  sequence_step INTEGER,
  send_path TEXT NOT NULL CHECK (send_path IN ('cold', 'sequence', 'reply', 'lifecycle')),
  channel TEXT NOT NULL DEFAULT 'email',
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  recipient_domain TEXT,
  cohort TEXT,
  send_slot TEXT,
  send_slot_on_time INTEGER CHECK (send_slot_on_time IS NULL OR send_slot_on_time IN (0, 1)),
  sent_at TEXT NOT NULL,
  delivered_at TEXT,
  bounced_at TEXT,
  complained_at TEXT,
  replied_at TEXT,
  reply_intent TEXT,
  reply_after_step INTEGER,
  positive_reply_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS outreach_sends_contact ON outreach_sends (contact_id, sent_at);
CREATE INDEX IF NOT EXISTS outreach_sends_account ON outreach_sends (account_key, sent_at);
CREATE INDEX IF NOT EXISTS outreach_sends_domain ON outreach_sends (recipient_domain, sent_at);
CREATE INDEX IF NOT EXISTS outreach_sends_sent ON outreach_sends (sent_at);
CREATE INDEX IF NOT EXISTS outreach_sends_experiment ON outreach_sends (experiment_id, experiment_arm);
CREATE UNIQUE INDEX IF NOT EXISTS outreach_sends_provider_message ON outreach_sends (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS outreach_sequence_runs (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  campaign_id TEXT,
  experiment_id TEXT,
  workflow_instance_id TEXT,
  current_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('running', 'awaiting_decision', 'completed', 'cancelled', 'replied', 'timed_out', 'escalated')),
  exit_reason TEXT,
  started_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS outreach_sequence_runs_contact ON outreach_sequence_runs (contact_id, status);

-- Contacts held out of cold outreach as the no-send control.
CREATE TABLE IF NOT EXISTS outreach_holdout (
  contact_id TEXT PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  cohort TEXT NOT NULL,
  held_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Sends held for later: outside the recipient's send window, or waiting on a cap.
CREATE TABLE IF NOT EXISTS deferred_sends (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  campaign_id TEXT,
  draft_id TEXT,
  experiment_id TEXT,
  experiment_arm TEXT,
  send_path TEXT NOT NULL CHECK (send_path IN ('cold', 'sequence', 'reply', 'lifecycle')),
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  defer_reason TEXT NOT NULL,
  recipient_timezone TEXT,
  next_attempt_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'cancelled')),
  last_error TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS deferred_sends_due ON deferred_sends (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS deferred_sends_contact ON deferred_sends (contact_id);
CREATE INDEX IF NOT EXISTS deferred_sends_recipient ON deferred_sends (recipient_email);

CREATE TABLE IF NOT EXISTS send_slot_schedules (
  draft_id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  timezone TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS send_slot_schedules_contact ON send_slot_schedules (contact_id);

-- Each follow-up decision: drafted, sent, or skipped and why.
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expected_state TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('drafted', 'sent', 'skipped_state_changed', 'skipped_gate', 'skipped_blocked', 'failed')),
  draft_id TEXT,
  gate_probability REAL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS followups_contact ON followups (contact_id, created_at);

-- Multithreading (a colleague after silence) and re-engagement (a new signal) touches.
CREATE TABLE IF NOT EXISTS followup_touches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('multithread', 'reengage')),
  account_key TEXT,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  source_contact_id TEXT,
  signal_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS followup_touches_account ON followup_touches (account_key, created_at);
CREATE INDEX IF NOT EXISTS followup_touches_contact ON followup_touches (contact_id);

-- A manual touch the operator is asked to make on another channel. Nothing is posted for them.
CREATE TABLE IF NOT EXISTS manual_touches (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  channel TEXT CHECK (channel IS NULL OR channel IN ('linkedin', 'x', 'phone', 'other')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'expired')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS manual_touches_status ON manual_touches (status, expires_at);
CREATE INDEX IF NOT EXISTS manual_touches_contact ON manual_touches (contact_id);

-- Cached verification results, keyed by the address's hash so erasure leaves nothing readable.
CREATE TABLE IF NOT EXISTS email_verifications (
  email_sha256 TEXT PRIMARY KEY CHECK (length(email_sha256) = 64 AND email_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('deliverable', 'risky', 'undeliverable', 'unknown')),
  provider TEXT NOT NULL,
  score REAL,
  disposable INTEGER CHECK (disposable IS NULL OR disposable IN (0, 1)),
  webmail INTEGER CHECK (webmail IS NULL OR webmail IN (0, 1)),
  accept_all INTEGER CHECK (accept_all IS NULL OR accept_all IN (0, 1)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Delivery outcomes per recipient domain, for per-domain caps and the bounce monitor.
CREATE TABLE IF NOT EXISTS domain_delivery (
  domain TEXT PRIMARY KEY,
  sends INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  hard_bounces INTEGER NOT NULL DEFAULT 0,
  complaints INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Seed inbox placement checks: where a batch's mail landed (inbox, promotions, spam).
CREATE TABLE IF NOT EXISTS seed_placements (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  seed_address TEXT NOT NULL,
  mailbox_provider TEXT NOT NULL,
  template_id TEXT,
  provider_message_id TEXT,
  sent_at TEXT,
  checked_at TEXT,
  placement TEXT CHECK (placement IS NULL OR placement IN ('inbox', 'promotions', 'spam', 'missing')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS seed_placements_batch ON seed_placements (batch_id);

-- Quality gate verdicts on drafts, batches, replies and follow-ups.
CREATE TABLE IF NOT EXISTS quality_checks (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('draft', 'batch', 'reply', 'followup')),
  subject_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'hold', 'block')),
  score REAL NOT NULL,
  findings TEXT CHECK (findings IS NULL OR json_valid(findings)),
  judge TEXT CHECK (judge IS NULL OR json_valid(judge)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS quality_checks_subject ON quality_checks (subject_type, subject_id);

-- Approved links a reply may offer: a demo, a sample, a walkthrough.
CREATE TABLE IF NOT EXISTS reply_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('demo', 'sample', 'workflow', 'other')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- How a reply qualifies: book a meeting, ask a question, or pass.
CREATE TABLE IF NOT EXISTS reply_qualifications (
  inbound_id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('book', 'ask', 'pass')),
  problem_quote TEXT,
  role_fit TEXT NOT NULL,
  icp_fit TEXT NOT NULL,
  timing TEXT,
  meeting_requested INTEGER NOT NULL DEFAULT 0 CHECK (meeting_requested IN (0, 1)),
  proposed_time TEXT,
  gaps TEXT CHECK (gaps IS NULL OR json_valid(gaps)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS reply_qualifications_contact ON reply_qualifications (contact_id);

-- The objection library: real objections and the answers the operator approved.
CREATE TABLE IF NOT EXISTS objections (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  verbatim_example TEXT,
  competitor TEXT,
  deal_stage TEXT,
  response_template TEXT NOT NULL,
  approved_digest TEXT CHECK (approved_digest IS NULL OR length(approved_digest) = 64),
  success_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- How to write to each persona (a persona id from the brain), with measured results.
CREATE TABLE IF NOT EXISTS persona_playbooks (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL UNIQUE,
  goal TEXT NOT NULL,
  tone TEXT,
  opener TEXT,
  value_frame TEXT,
  cta TEXT,
  proof_points TEXT CHECK (proof_points IS NULL OR json_valid(proof_points)),
  avoid TEXT CHECK (avoid IS NULL OR json_valid(avoid)),
  success_rate REAL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
