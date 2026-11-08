// GTM-agents: email verification semantics: the cache, confidence grades and the promotion policy.
//
// The verifier adapter maps its vendor's vocabulary onto four statuses (deliverable, risky,
// undeliverable, unknown). Everything else is decided here:
//   - results are cached in email_verifications, keyed by the address hash (the address itself is
//     not stored there). A result is reused while fresh: 90 days, or 7 days for `unknown`, which is
//     usually transient (a slow or greylisting server);
//   - confidence: deliverable with a score of 90 or more is high, other deliverable results are
//     medium (low when the vendor's score is under 70), risky (accept-all) is low, and anything
//     else has none;
//   - promotion: under the default `strict` policy only a fresh deliverable result promotes. The
//     `allow_risky` policy (verification:promotion_policy) also promotes risky results. Unknown and
//     undeliverable never promote. An unknown result is retried on later runs, then rejected after
//     MAX_UNKNOWN_ATTEMPTS.
// A verification is a paid call, so verifyAddress asks the spend gate first.
import { addressHash } from "../sending/suppression.ts";
import { AdapterError } from "../ports/types.ts";
import { VERIFICATION_STATUSES, type EmailVerifier, type VerificationStatus } from "../ports/contact.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { PromotionPolicy } from "../sourcing/flags.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { cleanProviderText } from "../sourcing/text.ts";

export const VERIFICATION_TTL_DAYS = 90;
export const UNKNOWN_TTL_DAYS = 7;
/** Unknown results tolerated at promotion before the candidate is rejected. */
export const MAX_UNKNOWN_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

export interface VerificationRecord {
  status: VerificationStatus;
  provider: string;
  score: number | null;
  acceptAll: boolean | null;
  disposable: boolean | null;
  reason: string | null;
  verifiedAt: string;
  /** True when this came from the cache rather than a call made now. */
  cached: boolean;
}

export type EmailConfidence = "high" | "medium" | "low";

/** How long a result stays fresh, in days. */
export function verificationTtlDays(status: VerificationStatus): number {
  return status === "unknown" ? UNKNOWN_TTL_DAYS : VERIFICATION_TTL_DAYS;
}

export function isFresh(record: Pick<VerificationRecord, "status" | "verifiedAt">, now: Date): boolean {
  const at = Date.parse(record.verifiedAt);
  return Number.isFinite(at) && now.getTime() - at < verificationTtlDays(record.status) * DAY_MS && at <= now.getTime() + 60_000;
}

/** The confidence grade stored on a contact, or null when the address should not be used. */
export function emailConfidence(record: Pick<VerificationRecord, "status" | "score" | "disposable">): EmailConfidence | null {
  if (record.disposable) return null;
  if (record.status === "deliverable") {
    if (record.score === null) return "medium";
    if (record.score >= 90) return "high";
    return record.score >= 70 ? "medium" : "low";
  }
  if (record.status === "risky") return "low";
  return null;
}

/** Whether a verification result allows promotion under the policy. Disposable addresses never pass. */
export function passesPromotionPolicy(record: Pick<VerificationRecord, "status" | "disposable">, policy: PromotionPolicy): boolean {
  if (record.disposable) return false;
  if (record.status === "deliverable") return true;
  return record.status === "risky" && policy === "allow_risky";
}

interface CacheRow {
  status: string;
  provider: string;
  score: number | null;
  disposable: number | null;
  accept_all: number | null;
  result: string | null;
  verified_at: string;
}

function readReason(json: string | null): string | null {
  try {
    const parsed = json ? (JSON.parse(json) as { reason?: unknown }) : null;
    return typeof parsed?.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

const isStatus = (s: unknown): s is VerificationStatus => typeof s === "string" && (VERIFICATION_STATUSES as readonly string[]).includes(s);
const flag = (n: number | null): boolean | null => (n === null ? null : n === 1);

/** The cached result for an address, fresh or not, or null when there is none. Throws on a database error. */
export async function readCachedVerification(db: D1Database, email: string): Promise<VerificationRecord | null> {
  const row = await db
    .prepare("SELECT status, provider, score, disposable, accept_all, result, verified_at FROM email_verifications WHERE email_sha256 = ?1")
    .bind(await addressHash(email))
    .first<CacheRow>();
  if (!row || !isStatus(row.status)) return null;
  const reason = readReason(row.result);
  return { status: row.status, provider: row.provider, score: row.score, acceptAll: flag(row.accept_all), disposable: flag(row.disposable), reason, verifiedAt: row.verified_at, cached: true };
}

/** A fresh cached result, or null. Throws on a database error. */
export async function freshVerification(db: D1Database, email: string, now: Date): Promise<VerificationRecord | null> {
  const cached = await readCachedVerification(db, email);
  return cached && isFresh(cached, now) ? cached : null;
}

/** Write a result to the cache. Throws on a database error. */
export async function cacheVerification(db: D1Database, email: string, record: Omit<VerificationRecord, "cached">): Promise<void> {
  const bit = (b: boolean | null) => (b === null ? null : b ? 1 : 0);
  await db
    .prepare(
      `INSERT INTO email_verifications (email_sha256, status, provider, score, disposable, accept_all, result, verified_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(email_sha256) DO UPDATE SET status = excluded.status, provider = excluded.provider, score = excluded.score,
         disposable = excluded.disposable, accept_all = excluded.accept_all, result = excluded.result, verified_at = excluded.verified_at`,
    )
    .bind(await addressHash(email), record.status, record.provider, record.score, bit(record.disposable), bit(record.acceptAll), JSON.stringify({ reason: record.reason }), record.verifiedAt)
    .run();
}

export type VerifyOutcome =
  | { ok: true; record: VerificationRecord }
  | { ok: false; reason: "no_verifier" | "budget" | "error"; detail?: string; retryable?: boolean };

export interface VerifyOptions {
  db: D1Database;
  verifier: EmailVerifier | undefined;
  gate: SpendGate;
  now: Date;
  log?: JobLogger;
}

const clampScore = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null);

/**
 * A verification for `email` (already normalized and screened): the fresh cached result, or a new
 * call when the budget allows. The new result is cached and its cost recorded.
 */
export async function verifyAddress(email: string, options: VerifyOptions): Promise<VerifyOutcome> {
  const cached = await freshVerification(options.db, email, options.now);
  if (cached) return { ok: true, record: cached };
  if (!options.verifier) return { ok: false, reason: "no_verifier" };
  if (!(await options.gate.allow())) return { ok: false, reason: "budget", detail: options.gate.stopped ?? undefined };
  let result: Awaited<ReturnType<EmailVerifier["verify"]>>;
  try {
    result = await options.verifier.verify(email);
  } catch (error) {
    const retryable = error instanceof AdapterError ? error.retryable : true;
    options.log?.warn("verification failed", { provider: options.verifier.name, error: sanitizeErrorMessage(error) });
    return { ok: false, reason: "error", detail: error instanceof AdapterError ? error.code : "unknown", retryable };
  }
  await options.gate.record(result.cost, { provider: options.verifier.name, capability: "email_verify" });
  if (!isStatus(result.status)) {
    return { ok: false, reason: "error", detail: "the verifier returned a status outside the four", retryable: false };
  }
  const record: Omit<VerificationRecord, "cached"> = {
    status: result.status,
    provider: options.verifier.name,
    score: clampScore(result.score),
    acceptAll: typeof result.acceptAll === "boolean" ? result.acceptAll : null,
    disposable: typeof result.disposable === "boolean" ? result.disposable : null,
    reason: cleanProviderText(result.reason, 60),
    verifiedAt: options.now.toISOString(),
  };
  try {
    await cacheVerification(options.db, email, record);
  } catch (error) {
    // The cache is bookkeeping: the result is still used for this run.
    options.log?.warn("verification result could not be cached", { error: sanitizeErrorMessage(error) });
  }
  return { ok: true, record: { ...record, cached: false } };
}
