// GTM-agents: follow-up drafts: one per step and contact, keyed by the step's idempotency key.
//
// Every step has one idempotency key, `seq:<campaign id>:<contact id>:<step>`. It is the key the send
// function claims in the effects ledger, so a step is never sent twice whoever retries, and the
// drafts table's unique idempotency_key, so a step never has two drafts. A draft is stored as:
//   - pending_approval, when a person releases follow-ups (the cold batch's default level), until
//     the release command approves it bound to its digest;
//   - approved, with approved_digest and approved_by auto:<reason>, when the cold batch class may
//     approve its own passing drafts.
// An approved draft whose step could not go yet (a send window, a cap) is sent as approved by a
// later sweep; editing it returns it to review (the drafts table's trigger), and the send function
// re-checks the digest.
import { inChunks, placeholders } from "../data/d1.ts";
import type { DraftStatus } from "../security/approval-digest.ts";
import { SEQUENCE_RELEASE_PREFIX } from "../outreach/manifest.ts";

export const STEP_KEY_PREFIX = "seq";

/** The idempotency key of one step for one contact. */
export function stepKey(campaignId: string, contactId: string, step: number): string {
  return `${STEP_KEY_PREFIX}:${campaignId}:${contactId}:${step}`;
}

/** The parts of a step key, or null when the text is not one. */
export function parseStepKey(key: string | null | undefined): { campaignId: string; contactId: string; step: number } | null {
  if (typeof key !== "string") return null;
  const match = /^seq:([^:]+):([^:]+):(\d{1,2})$/.exec(key);
  if (!match) return null;
  const step = Number(match[3]);
  return Number.isInteger(step) && step >= 2 ? { campaignId: match[1] ?? "", contactId: match[2] ?? "", step } : null;
}

export interface StepDraft {
  id: string;
  contact_id: string | null;
  campaign_id: string | null;
  template_id: string | null;
  kind: string;
  recipient_email: string | null;
  recipient_name: string | null;
  subject: string | null;
  body: string | null;
  status: DraftStatus;
  approved_digest: string | null;
  /** operator:<id> for a release, auto:<reason> for an automatic approval. */
  approved_by: string | null;
  idempotency_key: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  /** Measurement bookkeeping set at composition: the template file's SHA-256 and the send's cohort. */
  template_sha256?: string | null;
  cohort?: string | null;
}

const DRAFT_COLUMNS = "id, contact_id, campaign_id, template_id, kind, recipient_email, recipient_name, subject, body, status, approved_digest, approved_by, idempotency_key, sent_at, created_at, updated_at, template_sha256, cohort";

/** Drafts by step key. Throws on a database error. */
export async function loadStepDrafts(db: D1Database, keys: readonly string[]): Promise<Map<string, StepDraft>> {
  const out = new Map<string, StepDraft>();
  for (const chunk of inChunks([...new Set(keys)])) {
    const { results } = await db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE idempotency_key IN (${placeholders(chunk.length)})`).bind(...chunk).all<StepDraft>();
    for (const r of results) out.set(r.idempotency_key, r);
  }
  return out;
}

/** Drafts by id. Throws on a database error. */
export async function loadDraftsById(db: D1Database, ids: readonly string[]): Promise<Map<string, StepDraft>> {
  const out = new Map<string, StepDraft>();
  for (const chunk of inChunks([...new Set(ids)])) {
    const { results } = await db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk).all<StepDraft>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

/** Measurement bookkeeping must never fail a draft write: a value the column's CHECK would refuse is left out. */
const validSha = (value: string | null | undefined): string | null => (value && /^[0-9a-f]{64}$/.test(value) ? value : null);

export const newDraftId = (): string => `dr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export interface NewStepDraft {
  id: string;
  key: string;
  contactId: string;
  campaignId: string;
  templateId: string;
  kind: string;
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  notes: string;
  /** Set when the draft is approved as it is stored. */
  approval: { digest: string; by: string } | null;
  /** Measurement bookkeeping: the template file's SHA-256 and the send's cohort (metrics/cohort.ts). */
  templateSha256?: string | null;
  cohort?: string | null;
}

/** Insert a draft, unless the step already has one. */
export function insertDraftStatement(db: D1Database, d: NewStepDraft, now: Date): D1PreparedStatement {
  const at = now.toISOString();
  return db
    .prepare(
      `INSERT OR IGNORE INTO drafts (id, contact_id, campaign_id, template_id, kind, recipient_email, recipient_name, subject, body, status,
         approved_digest, approved_at, approved_by, idempotency_key, notes, created_at, updated_at, template_sha256, cohort)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18)`,
    )
    .bind(
      d.id,
      d.contactId,
      d.campaignId,
      d.templateId,
      d.kind,
      d.to,
      d.toName,
      d.subject,
      d.body,
      d.approval ? "approved" : "pending_approval",
      d.approval?.digest ?? null,
      d.approval ? at : null,
      d.approval?.by ?? null,
      d.key,
      d.notes.slice(0, 500),
      at,
      validSha(d.templateSha256),
      d.cohort ?? null,
    );
}

/**
 * Replace a waiting draft's content with a fresh composition, and approve it in the same write when
 * `approval` is set. Only a draft still pending approval changes: an approved or sent one is left alone.
 */
export function refreshDraftStatement(db: D1Database, draftId: string, d: Omit<NewStepDraft, "id" | "key" | "contactId" | "campaignId">, now: Date): D1PreparedStatement {
  const at = now.toISOString();
  return db
    .prepare(
      `UPDATE drafts SET template_id = ?2, kind = ?3, recipient_email = ?4, recipient_name = ?5, subject = ?6, body = ?7, notes = ?8,
              status = ?9, approved_digest = ?10, approved_at = ?11, approved_by = ?12, updated_at = ?13, template_sha256 = ?14, cohort = ?15
        WHERE id = ?1 AND status = 'pending_approval'`,
    )
    .bind(
      draftId,
      d.templateId,
      d.kind,
      d.to,
      d.toName,
      d.subject,
      d.body,
      d.notes.slice(0, 500),
      d.approval ? "approved" : "pending_approval",
      d.approval?.digest ?? null,
      d.approval ? at : null,
      d.approval?.by ?? null,
      at,
      validSha(d.templateSha256),
      d.cohort ?? null,
    );
}

/**
 * Return a draft that was approved automatically to review, when automatic approval no longer
 * applies (the level was lowered, auto-approve or the reviewer switched off): a person releases it.
 * A draft an operator released keeps its approval. Throws on a database error.
 */
export async function returnAutoApprovalToReview(db: D1Database, draftId: string, now: Date): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?2
        WHERE id = ?1 AND status = 'approved' AND approved_by LIKE 'auto:%'`,
    )
    .bind(draftId, now.toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Retire a step's open draft when its sequence ended or stopped, so it is not counted as waiting. */
export function retireDraftsStatement(db: D1Database, campaignId: string, contactId: string, reason: string, now: Date): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE drafts SET status = 'rejected', notes = ?3, updated_at = ?4
        WHERE campaign_id = ?1 AND contact_id = ?2 AND idempotency_key LIKE 'seq:%' AND status IN ('draft', 'pending_approval', 'approved')`,
    )
    .bind(campaignId, contactId, `the sequence ended: ${reason}`.slice(0, 500), now.toISOString());
}

/**
 * The draft ids (with their digests) in follow-up manifests written since `since`: steps already
 * waiting for a release, which a sweep does not put up again. Throws on a database error.
 */
export async function draftsInLiveManifests(db: D1Database, since: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { results } = await db
    .prepare("SELECT entries FROM approval_manifests WHERE kind = 'sequence' AND created_at >= ?1 ORDER BY created_at DESC LIMIT 200")
    .bind(since.toISOString())
    .all<{ entries: string }>();
  for (const row of results) {
    try {
      const entries = JSON.parse(row.entries) as unknown;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [id, digest] of Object.entries(entries)) if (typeof digest === "string" && !out.has(id)) out.set(id, digest);
    } catch {
      // A malformed manifest holds nothing; its drafts are put up again.
    }
  }
  return out;
}

/** A follow-up manifest id: sq, the UTC minute, and four random hex characters. */
export function sequenceManifestId(now: Date): string {
  const minute = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `sq${minute}${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`;
}

/** The release command's prefix, re-exported for the operator help text. */
export const SEQUENCE_RELEASE = SEQUENCE_RELEASE_PREFIX;
