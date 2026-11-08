-- GTM-agents: the suppression list. Addresses the system will never email.
--
-- Keyed by the SHA-256 of the normalized address, so an erasure can keep a suppression entry for a
-- person without keeping their address: the plaintext column is optional. There is deliberately no
-- delete path in the code; removing someone from a do-not-contact list is a decision for a person.
CREATE TABLE IF NOT EXISTS suppression (
  email_sha256 TEXT PRIMARY KEY CHECK (length(email_sha256) = 64),
  email TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('opt_out', 'bounce', 'complaint', 'erasure', 'manual', 'do_not_contact')),
  source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
