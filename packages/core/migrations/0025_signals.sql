-- GTM-agents: signal sources: the provider handle behind a non-search source's query row, and the
-- cleaned content of search monitor hits waiting to be processed.
--
-- discovery_queries.provider_ref holds the provider's id for a standing source (a webset), so a
-- later run can poll it. monitor_items.result_id is the provider's result id, unique per monitor, so
-- a redelivered hit is stored once; monitor_items.payload holds the hit's cleaned fields (title, URL,
-- published date) as data until the processor turns it into a candidate.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file once.
ALTER TABLE discovery_queries ADD COLUMN provider_ref TEXT;
-- once: as above.
ALTER TABLE monitor_items ADD COLUMN result_id TEXT;
-- once: as above.
ALTER TABLE monitor_items ADD COLUMN payload TEXT CHECK (payload IS NULL OR json_valid(payload));

CREATE INDEX IF NOT EXISTS discovery_queries_provider_ref ON discovery_queries (search_type, provider_ref);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_items_result ON monitor_items (provider, monitor_id, result_id) WHERE result_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS monitor_items_url ON monitor_items (provider, monitor_id, url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS monitor_items_pending ON monitor_items (processed_at, created_at);
CREATE INDEX IF NOT EXISTS signal_events_entity ON signal_events (source, entity_id, account_key);
