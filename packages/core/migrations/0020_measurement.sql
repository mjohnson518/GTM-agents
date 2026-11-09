-- GTM-agents: measurement: the template version and cohort a draft was composed with, and the
-- indexes the metric functions read by.
--
--   - drafts.template_sha256: the SHA-256 of the template file the draft was built from (the same
--     hash templates.body_sha256 holds for the template's current copy);
--   - drafts.cohort: signalled, segment_routed or generic (packages/core/src/metrics/cohort.ts).
-- The composer (the cold batch, the follow-up sweep) sets both when it writes a draft. A draft can
-- wait days for its release while its template is edited, so the version travels with the draft:
-- the send function copies both onto the send ledger (outreach_sends.template_sha256 and cohort),
-- and matured samples count only sends whose template_sha256 matches the template's current copy.
-- Drafts written before this migration carry neither, and their sends record neither.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file exactly once.
ALTER TABLE drafts ADD COLUMN template_sha256 TEXT CHECK (template_sha256 IS NULL OR (length(template_sha256) = 64 AND template_sha256 NOT GLOB '*[^0-9a-f]*'));
-- once: as above.
ALTER TABLE drafts ADD COLUMN cohort TEXT CHECK (cohort IS NULL OR cohort IN ('signalled', 'segment_routed', 'generic'));

-- Replies and positive replies are counted by when they arrived.
CREATE INDEX IF NOT EXISTS outreach_sends_replied ON outreach_sends (replied_at) WHERE replied_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS outreach_sends_positive ON outreach_sends (positive_reply_at) WHERE positive_reply_at IS NOT NULL;
-- Failed jobs are counted by when they started.
CREATE INDEX IF NOT EXISTS execution_runs_started ON execution_runs (started_at);
-- Ledger coverage reads the delivered events the provider webhook claimed, by time.
CREATE INDEX IF NOT EXISTS event_effects_effect_created ON event_effects (effect, created_at);
