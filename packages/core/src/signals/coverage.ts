// GTM-agents: coverage fill: more people at high-fit accounts that are showing intent but have too
// few seats covered.
//
// An account qualifies when its model fit score is 7 or more, it has fewer than 2 keep-listed
// contacts (opted-out and churned contacts do not count), and in the last 30 days it had a signal
// or responded (metrics/accounts.ts: a positive reply, a meeting booked, a sign-up or a
// subscription). Each run fills up to 5 such accounts, best fit first, with up to 2 people each:
//   - the account is claimed first in resource_claims, which also keeps a 30-day cooldown per
//     account, so two runs never fill one account and an account is not re-sourced too often. A
//     lookup stopped by the budget or a provider error gives the claim back;
//   - people come from the people provider through the one people lookup (enrichment/people.ts),
//     which cleans provider text, keeps only work addresses at the account's own domain and only
//     titles the brain's personas keep, and asks the spend gate before each paid call;
//   - someone already a contact (the same full name at the account) is skipped;
//   - each person is written as a raw candidate, so enrichment, qualification and promotion run
//     every check on them. A clean work address the provider returned is kept on the row.
// Coverage fill has an inactive discovery_queries row (attribution.ts) for conversion credit.
import { findPeopleAtAccount } from "../enrichment/people.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { respondedAccounts } from "../metrics/accounts.ts";
import type { PeopleProvider } from "../ports/discovery.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { insertCandidate, loadTitleReviews } from "../sourcing/candidates.ts";
import { screenAddress } from "../sourcing/identity.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { creditResults, ensureSourceQuery } from "./attribution.ts";
import { SIGNAL_LIMITS } from "./flags.ts";

const DAY_MS = 86_400_000;
/** People requested per account, before the ones already known are skipped. */
const PEOPLE_REQUESTED = 10;

export interface CoverageStats {
  eligible: number;
  claimed: number;
  inserted: number;
  errors: number;
  budgetStopped: boolean;
}

export interface CoverageRunInput {
  db: D1Database;
  people: PeopleProvider;
  brain: SourcingBrain;
  gate: SpendGate;
  now: Date;
  maxRows: number;
  log: JobLogger;
  signal?: AbortSignal;
}

/** Accounts eligible for coverage fill, best fit first. Throws on a read error. */
export async function coverageAccounts(db: D1Database, now: Date, limit: number): Promise<string[]> {
  const recent = new Date(now.getTime() - SIGNAL_LIMITS.coverageRecentDays * DAY_MS);
  const { results } = await db
    .prepare(
      `SELECT af.account_key,
              EXISTS (SELECT 1 FROM signal_events e WHERE e.account_key = af.account_key AND e.detected_at >= ?3 AND e.status <> 'dismissed') AS signalled
         FROM account_fit af
        WHERE af.status = 'scored' AND af.fit_score >= ?1
          AND (SELECT COUNT(*) FROM contacts c JOIN contact_fit cf ON cf.contact_id = c.id AND cf.decision = 'keep'
                WHERE c.account_key = af.account_key AND c.warmth NOT IN ('opted_out', 'churned')) < ?2
        ORDER BY af.fit_score DESC, af.prescore DESC, af.account_key LIMIT 500`,
    )
    .bind(SIGNAL_LIMITS.coverageMinFit, SIGNAL_LIMITS.coverageMinSeats, recent.toISOString())
    .all<{ account_key: string; signalled: number }>();
  const responded = new Set(await respondedAccounts(db, recent, 1000));
  return results.filter((r) => Number(r.signalled) === 1 || responded.has(r.account_key)).map((r) => r.account_key).slice(0, limit);
}

export type CoverageClaim = { claimed: false } | { claimed: true; previous: string | null };

/**
 * Claim an account for filling, when no fill ran there in the cooldown. Only resourced_at changes:
 * the other counters in resource_claims belong to whoever wrote them. The previous claim time is
 * returned so a failed fill can give the claim back.
 */
export async function claimCoverage(db: D1Database, account: string, now: Date): Promise<CoverageClaim> {
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - SIGNAL_LIMITS.coverageCooldownDays * DAY_MS).toISOString();
  const prior = await db.prepare("SELECT resourced_at FROM resource_claims WHERE account_key = ?1").bind(account).first<{ resourced_at: string }>();
  const result = await db
    .prepare(
      `INSERT INTO resource_claims (account_key, resourced_at, created_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(account_key) DO UPDATE SET resourced_at = excluded.resourced_at
        WHERE resource_claims.resourced_at < ?3`,
    )
    .bind(account, stamp, cutoff)
    .run();
  return (result.meta.changes ?? 0) > 0 ? { claimed: true, previous: prior?.resourced_at ?? null } : { claimed: false };
}

/** Give a claim back after a fill that found nobody because of the budget or a provider error. */
export async function releaseCoverage(db: D1Database, account: string, claim: CoverageClaim, now: Date): Promise<void> {
  if (!claim.claimed) return;
  const stamp = now.toISOString();
  if (claim.previous === null) await db.prepare("DELETE FROM resource_claims WHERE account_key = ?1 AND resourced_at = ?2").bind(account, stamp).run();
  else await db.prepare("UPDATE resource_claims SET resourced_at = ?3 WHERE account_key = ?1 AND resourced_at = ?2").bind(account, stamp, claim.previous).run();
}

export async function runCoverageFill(input: CoverageRunInput): Promise<CoverageStats> {
  const stats: CoverageStats = { eligible: 0, claimed: 0, inserted: 0, errors: 0, budgetStopped: false };
  const { db, now } = input;
  const accounts = await coverageAccounts(db, now, 50);
  stats.eligible = accounts.length;
  if (accounts.length === 0) return stats;
  const reviews = await loadTitleReviews(db);
  const queryId = await ensureSourceQuery(db, { kind: "coverage_fill", provider: input.people.name, key: "coverage_fill", text: "coverage fill at high-fit accounts with intent", now });
  let added = 0;
  for (const account of accounts) {
    if (stats.claimed >= SIGNAL_LIMITS.coverageAccountsPerRun || added >= input.maxRows || input.signal?.aborted) break;
    const claim = await claimCoverage(db, account, now);
    if (!claim.claimed) continue;
    stats.claimed += 1;
    const lookup = await findPeopleAtAccount(account, { people: input.people, gate: input.gate, brain: input.brain, reviews, limit: PEOPLE_REQUESTED, log: input.log });
    if (!lookup.ok) {
      // Nothing was learned about the account, so the cooldown is given back.
      await releaseCoverage(db, account, claim, now);
      stats.claimed -= 1;
      if (lookup.reason === "budget") {
        stats.budgetStopped = true;
        break;
      }
      stats.errors += 1;
      continue;
    }
    let kept = 0;
    for (const person of lookup.people) {
      if (kept >= SIGNAL_LIMITS.coveragePeoplePerAccount || added >= input.maxRows) break;
      const known = person.lastName
        ? await db.prepare("SELECT 1 AS hit FROM contacts WHERE account_key = ?1 AND lower(first_name) = lower(?2) AND lower(last_name) = lower(?3) LIMIT 1").bind(account, person.firstName, person.lastName).first()
        : null;
      if (known) continue;
      const screened = person.email ? screenAddress(person.email, account) : null;
      const inserted = await insertCandidate(
        db,
        {
          source: person.provider,
          sourceRef: person.providerRef,
          queryId,
          searchType: "person",
          url: person.sourceUrl,
          firstName: person.firstName,
          lastName: person.lastName,
          email: screened?.verdict === "clean" ? (screened.email ?? null) : null,
          emailSource: screened?.verdict === "clean" ? person.provider : null,
          jobTitle: person.title,
          accountKey: account,
          category: "coverage_fill",
          status: "raw",
          attributes: { intent: "coverage_fill", ...(person.profileUrl ? { profile_url: person.profileUrl } : {}) },
        },
        now,
      );
      if (!inserted) continue;
      kept += 1;
      added += 1;
    }
    stats.inserted += kept;
  }
  await db.prepare("UPDATE discovery_queries SET last_run_at = ?2 WHERE id = ?1").bind(queryId, now.toISOString()).run();
  await creditResults(db, queryId, added);
  return stats;
}
