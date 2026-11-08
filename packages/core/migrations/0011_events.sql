-- GTM-agents: the event spine and the records it keeps: inbound mail, events from the product and
-- providers, funnel and engagement events, lifecycle transitions and erasure tombstones.
--
-- Every event carries a taint level. Free text from outside (an inbound email body, product
-- feedback) is full taint. Payloads live in blob storage; rows here hold the key.

CREATE TABLE IF NOT EXISTS inbound_emails (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT,
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  subject TEXT,
  body_preview TEXT,
  body_key TEXT,
  received_at TEXT NOT NULL,
  classification TEXT CHECK (classification IS NULL OR classification IN ('reply', 'new_inquiry', 'auto_reply', 'out_of_office', 'spam', 'bounce', 'unsubscribe', 'unclassified')),
  intent TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  deal_id TEXT,
  draft_id TEXT,
  provider_draft_id TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'notified', 'draft_created', 'responded', 'ignored', 'archived')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  reply_owed_since TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX IF NOT EXISTS inbound_emails_status ON inbound_emails (status, received_at);
CREATE INDEX IF NOT EXISTS inbound_emails_contact ON inbound_emails (contact_id);
CREATE INDEX IF NOT EXISTS inbound_emails_thread ON inbound_emails (provider_thread_id);
CREATE INDEX IF NOT EXISTS inbound_emails_sender ON inbound_emails (sender_email);

-- The event spine: every inbound event is recorded first, then routed. Routing side effects are
-- claimed in event_effects, so redelivery never repeats them.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  account_key TEXT,
  subject_ref TEXT,
  payload_key TEXT,
  taint TEXT NOT NULL CHECK (taint IN ('none', 'metadata', 'structured', 'full')),
  routed_at TEXT,
  routing_started_at TEXT,
  route_attempts INTEGER NOT NULL DEFAULT 0,
  route_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS events_unrouted ON events (routed_at, received_at);
CREATE INDEX IF NOT EXISTS events_contact ON events (contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_type ON events (type, occurred_at);

-- Funnel steps from outreach to payment, for the conversion report.
CREATE TABLE IF NOT EXISTS funnel_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('outreach_sent', 'outreach_replied', 'outreach_bounced', 'signed_up', 'activated', 'limit_reached', 'subscribed', 'churned', 'demo_scheduled', 'demo_completed', 'trial_started', 'trial_converted')),
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'product', 'webhook', 'manual')),
  campaign_id TEXT,
  experiment_id TEXT,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS funnel_events_type ON funnel_events (event_type, occurred_at);
CREATE INDEX IF NOT EXISTS funnel_events_contact ON funnel_events (contact_id);

-- Weighted engagement events that feed the engagement score.
CREATE TABLE IF NOT EXISTS engagement_events (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('reply', 'meeting_scheduled', 'meeting_attended', 'meeting_no_show', 'deal_created', 'deal_stage_forward', 'referral_given', 'proposal_viewed', 'pricing_asked', 'stakeholder_looped', 'ghosted')),
  weight REAL NOT NULL,
  source TEXT,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS engagement_events_contact ON engagement_events (contact_id, created_at);

-- Every lifecycle state change, with the event that caused it.
CREATE TABLE IF NOT EXISTS lifecycle_transitions (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event_id TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS lifecycle_transitions_contact ON lifecycle_transitions (contact_id, occurred_at);

-- What remains after an erasure: the address hashes, so the person is never re-added or emailed.
-- mailbox_sha256 (the address without a +tag) is set when the address was known at erasure time; an
-- erasure that arrives as a hash only can block the exact address only.
CREATE TABLE IF NOT EXISTS erasure_tombstones (
  email_sha256 TEXT PRIMARY KEY CHECK (length(email_sha256) = 64 AND email_sha256 NOT GLOB '*[^0-9a-f]*'),
  mailbox_sha256 TEXT CHECK (mailbox_sha256 IS NULL OR (length(mailbox_sha256) = 64 AND mailbox_sha256 NOT GLOB '*[^0-9a-f]*')),
  product_user_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('product', 'operator', 'reply', 'reconciliation')),
  erased_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS erasure_tombstones_mailbox ON erasure_tombstones (mailbox_sha256);
