// GTM-agents: the payload an approval button carries back: the approval id and the digest of the
// content the operator was shown.
//
// Format: "<approvalId>.<digest>", where the digest is the first APPROVAL_DIGEST_CHARS hex
// characters (128 bits) of the SHA-256 content digest. The prefix keeps the payload inside small
// channel limits (a chat button's callback data can be as short as 64 bytes) while still binding
// the tap to one exact content: finding a different draft with the same 128-bit prefix is not
// feasible. Core compares the prefix with the current digest in constant time and then confirms
// the full digest with the shown record before approving.
import { constantTimeEqual } from "../http/auth.ts";

export const APPROVAL_DIGEST_CHARS = 32;
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,40}$/;
const DIGEST = /^[0-9a-f]{32,64}$/;

export function approvalPayload(approvalId: string, digest: string): string {
  if (!APPROVAL_ID.test(approvalId)) throw new Error("an approval id is 1 to 40 letters, digits, underscores or hyphens");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("an approval digest is a lowercase SHA-256 hex string");
  return `${approvalId}.${digest.slice(0, APPROVAL_DIGEST_CHARS)}`;
}

/** The approval id and digest prefix in a payload, or null when it is not exactly that. */
export function parseApprovalPayload(payload: unknown): { approvalId: string; digest: string } | null {
  if (typeof payload !== "string" || payload.length > 120) return null;
  const dot = payload.lastIndexOf(".");
  if (dot <= 0) return null;
  const approvalId = payload.slice(0, dot);
  const digest = payload.slice(dot + 1);
  if (!APPROVAL_ID.test(approvalId) || !DIGEST.test(digest)) return null;
  return { approvalId, digest };
}

/** True when a payload's digest is the prefix of `currentDigest`, compared in constant time. */
export async function payloadMatchesDigest(payloadDigest: string, currentDigest: string): Promise<boolean> {
  if (!DIGEST.test(payloadDigest) || !/^[0-9a-f]{64}$/.test(currentDigest)) return false;
  return constantTimeEqual(payloadDigest, currentDigest.slice(0, payloadDigest.length));
}
