// GTM-agents: approval manifests for cold batches, and the message the operator releases them from.
//
// When a batch waits for a person, writeManifest records each passing draft's content digest in
// approval_manifests (migration 0016) and derives a six-character code from the sorted
// (draft id, digest) pairs with manifestCode. The operator is sent a summary with the first, middle
// and last drafts in full and the command `batch-release-<id>-<code>`. The code confirms intent; it
// is not a secret, and the release path (release.ts) verifies every draft's digest against the
// manifest, so a draft edited after the manifest was written is refused.
import { draftDigest, manifestCode } from "../security/approval-digest.ts";

export const RELEASE_PREFIX = "batch-release";
export const SAMPLE_BODY_MAX = 900;

export interface Manifest {
  id: string;
  campaignId: string;
  code: string;
  /** Draft id to content digest. */
  entries: Record<string, string>;
  createdAt: string;
  releasedAt: string | null;
}

export interface ManifestDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
}

/** The command that releases a manifest. */
export function releaseCommand(manifest: Pick<Manifest, "id" | "code">): string {
  return `${RELEASE_PREFIX}-${manifest.id}-${manifest.code}`;
}

interface ManifestRow {
  id: string;
  campaign_id: string;
  code: string;
  entries: string;
  created_at: string;
  released_at: string | null;
}

function fromRow(row: ManifestRow): Manifest | null {
  try {
    const entries: unknown = JSON.parse(row.entries);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
    const clean: Record<string, string> = {};
    for (const [id, digest] of Object.entries(entries)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return null;
      clean[id] = digest;
    }
    if (Object.keys(clean).length === 0) return null;
    return { id: row.id, campaignId: row.campaign_id, code: row.code, entries: clean, createdAt: row.created_at, releasedAt: row.released_at };
  } catch {
    return null;
  }
}

/** The stored manifest, or null when there is none or it is malformed. Throws on a database error. */
export async function readManifest(db: D1Database, id: string): Promise<Manifest | null> {
  const row = await db.prepare("SELECT id, campaign_id, code, entries, created_at, released_at FROM approval_manifests WHERE id = ?1").bind(id).first<ManifestRow>();
  return row ? fromRow(row) : null;
}

/**
 * Record the drafts the operator is about to see. One manifest per campaign: when one already
 * exists, it is returned unchanged, so a code the operator holds keeps meaning the same set.
 */
export async function writeManifest(db: D1Database, campaignId: string, drafts: readonly ManifestDraft[], now: Date): Promise<Manifest> {
  const entries: Record<string, string> = {};
  for (const d of drafts) entries[d.id] = await draftDigest({ to: d.to, subject: d.subject, body: d.body });
  const code = await manifestCode(entries);
  await db
    .prepare("INSERT OR IGNORE INTO approval_manifests (id, campaign_id, code, entries, draft_count, created_at) VALUES (?1, ?1, ?2, ?3, ?4, ?5)")
    .bind(campaignId, code, JSON.stringify(entries), drafts.length, now.toISOString())
    .run();
  const stored = await readManifest(db, campaignId);
  if (!stored) throw new Error(`the manifest for ${campaignId} could not be read back`);
  return stored;
}

/** The first, middle and last drafts in full (bodies cut at SAMPLE_BODY_MAX), for the summary. */
export function renderSamples(drafts: readonly ManifestDraft[]): string {
  if (drafts.length === 0) return "";
  const picks = [...new Set([0, Math.floor(drafts.length / 2), drafts.length - 1])].map((i) => drafts[i]).filter((d): d is ManifestDraft => d !== undefined);
  return picks
    .map((d, i) => {
      const body = d.body.length > SAMPLE_BODY_MAX ? `${d.body.slice(0, SAMPLE_BODY_MAX)}\n[...]` : d.body;
      return `Sample ${i + 1} of ${picks.length} (of ${drafts.length} drafts), to ${d.to}\nSubject: ${d.subject}\n\n${body}`;
    })
    .join("\n\n-----\n\n");
}
