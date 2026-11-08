// GTM-agents: the account prescore: a free, nightly 0 to 100 score from data already in the database.
//
// The prescore ranks accounts before any money is spent on them: the model fit score (fit.ts)
// works down the accounts in prescore order. It uses only what the deployment already holds, and
// never calls a provider or a model:
//   - team:       how many contacts the account has (a rough proxy for a real team), up to 20;
//   - seniority:  a decision maker among them (25), or someone at head or director level (15);
//   - coverage:   how many distinct persona roles are covered, 5 each, up to 15;
//   - signal:     a recent buying signal for the account (20 at severity 0.5 or more, else 10);
//   - reachable:  at least one contact with a deliverable address (10);
//   - facts:      firmographic facts on file (10).
// Personas and titles come from the brain, through the one title classifier. An account on the
// brain's never list scores 0.
import { classifyTitle } from "./titles.ts";
import { matchNeverList } from "../sourcing/identity.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";

export interface AccountAggregate {
  accountKey: string;
  accountName: string | null;
  /** Job titles of the account's contacts (opted-out contacts excluded). */
  titles: readonly (string | null)[];
  /** Contacts whose address verified deliverable. */
  deliverableContacts: number;
  /** The highest severity among the account's recent signals, or null when there are none. */
  recentSignalSeverity: number | null;
  hasFacts: boolean;
}

export interface Prescore {
  total: number;
  parts: { team: number; seniority: number; coverage: number; signal: number; reachable: number; facts: number };
  contactsCount: number;
  buyerCount: number;
  never: boolean;
}

function teamPoints(n: number): number {
  if (n >= 4 && n <= 15) return 20;
  if (n >= 2) return 15;
  if (n === 1) return 5;
  return 0;
}

/** Score one account. Pure. */
export function computePrescore(account: AccountAggregate, brain: Pick<SourcingBrain, "personas" | "never">): Prescore {
  const contactsCount = account.titles.length;
  const zero = { team: 0, seniority: 0, coverage: 0, signal: 0, reachable: 0, facts: 0 };
  if (matchNeverList(brain.never, { domain: account.accountKey, accountName: account.accountName })) {
    return { total: 0, parts: zero, contactsCount, buyerCount: 0, never: true };
  }
  const classes = account.titles.map((t) => classifyTitle(t, brain.personas, { never: brain.never }));
  const kept = classes.filter((c) => c.decision === "keep");
  const buyerCount = kept.filter((c) => c.seat === "decision_maker").length;
  const senior = classes.some((c) => c.decision !== "drop" && c.rank >= 4);
  const roles = new Set(kept.map((c) => c.role).filter((r) => r !== null));
  const severity = account.recentSignalSeverity;
  const parts = {
    team: teamPoints(contactsCount),
    seniority: buyerCount > 0 ? 25 : senior ? 15 : 0,
    coverage: Math.min(3, roles.size) * 5,
    signal: severity === null ? 0 : severity >= 0.5 ? 20 : 10,
    reachable: account.deliverableContacts > 0 ? 10 : 0,
    facts: account.hasFacts ? 10 : 0,
  };
  const total = Math.max(0, Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));
  return { total, parts, contactsCount, buyerCount, never: false };
}

const DAY_MS = 86_400_000;
/** Signals older than this do not count toward the prescore. */
export const PRESCORE_SIGNAL_DAYS = 90;
/** Contacts read per run; the job's maxRows bounds the accounts written. */
const CONTACT_SCAN_LIMIT = 20_000;

export interface PrescoreRunOptions {
  db: D1Database;
  brain: Pick<SourcingBrain, "personas" | "never">;
  now: Date;
  /** The most accounts written in one run. */
  maxAccounts: number;
  signal?: AbortSignal;
}

/** Recompute the prescore of every account with contacts, up to maxAccounts. Returns accounts written. */
export async function runPrescore(options: PrescoreRunOptions): Promise<number> {
  const { db, now } = options;
  const { results: contacts } = await db
    .prepare(
      `SELECT c.account_key, c.job_title, c.verification_status, a.name AS account_name
         FROM contacts c LEFT JOIN accounts a ON a.account_key = c.account_key
        WHERE c.account_key IS NOT NULL AND c.warmth <> 'opted_out'
        ORDER BY c.account_key LIMIT ?1`,
    )
    .bind(CONTACT_SCAN_LIMIT)
    .all<{ account_key: string; job_title: string | null; verification_status: string | null; account_name: string | null }>();
  const accounts = new Map<string, AccountAggregate>();
  for (const row of contacts) {
    let entry = accounts.get(row.account_key);
    if (!entry) {
      if (accounts.size >= options.maxAccounts) continue;
      entry = { accountKey: row.account_key, accountName: row.account_name, titles: [], deliverableContacts: 0, recentSignalSeverity: null, hasFacts: false };
      accounts.set(row.account_key, entry);
    }
    (entry.titles as Array<string | null>).push(row.job_title);
    if (row.verification_status === "deliverable") entry.deliverableContacts += 1;
  }
  if (accounts.size === 0) return 0;
  const since = new Date(now.getTime() - PRESCORE_SIGNAL_DAYS * DAY_MS).toISOString();
  const { results: signals } = await db
    .prepare(
      `SELECT account_key, MAX(severity) AS severity FROM signal_events
        WHERE account_key IS NOT NULL AND detected_at >= ?1 AND status IN ('new', 'acknowledged', 'actioned')
        GROUP BY account_key`,
    )
    .bind(since)
    .all<{ account_key: string; severity: number }>();
  for (const s of signals) {
    const entry = accounts.get(s.account_key);
    if (entry) entry.recentSignalSeverity = Number(s.severity);
  }
  const { results: facts } = await db.prepare("SELECT account_key FROM account_facts WHERE status = 'found'").all<{ account_key: string }>();
  for (const f of facts) {
    const entry = accounts.get(f.account_key);
    if (entry) entry.hasFacts = true;
  }

  const stamp = now.toISOString();
  const upsert = db.prepare(
    `INSERT INTO account_fit (account_key, account_name, contacts_count, buyer_count, prescore, prescore_detail, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(account_key) DO UPDATE SET account_name = COALESCE(excluded.account_name, account_fit.account_name),
       contacts_count = excluded.contacts_count, buyer_count = excluded.buyer_count, prescore = excluded.prescore,
       prescore_detail = excluded.prescore_detail, updated_at = excluded.updated_at`,
  );
  const statements: D1PreparedStatement[] = [];
  for (const account of accounts.values()) {
    const score = computePrescore(account, options.brain);
    const detail = JSON.stringify({ ...score.parts, never: score.never });
    statements.push(upsert.bind(account.accountKey, account.accountName, score.contactsCount, score.buyerCount, score.total, detail, stamp));
  }
  let written = 0;
  for (let i = 0; i < statements.length; i += 50) {
    if (options.signal?.aborted) break;
    const chunk = statements.slice(i, i + 50);
    await db.batch(chunk);
    written += chunk.length;
  }
  return written;
}
