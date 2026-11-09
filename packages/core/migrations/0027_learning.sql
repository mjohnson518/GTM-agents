-- GTM-agents: self-improvement: one proposal record shared by every loop, the operator's edits that
-- edit mining reads, the daily agent review, and long-term memory text.
--
-- Every loop only proposes. learnings_proposals (0012) is the one proposal record: a snippet for a
-- section of the learnings document, a brain component edit, a voice rebuild, an objection answer,
-- a template candidate for the copy-change gate, an inactive discovery query or a playbook field.
-- proposed_digest binds the approval to the exact detail shown; payload holds what applying needs.
-- packages/core/src/learning/ owns these tables (docs/LEARNING.md).

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file exactly once.
ALTER TABLE learnings_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'learning' CHECK (kind IN ('learning', 'brain', 'voice', 'objection_answer', 'template', 'discovery_query', 'playbook_field'));
-- once: as above.
ALTER TABLE learnings_proposals ADD COLUMN payload TEXT CHECK (payload IS NULL OR json_valid(payload));
-- once: as above.
ALTER TABLE learnings_proposals ADD COLUMN expires_at TEXT;
-- once: as above.
ALTER TABLE learnings_proposals ADD COLUMN status_reason TEXT;
CREATE INDEX IF NOT EXISTS learnings_proposals_kind ON learnings_proposals (kind, status, created_at);
CREATE INDEX IF NOT EXISTS learnings_proposals_source ON learnings_proposals (proposed_by, created_at);

-- A draft the operator changed before it went out: what the system wrote and what was sent, with
-- quoted history and the signature stripped. Edit mining reads it weekly. It is the operator's
-- correspondence with a contact, so it goes with the contact on erasure.
CREATE TABLE IF NOT EXISTS draft_edits (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE,
  contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  action_class TEXT,
  generated_body TEXT NOT NULL,
  sent_body TEXT NOT NULL,
  mined_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS draft_edits_created ON draft_edits (created_at);
CREATE INDEX IF NOT EXISTS draft_edits_contact ON draft_edits (contact_id);

-- One row per weekday the agent review graded: the overall grade and what it graded.
CREATE TABLE IF NOT EXISTS agent_reviews (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  grade TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  drafts_graded INTEGER NOT NULL DEFAULT 0,
  actions_graded INTEGER NOT NULL DEFAULT 0,
  grades TEXT CHECK (grades IS NULL OR json_valid(grades)),
  model TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Long-term memory text: corrective guidance from the agent review, and the retrospective's notes.
-- Text is sanitized before it is stored and names no contact. memory_fts (0012) indexes it and can
-- be rebuilt from this table.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  source TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS memories_kind ON memories (kind, created_at);
