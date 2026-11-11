-- GTM-agents: monitor article hits as signals (docs/SIGNALS.md).
--
--   - monitor_items.signal_id: one signal_events row (the lowest id) of the event an article hit
--     recorded, or matched as a duplicate, when signals:article_monitors_enabled was on. An event
--     routed to two contacts has a row each, and a row erased with its contact leaves the id behind,
--     so the link is for tracing, not a reference. Null for company-site hits (candidate_id links
--     those) and for hits that became nothing.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file once.
ALTER TABLE monitor_items ADD COLUMN signal_id TEXT;
