-- GTM-agents: the pipeline: deals, meetings, proof-of-value requests, billing and referrals.
--
-- Deal stages run prospecting -> contacted -> engaged -> demo_scheduled -> trial -> proposal ->
-- negotiation -> closed_won | closed_lost. A deal moves forward only, by compare-and-set, and every
-- move writes a deal_stage_history row; the allowed moves are defined once, in code
-- (packages/core/src/data/deals.ts). Money is stored in integer cents.

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  account_key TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'prospecting' CHECK (stage IN ('prospecting', 'contacted', 'engaged', 'demo_scheduled', 'trial', 'proposal', 'negotiation', 'closed_won', 'closed_lost')),
  value_cents INTEGER CHECK (value_cents IS NULL OR value_cents >= 0),
  currency TEXT,
  probability REAL CHECK (probability IS NULL OR probability BETWEEN 0 AND 1),
  next_action TEXT,
  next_action_at TEXT,
  loss_reason TEXT CHECK (loss_reason IS NULL OR loss_reason IN ('no_budget', 'no_need', 'timing', 'competitor', 'no_decision', 'churned', 'unresponsive', 'other')),
  source TEXT,
  notes TEXT,
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS deals_stage ON deals (stage);
CREATE INDEX IF NOT EXISTS deals_account ON deals (account_key);
CREATE INDEX IF NOT EXISTS deals_contact ON deals (contact_id);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  from_stage TEXT NOT NULL CHECK (from_stage IN ('prospecting', 'contacted', 'engaged', 'demo_scheduled', 'trial', 'proposal', 'negotiation', 'closed_won', 'closed_lost')),
  to_stage TEXT NOT NULL CHECK (to_stage IN ('prospecting', 'contacted', 'engaged', 'demo_scheduled', 'trial', 'proposal', 'negotiation', 'closed_won', 'closed_lost')),
  reason TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS deal_stage_history_deal ON deal_stage_history (deal_id, created_at);

-- A brief handed to the operator when a deal needs a person (a meeting booked, a buying signal).
CREATE TABLE IF NOT EXISTS deal_handoffs (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  brief_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'actioned', 'closed')),
  notified_at TEXT,
  acknowledged_at TEXT,
  actioned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS deal_handoffs_status ON deal_handoffs (status);
CREATE INDEX IF NOT EXISTS deal_handoffs_deal ON deal_handoffs (deal_id);

-- Why a deal was won or lost, for qualification weights and the retrospective.
CREATE TABLE IF NOT EXISTS deal_outcomes (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'no_decision')),
  value_cents INTEGER,
  cycle_days INTEGER,
  touches INTEGER,
  primary_reason TEXT,
  decision_driver TEXT,
  competitor TEXT,
  lessons TEXT,
  attribute_snapshot TEXT CHECK (attribute_snapshot IS NULL OR json_valid(attribute_snapshot)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS deal_outcomes_deal ON deal_outcomes (deal_id);

-- Meetings with notes or a transcript, and what was learned from them. Deleted with the contact,
-- since notes and summaries are personal data.
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  deal_id TEXT REFERENCES deals (id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  title TEXT,
  occurred_at TEXT,
  duration_minutes INTEGER,
  transcript_key TEXT,
  summary TEXT,
  pain_points TEXT CHECK (pain_points IS NULL OR json_valid(pain_points)),
  objections TEXT CHECK (objections IS NULL OR json_valid(objections)),
  competitors_mentioned TEXT CHECK (competitors_mentioned IS NULL OR json_valid(competitors_mentioned)),
  next_steps TEXT CHECK (next_steps IS NULL OR json_valid(next_steps)),
  sentiment TEXT CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'mixed')),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS meetings_contact ON meetings (contact_id);
CREATE INDEX IF NOT EXISTS meetings_deal ON meetings (deal_id);

-- Booked calls from calendar sync. Event titles are never read or stored: only the time, the
-- attendee and the follow-up state.
CREATE TABLE IF NOT EXISTS calendar_meetings (
  event_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  attribution TEXT,
  reminded_24h_at TEXT,
  reminded_1h_at TEXT,
  prep_sent_at TEXT,
  held_asked_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('held', 'no_show', 'rescheduled', 'cancelled')),
  outcome_at TEXT,
  rebook_at TEXT,
  sequence_step INTEGER,
  sequence_next_at TEXT,
  sequence_stopped INTEGER NOT NULL DEFAULT 0 CHECK (sequence_stopped IN (0, 1)),
  recap_draft_id TEXT,
  recap_sent_at TEXT,
  notes_key TEXT,
  first_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS calendar_meetings_contact ON calendar_meetings (contact_id);
CREATE INDEX IF NOT EXISTS calendar_meetings_starts ON calendar_meetings (starts_at);


-- Requests to the product to run its analysis on something the prospect cares about. Sending the
-- result is permanently human.
CREATE TABLE IF NOT EXISTS proof_of_value_requests (
  request_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  account_key TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'drafted')),
  error TEXT,
  draft_id TEXT,
  requested_by TEXT,
  share_url TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  views_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS proof_of_value_status ON proof_of_value_requests (status);
CREATE INDEX IF NOT EXISTS proof_of_value_contact ON proof_of_value_requests (contact_id);

-- Customer subscriptions as the system tracks them for renewals, expansion and churn risk.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  account_key TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  plan TEXT NOT NULL,
  mrr_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'renewed', 'expansion_candidate', 'churn_risk')),
  started_at TEXT NOT NULL,
  renewal_at TEXT,
  health_score REAL,
  last_activity_at TEXT,
  expansion_signals TEXT CHECK (expansion_signals IS NULL OR json_valid(expansion_signals)),
  churn_signals TEXT CHECK (churn_signals IS NULL OR json_valid(churn_signals)),
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions (status, renewal_at);
CREATE INDEX IF NOT EXISTS subscriptions_contact ON subscriptions (contact_id);

-- The billing provider's view of a customer, kept in step by its webhooks.
CREATE TABLE IF NOT EXISTS billing_customers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  provider_subscription_id TEXT,
  contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  email_sha256 TEXT CHECK (email_sha256 IS NULL OR (length(email_sha256) = 64 AND email_sha256 NOT GLOB '*[^0-9a-f]*')),
  plan TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'checkout_pending', 'trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'canceled')),
  last_checkout_at TEXT,
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, provider_customer_id)
);
CREATE INDEX IF NOT EXISTS billing_customers_contact ON billing_customers (contact_id);

-- One row per UTC day: monthly recurring revenue and paying customers.
CREATE TABLE IF NOT EXISTS mrr_snapshots (
  date TEXT PRIMARY KEY CHECK (length(date) = 10),
  mrr_cents INTEGER NOT NULL,
  paying INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  referee_name TEXT,
  referee_email TEXT,
  referee_account_key TEXT,
  status TEXT NOT NULL DEFAULT 'asked' CHECK (status IN ('asked', 'intro_made', 'meeting_booked', 'deal_created', 'closed_won', 'declined', 'expired')),
  asked_at TEXT,
  intro_at TEXT,
  deal_id TEXT REFERENCES deals (id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer_contact_id);
CREATE INDEX IF NOT EXISTS referrals_deal ON referrals (deal_id);

-- Opaque tokens on product links, so a sign-up can be credited to the touch that produced it.
CREATE TABLE IF NOT EXISTS ref_tokens (
  token TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  campaign_id TEXT,
  send_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ref_tokens_contact ON ref_tokens (contact_id);
