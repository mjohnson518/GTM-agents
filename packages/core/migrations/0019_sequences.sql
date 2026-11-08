-- GTM-agents: the cold sequence's follow-up steps: threading ids on the send ledger, and approval
-- manifests that say which release command they belong to.
--
-- outreach_sends.message_id holds the RFC 5322 Message-ID the provider gave a sent email, in angle
-- brackets. Follow-ups set In-Reply-To and References from it, so every step threads under the first
-- email. The provider's own id (provider_message_id) is known at send time; the Message-ID is looked
-- up from the provider once, when the next step needs it, and kept here, so the database stays the
-- source of truth and no cache is needed.
--
-- approval_manifests.kind separates the cold batch's manifests (released with
-- `batch-release-<id>-<code>`) from follow-up manifests (released with
-- `sequence-release-<id>-<code>`), so neither command can release the other's drafts. A follow-up
-- manifest may cover steps from several campaigns; its campaign_id names the first of them.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file exactly once.
ALTER TABLE outreach_sends ADD COLUMN message_id TEXT;

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file exactly once.
ALTER TABLE approval_manifests ADD COLUMN kind TEXT NOT NULL DEFAULT 'cold_batch' CHECK (kind IN ('cold_batch', 'sequence'));

CREATE INDEX IF NOT EXISTS approval_manifests_kind ON approval_manifests (kind, created_at);
-- The follow-up sweep reads each due contact's earlier steps from the send ledger.
CREATE INDEX IF NOT EXISTS outreach_sends_campaign_contact ON outreach_sends (campaign_id, contact_id, sequence_step);
-- The reply check reads recent inbound mail by time.
CREATE INDEX IF NOT EXISTS inbound_emails_received ON inbound_emails (received_at);
-- Inbound reply matching looks a send up by the Message-ID it was given.
CREATE INDEX IF NOT EXISTS outreach_sends_message_id ON outreach_sends (message_id);
