-- GTM-agents: the CRM mirror (docs/CRM.md).
--
-- The crm_mirror job copies contacts, their accounts and fixed summaries of our own activity into an
-- external CRM through a CrmSink adapter. The mirror is one way: this database stays the truth.
--
-- crm_sync_state holds one cursor per sink and stream: the last row the mirror finished, as its
-- change time and id. A stream reads only rows after it, so a run that stops leaves the rest for the
-- next run.
--
-- crm_links maps a local contact or account to its record in the CRM, with a digest of the fields
-- last written, so an unchanged contact is not written again. The links hold ids and a digest, never
-- an address or a name.
--
-- crm_erasures keeps, for each erased person who was mirrored, the CRM record the operator has to
-- delete there: erasing a person deletes their contact link, records the record id here and leaves a
-- notice for the operator. It holds the CRM's record id and no address.
CREATE TABLE IF NOT EXISTS crm_sync_state (
  sink TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('contacts', 'sends', 'replies', 'meetings', 'deal_stages')),
  cursor_at TEXT NOT NULL,
  cursor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (sink, stream)
);

CREATE TABLE IF NOT EXISTS crm_links (
  sink TEXT NOT NULL,
  local_kind TEXT NOT NULL CHECK (local_kind IN ('account', 'contact')),
  local_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (sink, local_kind, local_id)
);
CREATE INDEX IF NOT EXISTS crm_links_local ON crm_links (local_kind, local_id);

CREATE TABLE IF NOT EXISTS crm_erasures (
  sink TEXT NOT NULL,
  external_id TEXT NOT NULL,
  erased_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (sink, external_id)
);
