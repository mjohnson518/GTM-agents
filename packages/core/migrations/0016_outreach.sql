-- GTM-agents: approval manifests: what the operator was shown when a cold batch waits for release.
--
-- A manifest maps each draft id in a batch to the digest of its content (security/approval-digest.ts
-- draftDigest) at the moment the batch was put up for approval. Its code is the first six hex
-- characters of a hash over the sorted (draft id, digest) pairs (manifestCode). The operator types
-- `batch-release-<id>-<code>` back to release exactly that set. The code confirms intent; it is not a
-- secret, so the release path still verifies every draft's digest against the entries, and a draft
-- edited after the manifest was written is refused. id is the campaign id, one manifest per batch.

CREATE TABLE IF NOT EXISTS approval_manifests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(code) = 6 AND code NOT GLOB '*[^0-9a-f]*'),
  entries TEXT NOT NULL CHECK (json_valid(entries)),
  draft_count INTEGER NOT NULL CHECK (draft_count > 0),
  released_at TEXT,
  released_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS approval_manifests_campaign ON approval_manifests (campaign_id);
