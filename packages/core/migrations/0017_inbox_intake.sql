-- GTM-agents: inbox intake columns on inbound_emails.
--
-- Intake (packages/core/src/inbox/intake.ts) records every inbound message once and then applies
-- its deterministic rules. These columns hold what it works out at insert time:
--   - account_key: the sender's account (the contact's, else the sender's registrable domain), so
--     "anyone at the same account replied" is one indexed lookup. NULL for personal mailboxes and
--     for the company's own mail;
--   - message_id: the message's own RFC 5322 Message-ID, so a later message's In-Reply-To or
--     References can be matched to it and a reply can be threaded under it;
--   - headers: the triage and threading headers as JSON (message-id, in-reply-to, references,
--     auto-submitted, precedence, list-id and the like), each capped;
--   - sender_sha256 and sender_mailbox_sha256: the sender's address hashes (exact, and without a
--     +tag), so erasure by hash alone finds the mail a person sent;
--   - failed_recipients: for a delivery report, a JSON list of hashes for every address it says
--     failed permanently, exact then mailbox hash for each, so erasure finds reports about a person
--     and a retry acts on exactly the addresses the first attempt did;
--   - processed_at: when the rules finished. NULL means they still have to run (a compliance write
--     failed, or the run stopped part way), and the minute poll retries those rows.
-- Rows written before this migration are marked processed, so the new rules never run on old mail.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file once.
ALTER TABLE inbound_emails ADD COLUMN account_key TEXT;
-- once: as above.
ALTER TABLE inbound_emails ADD COLUMN message_id TEXT;
-- once: as above.
ALTER TABLE inbound_emails ADD COLUMN headers TEXT CHECK (headers IS NULL OR json_valid(headers));
-- once: as above.
ALTER TABLE inbound_emails ADD COLUMN sender_sha256 TEXT CHECK (sender_sha256 IS NULL OR (length(sender_sha256) = 64 AND sender_sha256 NOT GLOB '*[^0-9a-f]*'));
-- once: as above.
ALTER TABLE inbound_emails ADD COLUMN sender_mailbox_sha256 TEXT CHECK (sender_mailbox_sha256 IS NULL OR (length(sender_mailbox_sha256) = 64 AND sender_mailbox_sha256 NOT GLOB '*[^0-9a-f]*'));
-- once: as above.
ALTER TABLE inbound_emails ADD COLUMN failed_recipients TEXT CHECK (failed_recipients IS NULL OR json_valid(failed_recipients));
-- once: as above.
ALTER TABLE inbound_emails ADD COLUMN processed_at TEXT;

UPDATE inbound_emails SET processed_at = created_at WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS inbound_emails_account ON inbound_emails (account_key, received_at);
CREATE INDEX IF NOT EXISTS inbound_emails_message_id ON inbound_emails (message_id);
CREATE INDEX IF NOT EXISTS inbound_emails_unprocessed ON inbound_emails (created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS inbound_emails_sender_hash ON inbound_emails (sender_sha256);
CREATE INDEX IF NOT EXISTS inbound_emails_sender_mailbox ON inbound_emails (sender_mailbox_sha256);
CREATE INDEX IF NOT EXISTS inbound_emails_reports ON inbound_emails (created_at) WHERE failed_recipients IS NOT NULL;
-- Delivery events and bounces find their send by the provider's own message id.
CREATE INDEX IF NOT EXISTS outreach_sends_provider_message_id ON outreach_sends (provider_message_id) WHERE provider_message_id IS NOT NULL;
