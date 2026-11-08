-- GTM-agents: reply handling: what triage found in each inbound message, the autonomy class of each
-- reply draft, and erasure of objection examples filed from inbound mail.
--
--   - inbound_emails.triage: triage's structured result as JSON (confidence, verbatim quotes, the
--     meeting and asset flags, the model and the time). The intent itself stays in
--     inbound_emails.intent. Every quote is the sender's own words, checked verbatim against the
--     body: untrusted text, deleted with the row;
--   - drafts.action_class: the autonomy class a reply draft is filed under (reply_send,
--     reply_demo_link or reply_question), so every decision on it is evidence for that class;
--   - an objection triage files for curation keeps the sender's sentence as its example, authored
--     'inbound:<inbound id>'. When that inbound message is deleted (erasure deletes a person's mail),
--     the example is cleared and the row keeps only what people wrote.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file once.
ALTER TABLE inbound_emails ADD COLUMN triage TEXT CHECK (triage IS NULL OR json_valid(triage));
-- once: as above.
ALTER TABLE drafts ADD COLUMN action_class TEXT;

-- Triage picks untriaged mail by time, and the reply clock reads owed mail by intent and status.
CREATE INDEX IF NOT EXISTS inbound_emails_intent ON inbound_emails (intent, status, received_at);
-- The outbox and the mailbox reconciliation read reply drafts by kind and status.
CREATE INDEX IF NOT EXISTS drafts_kind_status ON drafts (kind, status, updated_at);
CREATE INDEX IF NOT EXISTS objections_author ON objections (author);

CREATE TRIGGER IF NOT EXISTS objections_forget_inbound_example
AFTER DELETE ON inbound_emails
BEGIN
  UPDATE objections SET verbatim_example = NULL, author = 'inbound:erased', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE author = 'inbound:' || OLD.id;
END;
