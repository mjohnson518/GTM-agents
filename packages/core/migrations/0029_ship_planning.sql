-- GTM-agents: the ship loop's planning side (packages/modules/ship, docs/SHIP.md): theme centroids,
-- spec digests, triage attempts and the "you asked, it is live" notes.
--
--   - themes.centroid: the running mean of the embeddings of the theme's feedback summaries, as a
--     JSON array, with the embedding model that produced it (centroid_model) and how many summaries
--     it averages (member_count). The database is the truth: the centroid lives here, and a vector
--     index, if one is ever added, is a cache rebuilt from it;
--   - themes.spec_digest: the SHA-256 of the spec's exact content. An approval binds to it, so a spec
--     edited after it was shown goes back to review. spec_attempts counts spec writes that produced
--     nothing usable, so a theme the writer cannot handle stops costing money;
--   - feedback_items.triage_attempts: triage calls whose answer could not be used. After three, the
--     item is declined rather than retried every day;
--   - ship_notes: one row per requester of a shipped theme. The unique (theme, contact) key is the
--     claim, so announcing a theme twice never drafts or sends a second note. A note is drafted
--     (waiting for ship-note-approve), sending, sent, queued (held by the send function for the send
--     window or a cap), or skipped, rejected, expired or failed, with the reason. Its approval
--     binds to the digest of the draft's exact content, carried in the approve command's code.
-- Erasing a contact deletes their notes (ON DELETE CASCADE).

-- once: the migration runner applies this file a single time; SQLite cannot guard ADD COLUMN.
ALTER TABLE themes ADD COLUMN centroid TEXT CHECK (centroid IS NULL OR json_valid(centroid));
-- once: as above.
ALTER TABLE themes ADD COLUMN centroid_model TEXT;
-- once: as above.
ALTER TABLE themes ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0;
-- once: as above.
ALTER TABLE themes ADD COLUMN spec_digest TEXT CHECK (spec_digest IS NULL OR (length(spec_digest) = 64 AND spec_digest NOT GLOB '*[^0-9a-f]*'));
-- once: as above.
ALTER TABLE themes ADD COLUMN spec_attempts INTEGER NOT NULL DEFAULT 0;
-- once: as above.
ALTER TABLE feedback_items ADD COLUMN triage_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS feedback_items_triaged ON feedback_items (status, theme_id, created_at);

CREATE TABLE IF NOT EXISTS ship_notes (
  id TEXT PRIMARY KEY CHECK (length(id) = 10 AND id NOT GLOB '*[^0-9a-f]*'),
  theme_id TEXT NOT NULL REFERENCES themes (id) ON DELETE CASCADE,
  task_id TEXT REFERENCES ship_tasks (id) ON DELETE SET NULL,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  draft_id TEXT REFERENCES drafts (id) ON DELETE SET NULL,
  level INTEGER CHECK (level IS NULL OR level BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK (status IN ('drafted', 'sending', 'sent', 'queued', 'skipped', 'rejected', 'expired', 'failed')),
  reason TEXT,
  decided_by TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (theme_id, contact_id)
);
CREATE INDEX IF NOT EXISTS ship_notes_status ON ship_notes (status, created_at);
CREATE INDEX IF NOT EXISTS ship_notes_contact ON ship_notes (contact_id);
