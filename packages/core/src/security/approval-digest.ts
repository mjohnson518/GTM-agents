// GTM-agents: approvals bound to content.
//
// An approval covers exactly the content that was approved. The digest is a SHA-256 over a
// versioned JSON form of the recipient, subject and body, so no two different drafts share a
// canonical form (fields cannot bleed into each other the way joined strings can). Every path that
// honours an approval recomputes the digest and refuses a mismatch:
//   - approveDraft refuses when the draft changed since it was shown;
//   - applyEdit returns an approved draft to review when the edit changes its digest;
//   - verifyApproval is what a send path checks before relying on an approval.
//
// markShown and wasShown bind one-tap approvals to what the operator saw: the notification
// records the digest of the text it showed, and the approval proceeds only while the draft still
// matches. Recording is bookkeeping and fails open; checking is a gate and fails closed.
//
// Batch releases use manifestCode: six hex characters over the sorted (draft id, digest) pairs,
// which the operator types back to release exactly that set. Six characters is a confirmation, not
// a secret, so the release path still verifies every draft's digest. Human-only tools use toolInputDigest:
// an approval for one exact input does not cover any other.
import { sha256Hex } from "../shared/hash.ts";

export const DIGEST_VERSION = 1;
export const SHOWN_TTL_SECONDS = 14 * 24 * 60 * 60;

export const DRAFT_STATUSES = ["draft", "pending_approval", "approved", "sent", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface DraftContent {
  to: string | null | undefined;
  subject: string | null | undefined;
  body: string | null | undefined;
}

/** A draft as the approval rules see it. Database rows with these columns fit. */
export interface ReviewableDraft extends DraftContent {
  status: DraftStatus;
  approved_digest: string | null;
}

/** The slice of a KV namespace that shown-records use. Cloudflare's KVNamespace satisfies it. */
export interface ShownStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * JSON with object keys sorted at every level, so equal values always serialize the same way.
 * Throws on values JSON cannot represent faithfully: non-finite numbers, bigints, functions,
 * symbols, cycles, and objects that are not plain (Map, Set, Date, class instances).
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
      case "boolean":
        return JSON.stringify(v);
      case "number":
        if (!Number.isFinite(v)) throw new TypeError("canonicalJson: non-finite number");
        return JSON.stringify(v);
      case "object": {
        if (seen.has(v)) throw new TypeError("canonicalJson: cycle");
        const proto = Object.getPrototypeOf(v) as unknown;
        if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
          throw new TypeError("canonicalJson: only plain objects and arrays can be encoded");
        }
        seen.add(v);
        const out = Array.isArray(v)
          ? `[${v.map((item: unknown) => (item === undefined ? "null" : encode(item))).join(",")}]`
          : `{${Object.keys(v)
              .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`)
              .join(",")}}`;
        seen.delete(v);
        return out;
      }
      default:
        throw new TypeError(`canonicalJson: cannot encode a ${typeof v}`);
    }
  };
  return encode(value);
}

// Only ASCII letters are case-folded and only spaces are trimmed. Unicode case mapping would let
// distinct addresses share an approval (U+212A, the Kelvin sign, lowercases to "k"), and trimming
// line breaks would let a header-injecting recipient match a clean one.
function normalizeRecipient(to: string | null | undefined): string {
  return (to ?? "").replace(/^ +| +$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The digest of a draft's outward content. The recipient's ASCII letters are case-folded and spaces trimmed. */
export async function draftDigest(content: DraftContent): Promise<string> {
  return sha256Hex(
    canonicalJson({
      kind: "draft",
      v: DIGEST_VERSION,
      to: normalizeRecipient(content.to),
      subject: content.subject ?? "",
      body: content.body ?? "",
    }),
  );
}

/** The digest of one exact tool call, for human-only tools. */
export async function toolInputDigest(tool: string, input: unknown): Promise<string> {
  return sha256Hex(canonicalJson({ kind: "tool_call", v: DIGEST_VERSION, tool, input: input ?? null }));
}

/** Six hex characters identifying a set of (draft id, digest) pairs, independent of order. */
export async function manifestCode(entries: Readonly<Record<string, string>>): Promise<string> {
  const pairs = Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (pairs.length === 0) throw new RangeError("manifestCode: a manifest needs at least one draft");
  return (await sha256Hex(canonicalJson({ kind: "manifest", v: DIGEST_VERSION, pairs }))).slice(0, 6);
}

const shownKey = (draftId: string) => `approval:shown:${draftId}`;

/** Record that this exact content was shown to the operator. Returns false if recording failed. */
export async function markShown(store: ShownStore, draftId: string, content: DraftContent): Promise<boolean> {
  try {
    await store.put(shownKey(draftId), await draftDigest(content), { expirationTtl: SHOWN_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}

/** True only when the draft's current content is exactly what was last shown. False on any error. */
export async function wasShown(store: ShownStore, draftId: string, content: DraftContent): Promise<boolean> {
  try {
    const stored = await store.get(shownKey(draftId));
    return stored !== null && stored === (await draftDigest(content));
  } catch {
    return false;
  }
}

export type ApprovalResult<T> = { ok: true; draft: T } | { ok: false; reason: string };

/** Approve a draft, provided its content still has the digest the operator was shown. */
export async function approveDraft<T extends ReviewableDraft>(draft: T, shownDigest: string): Promise<ApprovalResult<T>> {
  if (draft.status === "sent" || draft.status === "rejected") {
    return { ok: false, reason: `a ${draft.status} draft cannot be approved` };
  }
  const current = await draftDigest(draft);
  if (current !== shownDigest) return { ok: false, reason: "the draft changed after it was shown" };
  return { ok: true, draft: { ...draft, status: "approved", approved_digest: current } };
}

export interface EditResult<T> {
  draft: T;
  /** True when the edit moved an approved draft back to pending_approval. */
  returnedToReview: boolean;
}

/**
 * Apply an edit to a draft's content. An approved draft whose digest changes goes back to
 * pending_approval and loses its approval. A sent draft cannot be edited.
 */
export async function applyEdit<T extends ReviewableDraft>(draft: T, edit: Partial<DraftContent>): Promise<EditResult<T>> {
  if (draft.status === "sent") throw new Error("a sent draft cannot be edited");
  // Only content fields are taken from the edit, so an edit can never carry a status or digest.
  const next: T = { ...draft };
  if (edit.to !== undefined) next.to = edit.to;
  if (edit.subject !== undefined) next.subject = edit.subject;
  if (edit.body !== undefined) next.body = edit.body;
  if (draft.status !== "approved") return { draft: next, returnedToReview: false };
  const digest = await draftDigest(next);
  if (digest === draft.approved_digest) return { draft: next, returnedToReview: false };
  return { draft: { ...next, status: "pending_approval", approved_digest: null }, returnedToReview: true };
}

/** True only for an approved draft whose current content matches the approved digest. */
export async function verifyApproval(draft: ReviewableDraft): Promise<boolean> {
  if (draft.status !== "approved" || !draft.approved_digest) return false;
  try {
    return (await draftDigest(draft)) === draft.approved_digest;
  } catch {
    return false;
  }
}
