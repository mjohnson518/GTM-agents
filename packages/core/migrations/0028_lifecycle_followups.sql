-- GTM-agents: lifecycle follow-ups to product users (packages/core/src/lifecycle/followups.ts,
-- docs/LIFECYCLE.md).
--
--   - lifecycle_followups: one row per follow-up decided for a contact's stay in a lifecycle state.
--     A stay is the contact's state and the time they entered it (contact_lifecycle.state_changed_at
--     as entered_at), so a new transition starts every timer afresh, and the unique key (contact,
--     kind, entered_at) is the claim: two sweeps, a rerun or a redelivered command can never decide
--     or send the same follow-up twice. A row records what happened: claimed (being decided now),
--     drafted (waiting for the operator's fu-approve), sending, sent, queued (handed to the send
--     function, which holds it for the send window), or skipped, rejected, expired, withdrawn or
--     failed, with the reason. The frequency caps count the rows that went out or wait to.
--   - An offer (the upgrade offer and the win-back) is permanently human: the CHECK below refuses
--     to record one as sending, sent or queued unless a person decided it (decided_by operator:...),
--     whatever the code above it does.
-- Erasing a contact deletes their rows (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS lifecycle_followups (
  id TEXT PRIMARY KEY CHECK (length(id) = 10 AND id NOT GLOB '*[^0-9a-f]*'),
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('first_use', 'last_first_use', 'usefulness', 'upgrade_offer', 'reengage', 'at_risk', 'win_back')),
  state TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  action_class TEXT NOT NULL,
  level INTEGER CHECK (level IS NULL OR level BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'drafted', 'sending', 'sent', 'queued', 'skipped', 'rejected', 'expired', 'withdrawn', 'failed')),
  reason TEXT,
  draft_id TEXT REFERENCES drafts (id) ON DELETE SET NULL,
  template_id TEXT,
  shown_digest TEXT CHECK (shown_digest IS NULL OR length(shown_digest) = 64),
  override_at TEXT,
  decided_by TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (contact_id, kind, entered_at),
  CHECK (kind NOT IN ('upgrade_offer', 'win_back') OR status NOT IN ('sending', 'sent', 'queued') OR decided_by LIKE 'operator:%')
);
CREATE INDEX IF NOT EXISTS lifecycle_followups_contact ON lifecycle_followups (contact_id, created_at);
CREATE INDEX IF NOT EXISTS lifecycle_followups_status ON lifecycle_followups (status, created_at);
