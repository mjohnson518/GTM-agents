// GTM-agents: recording a signal: a dated, sourced reason to write to an account.
//
// Every signal row carries a source type (signal_events.source), a category (signal_events.type), a
// severity from 0 to 1, a source URL, an event date, evidence stored as data only, an expiry, and an
// account (and, when routed, a contact). recordSignal refuses, rather than guesses, when any of these
// is missing:
//   - no event date, an unparseable one or one in the future: no signal;
//   - no http(s) URL: no signal;
//   - no expiry after now, or an account that is not known: no signal.
// Routing: a signal goes to at most 2 never-contacted, keep-listed contacts at the account (one row
// each); otherwise to the account itself (contact_id null), where carry.ts may copy it to contacts
// promoted in the next 72 hours; otherwise nowhere. A caller that names its contact (a job change)
// writes to that contact only, and only when the contact is at the account.
//
// The headline and every evidence string are third-party text: cleaned (one line, capped, injection
// patterns redacted) before storage, and still untrusted afterwards. Nothing here builds a prompt or
// copy from them; angles.ts uses fixed openers. An event already recorded at the account (same source
// and event key) is not recorded again, so a source that re-reads a window never routes one event to
// more contacts over time; a signal's id is also derived from its source, event key and target.
import { accountKey } from "../data/keys.ts";
import type { SignalType } from "../ports/discovery.ts";
import { SIGNAL_TYPES } from "../ports/discovery.ts";
import { sha256Hex } from "../shared/hash.ts";
import { cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { SIGNAL_LIMITS } from "./flags.ts";

/** Signal categories that are never copied to colleagues: a person's own move, and product data (privacy). */
export const NEVER_CARRIED_TYPES: readonly SignalType[] = Object.freeze(["job_change", "product_usage"]);
/** Source types that are never carried: markers the system writes for itself. */
export const NEVER_CARRIED_SOURCES: readonly string[] = Object.freeze(["multithread"]);

export const HEADLINE_MAX = 200;
const EVIDENCE_TEXT_MAX = 300;
const SOURCE = /^[a-z][a-z0-9_:-]{0,39}$/;
const DAY_MS = 86_400_000;

export type EvidenceValue = string | number | boolean | null | Readonly<Record<string, number>>;

export interface NewSignal {
  /** The category. */
  type: SignalType;
  /** The source type, for example exa_news or hiring_board. */
  source: string;
  accountKey: string;
  /** Set only by sources about one person (a job change). Otherwise the signal is routed. */
  contactId?: string;
  headline: string;
  url: string;
  /** When the event happened (ISO 8601). */
  eventDate: string;
  severity: number;
  expiresAt: string;
  /** Stored as data only: never instructions, never copy. */
  evidence: Readonly<Record<string, EvidenceValue>>;
  /** Stable per event, for example the provider's result id. */
  eventKey: string;
}

export type RecordOutcome = { status: "recorded"; target: "contacts" | "account"; ids: string[]; inserted: number } | { status: "skipped"; reason: string };

/** The event date, when it parses and is not in the future (a day of clock skew is allowed). */
export function validEventDate(value: string | null | undefined, now: Date): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t > now.getTime() + DAY_MS) return null;
  return new Date(t).toISOString();
}

function cleanEvidence(evidence: Readonly<Record<string, EvidenceValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence).slice(0, 20)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === "string") {
      const cleaned = /url$/.test(key) ? cleanProviderUrl(value) : cleanProviderText(value, EVIDENCE_TEXT_MAX);
      if (cleaned) out[key] = cleaned;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (value && typeof value === "object") {
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(value).slice(0, 20)) if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && Number.isInteger(v) && v >= 0) counts[k] = v;
      out[key] = counts;
    }
  }
  return out;
}

export async function signalId(source: string, eventKey: string, target: string): Promise<string> {
  return `sig_${(await sha256Hex(`${source}\n${eventKey}\n${target}`)).slice(0, 32)}`;
}

/** Never-contacted, keep-listed contacts at an account, oldest first, at most `limit`. */
export async function routeContacts(db: D1Database, account: string, limit: number = SIGNAL_LIMITS.routeMaxContacts): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id FROM contacts c
         JOIN contact_fit cf ON cf.contact_id = c.id AND cf.decision = 'keep'
        WHERE c.account_key = ?1 AND c.warmth = 'cold' AND c.last_contacted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM outreach_sends s WHERE s.contact_id = c.id)
        ORDER BY c.created_at, c.id LIMIT ?2`,
    )
    .bind(account, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Record one signal, routed to contacts or the account. Throws only on a database error. */
export async function recordSignal(db: D1Database, signal: NewSignal, now: Date): Promise<RecordOutcome> {
  if (!(SIGNAL_TYPES as readonly string[]).includes(signal.type)) return { status: "skipped", reason: "unknown category" };
  if (!SOURCE.test(signal.source)) return { status: "skipped", reason: "unknown source type" };
  const eventDate = validEventDate(signal.eventDate, now);
  if (!eventDate) return { status: "skipped", reason: "no event date" };
  const url = cleanProviderUrl(signal.url);
  if (!url) return { status: "skipped", reason: "no source URL" };
  const expires = Date.parse(signal.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return { status: "skipped", reason: "no expiry after now" };
  const account = accountKey(signal.accountKey);
  if (!account) return { status: "skipped", reason: "no account" };
  const headline = cleanProviderText(signal.headline, HEADLINE_MAX);
  if (!headline) return { status: "skipped", reason: "no headline" };
  const eventKey = cleanProviderText(signal.eventKey, 300);
  if (!eventKey) return { status: "skipped", reason: "no event key" };
  const severity = Number.isFinite(signal.severity) ? Math.max(0, Math.min(1, signal.severity)) : SIGNAL_LIMITS.sourcedSeverity;

  const known = await db
    .prepare("SELECT 1 AS hit FROM accounts WHERE account_key = ?1 UNION ALL SELECT 1 FROM account_fit WHERE account_key = ?1 LIMIT 1")
    .bind(account)
    .first<{ hit: number }>();
  if (!known) return { status: "skipped", reason: "the account is not known" };

  // One event is recorded once per account: a later run that sees the same event again does not route
  // it to the next contacts in line.
  const { results: existing } = await db.prepare("SELECT id FROM signal_events WHERE source = ?1 AND entity_id = ?2 AND account_key = ?3 LIMIT 10").bind(signal.source, eventKey, account).all<{ id: string }>();
  if (existing.length > 0) return { status: "recorded", target: "contacts", ids: existing.map((r) => r.id), inserted: 0 };

  let targets: string[];
  if (signal.contactId !== undefined) {
    const at = await db.prepare("SELECT id FROM contacts WHERE id = ?1 AND account_key = ?2").bind(signal.contactId, account).first<{ id: string }>();
    if (!at) return { status: "skipped", reason: "the contact is not at the account" };
    targets = [at.id];
  } else {
    targets = await routeContacts(db, account);
  }
  const evidence = JSON.stringify(cleanEvidence(signal.evidence));
  const stamp = now.toISOString();
  const expiresAt = new Date(expires).toISOString();
  const rows = targets.length > 0 ? targets.map((contactId) => ({ contactId, target: `contact:${contactId}` })) : [{ contactId: null, target: `account:${account}` }];
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const id = await signalId(signal.source, eventKey, row.target);
    ids.push(id);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO signal_events (id, type, account_key, contact_id, entity_id, headline, evidence, source_url, source, severity, status, event_date, detected_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', ?11, ?12, ?13)`,
        )
        .bind(id, signal.type, account, row.contactId, eventKey, headline, evidence, url, signal.source, severity, eventDate, stamp, expiresAt),
    );
  }
  const results = await db.batch(statements);
  const inserted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  return { status: "recorded", target: targets.length > 0 ? "contacts" : "account", ids, inserted };
}

/** An expiry `days` after `now`. */
export function expiryAfter(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}
