-- GTM-agents: the effects ledger.
--
-- Every side effect outside the database (an email, a page, a webhook call, a counter bump that a
-- retry must not repeat) is claimed here first. The primary key makes the claim exactly-once: the
-- first INSERT OR IGNORE for an (event_id, effect) pair inserts a row, and every later attempt,
-- including concurrent ones, inserts nothing.
CREATE TABLE IF NOT EXISTS event_effects (
  event_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, effect)
);
