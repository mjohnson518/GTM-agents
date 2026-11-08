-- GTM-agents: baseline schema.
--
-- schema_meta records facts about the database itself, such as the baseline it was created from.
-- D1 applies each migration once and never re-runs it, so a migration is never edited after it has
-- been applied anywhere: schema changes go in a new, higher-numbered file.
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('baseline', '1');
