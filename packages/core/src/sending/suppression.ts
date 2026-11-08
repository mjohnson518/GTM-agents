// GTM-agents: the suppression list: addresses the system never emails.
//
// Entries are keyed by the SHA-256 of the normalized address. The plaintext address is optional, so
// an erasure can keep someone suppressed without keeping their address. Reasons: opt_out, bounce,
// complaint, erasure, manual, do_not_contact.
//
// It is a compliance control, so the check fails closed:
//   - a database error blocks every recipient in the batch;
//   - a recipient that is not exactly one address is blocked rather than guessed at. A display name
//     ("Jane Doe <jane@acme.example>") is allowed only when it holds no line breaks, control
//     characters or address syntax (@ , ; < >) outside a quoted string.
// Subaddresses count as the same mailbox: suppressing jane+news@ also suppresses jane@ and
// jane+other@, and the reverse. Each entry is stored under the exact address's hash and, when it
// has a +tag, under the hash of the address without it; checks look up both. This can only block
// more, which is the safe direction. Provider-specific rules (such as ignoring dots) are not
// applied. There is no remove function: taking someone off a do-not-contact list is a decision for
// a person, made in the database.
import { sha256Hex } from "../shared/hash.ts";

export const SUPPRESSION_REASONS = ["opt_out", "bounce", "complaint", "erasure", "manual", "do_not_contact"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

// D1 binds at most 100 parameters per statement.
const CHUNK = 90;

const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The normalized form of an address (lowercase, display name removed), or null when it cannot be
 * parsed as exactly one plain ASCII address.
 */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const bracketed = /<([^<>]*)>\s*$/.exec(text);
  if (bracketed) {
    // The display name may hold one quoted string; outside it, no control characters and no
    // address syntax, so nothing in it can name another mailbox or start another header.
    // eslint-disable-next-line no-control-regex -- control characters are what this rejects
    const display = text.slice(0, bracketed.index).replace(/"[^"\\\x00-\x1f\x7f]*"/, "");
    // eslint-disable-next-line no-control-regex -- control characters are what this rejects
    if (/[\x00-\x1f\x7f@,;<>"\\]/.test(display)) return null;
    text = (bracketed[1] ?? "").trim();
  }
  if (text.length === 0 || text.length > 254) return null;
  if (/[\s"(),:;<>[\\\]]/.test(text) || /[^\x21-\x7e]/.test(text)) return null;
  const at = text.lastIndexOf("@");
  if (at <= 0 || text.indexOf("@") !== at) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).toLowerCase();
  if (!LOCAL_PART.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!DOMAIN.test(domain)) return null;
  return `${local.toLowerCase()}@${domain}`;
}

/** The key of a suppression entry: SHA-256 of the normalized address. */
export function addressHash(normalized: string): Promise<string> {
  return sha256Hex(normalized);
}

/** The normalized address without a +tag subaddress: jane+news@acme.example becomes jane@acme.example. */
export function mailboxOf(normalized: string): string {
  const at = normalized.lastIndexOf("@");
  const plus = normalized.indexOf("+");
  return plus > 0 && plus < at ? `${normalized.slice(0, plus)}${normalized.slice(at)}` : normalized;
}

export interface SuppressionEntry {
  /** The address. Either this or emailSha256 is required. */
  email?: string;
  /** The hash alone, for entries that must not keep the address (erasure). */
  emailSha256?: string;
  reason: SuppressionReason;
  source?: string;
  notes?: string;
  /** Keep the plaintext address alongside the hash. Defaults to true when `email` is given. */
  storeAddress?: boolean;
}

/**
 * Add an entry. Idempotent: an existing entry keeps its original reason. Throws on invalid input
 * and on a database error, so a caller never believes an address is suppressed when it is not.
 */
export async function addSuppression(db: D1Database, entry: SuppressionEntry): Promise<{ added: boolean; emailSha256: string }> {
  if (!(SUPPRESSION_REASONS as readonly string[]).includes(entry.reason)) throw new TypeError(`unknown suppression reason "${String(entry.reason)}"`);
  let hash: string;
  let address: string | null = null;
  let mailboxHash: string | null = null;
  if (entry.email !== undefined) {
    const normalized = normalizeAddress(entry.email);
    if (!normalized) throw new TypeError("the address to suppress cannot be parsed");
    hash = await addressHash(normalized);
    if (mailboxOf(normalized) !== normalized) mailboxHash = await addressHash(mailboxOf(normalized));
    if (entry.storeAddress !== false) address = normalized;
  } else if (typeof entry.emailSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.emailSha256)) {
    hash = entry.emailSha256;
  } else {
    throw new TypeError("a suppression entry needs an address or a lowercase hex SHA-256");
  }
  const now = new Date().toISOString();
  const insert = "INSERT OR IGNORE INTO suppression (email_sha256, email, reason, source, notes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
  const result = await db.prepare(insert).bind(hash, address, entry.reason, entry.source ?? null, entry.notes ?? null, now).run();
  // The mailbox entry keeps no address: it exists only so other subaddresses match.
  if (mailboxHash) await db.prepare(insert).bind(mailboxHash, null, entry.reason, entry.source ?? null, entry.notes ?? null, now).run();
  return { added: (result.meta.changes ?? 0) > 0, emailSha256: hash };
}

export interface BlockedRecipient {
  recipient: string;
  reason: SuppressionReason | "unparseable" | "check_failed";
}

export interface SuppressionCheck {
  /** True only when every recipient was checked and none is suppressed. */
  ok: boolean;
  blocked: BlockedRecipient[];
  /** The normalized addresses of the recipients that may be emailed, deduplicated. */
  allowed: string[];
}

/** Check recipients against the list. Fails closed: on a database error, every recipient is blocked. */
export async function checkSuppression(db: D1Database, recipients: readonly string[]): Promise<SuppressionCheck> {
  const blocked: BlockedRecipient[] = [];
  const byHash = new Map<string, string[]>();
  const normalizedOf = new Map<string, string>();
  const remember = (hash: string, recipient: string) => byHash.set(hash, [...(byHash.get(hash) ?? []), recipient]);
  for (const recipient of recipients) {
    const normalized = normalizeAddress(recipient);
    if (!normalized) {
      blocked.push({ recipient, reason: "unparseable" });
      continue;
    }
    normalizedOf.set(recipient, normalized);
    remember(await addressHash(normalized), recipient);
    if (mailboxOf(normalized) !== normalized) remember(await addressHash(mailboxOf(normalized)), recipient);
  }
  try {
    const hashes = [...byHash.keys()];
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const chunk = hashes.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, k) => `?${k + 1}`).join(", ");
      const { results } = await db
        .prepare(`SELECT email_sha256, reason FROM suppression WHERE email_sha256 IN (${placeholders})`)
        .bind(...chunk)
        .all<{ email_sha256: string; reason: SuppressionReason }>();
      for (const row of results) {
        for (const recipient of byHash.get(row.email_sha256) ?? []) {
          if (!blocked.some((b) => b.recipient === recipient)) blocked.push({ recipient, reason: row.reason });
        }
      }
    }
  } catch {
    return { ok: false, blocked: recipients.map((recipient) => ({ recipient, reason: "check_failed" as const })), allowed: [] };
  }
  const blockedSet = new Set(blocked.map((b) => b.recipient));
  const allowed = [...new Set(recipients.filter((r) => !blockedSet.has(r)).map((r) => normalizedOf.get(r) ?? ""))].filter(Boolean);
  return { ok: blocked.length === 0, blocked, allowed };
}
