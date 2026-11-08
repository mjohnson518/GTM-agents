// GTM-agents: approval manifests: what the operator was shown when drafts wait for a release, and
// the message they release them from.
//
// When drafts wait for a person, writeManifest records each draft's content digest in
// approval_manifests (migration 0016) and derives a six-character code from the sorted
// (draft id, digest) pairs with manifestCode. The operator is sent a summary with the first, middle
// and last drafts in full and the release command. The code confirms intent; it is not a secret,
// and every release path verifies each draft's digest against the manifest, so a draft edited
// after the manifest was written is refused.
//
// Two kinds of manifest exist, each with its own command, so neither command can release the
// other's drafts:
//   - cold_batch: one per daily cold batch, id = the campaign id, released with
//     `batch-release-<id>-<code>` (release.ts);
//   - sequence: one per follow-up sweep that put steps up for approval, released with
//     `sequence-release-<id>-<code>` (sequences/release.ts). It may cover steps from several
//     campaigns; its campaign_id names the first of them.
import { draftDigest, manifestCode } from "../security/approval-digest.ts";

export const RELEASE_PREFIX = "batch-release";
export const SEQUENCE_RELEASE_PREFIX = "sequence-release";
export const SAMPLE_BODY_MAX = 900;

export const MANIFEST_KINDS = ["cold_batch", "sequence"] as const;
export type ManifestKind = (typeof MANIFEST_KINDS)[number];

/** The command prefix that releases each kind of manifest. */
export const RELEASE_PREFIXES: Readonly<Record<ManifestKind, string>> = Object.freeze({ cold_batch: RELEASE_PREFIX, sequence: SEQUENCE_RELEASE_PREFIX });

export interface Manifest {
  id: string;
  campaignId: string;
  kind: ManifestKind;
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

/** The command that releases a manifest. A manifest without a kind is a cold batch's. */
export function releaseCommand(manifest: Pick<Manifest, "id" | "code"> & { kind?: ManifestKind }): string {
  return `${RELEASE_PREFIXES[manifest.kind ?? "cold_batch"]}-${manifest.id}-${manifest.code}`;
}

interface ManifestRow {
  id: string;
  campaign_id: string;
  kind: string | null;
  code: string;
  entries: string;
  created_at: string;
  released_at: string | null;
}

function fromRow(row: ManifestRow): Manifest | null {
  try {
    const kind = (row.kind ?? "cold_batch") as ManifestKind;
    if (!MANIFEST_KINDS.includes(kind)) return null;
    const entries: unknown = JSON.parse(row.entries);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
    const clean: Record<string, string> = {};
    for (const [id, digest] of Object.entries(entries)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return null;
      clean[id] = digest;
    }
    if (Object.keys(clean).length === 0) return null;
    return { id: row.id, campaignId: row.campaign_id, kind, code: row.code, entries: clean, createdAt: row.created_at, releasedAt: row.released_at };
  } catch {
    return null;
  }
}

/** The stored manifest, or null when there is none or it is malformed. Throws on a database error. */
export async function readManifest(db: D1Database, id: string): Promise<Manifest | null> {
  const row = await db.prepare("SELECT id, campaign_id, kind, code, entries, created_at, released_at FROM approval_manifests WHERE id = ?1").bind(id).first<ManifestRow>();
  return row ? fromRow(row) : null;
}

export interface ManifestOptions {
  /** The manifest id. Defaults to the campaign id: one cold batch manifest per campaign. */
  id?: string;
  /** Defaults to cold_batch. */
  kind?: ManifestKind;
}

/**
 * Record the drafts the operator is about to see. One manifest per id: when one already exists, it
 * is returned unchanged, so a code the operator holds keeps meaning the same set. Throws on a
 * database error, or when the drafts are empty.
 */
export async function writeManifest(db: D1Database, campaignId: string, drafts: readonly ManifestDraft[], now: Date, options: ManifestOptions = {}): Promise<Manifest> {
  const id = options.id ?? campaignId;
  const kind = options.kind ?? "cold_batch";
  const entries: Record<string, string> = {};
  for (const d of drafts) entries[d.id] = await draftDigest({ to: d.to, subject: d.subject, body: d.body });
  const code = await manifestCode(entries);
  await db
    .prepare("INSERT OR IGNORE INTO approval_manifests (id, campaign_id, kind, code, entries, draft_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, campaignId, kind, code, JSON.stringify(entries), drafts.length, now.toISOString())
    .run();
  const stored = await readManifest(db, id);
  if (!stored) throw new Error(`the manifest ${id} could not be read back`);
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
