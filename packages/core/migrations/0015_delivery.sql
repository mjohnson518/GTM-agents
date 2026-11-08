-- GTM-agents: delivery: what the deferred send queue needs to replay a message exactly.
--
-- A deferred send is replayed through the same send function as the original, so each
-- deferred_sends row has one deferred_send_items row keeping the rest of the outreach item: its
-- idempotency key (claimed in the effects ledger at send time, so a replay never sends twice) and,
-- as JSON, the fields deferred_sends has no column for (threading ids, the approved digest, the
-- template and sequence step, the recipient's display name).
--
-- dedup_key is the SHA-256 of (contact, campaign, subject, path, step) while the row is queued. At most one
-- row may hold a given key, so deferring the same message again updates the queued row instead
-- of adding one. The key is cleared as soon as the row leaves the queue, whatever code moves it.
-- Erasure deletes deferred_sends rows by recipient address, and these rows go with them.
CREATE TABLE IF NOT EXISTS deferred_send_items (
  deferred_id TEXT PRIMARY KEY REFERENCES deferred_sends (id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  dedup_key TEXT CHECK (dedup_key IS NULL OR (length(dedup_key) = 64 AND dedup_key NOT GLOB '*[^0-9a-f]*')),
  item TEXT NOT NULL CHECK (json_valid(item)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS deferred_send_items_dedup ON deferred_send_items (dedup_key) WHERE dedup_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS deferred_sends_release_dedup
AFTER UPDATE OF status ON deferred_sends
WHEN NEW.status <> 'queued'
BEGIN
  UPDATE deferred_send_items SET dedup_key = NULL WHERE deferred_id = NEW.id;
END;
