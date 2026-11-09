// GTM-agents: responder lookalikes: accounts similar to the ones that responded.
//
// Seeds are accounts that responded in the last 180 days (metrics/accounts.ts: a positive reply, a
// meeting booked, a sign-up or a subscription). Each run takes up to 5 seeds, least recently used
// first, asks a SimilarSource (the Exa adapter's find-similar) for companies like each seed's site,
// and writes each new company as a raw account candidate, up to 30 a run, for the discovery cycle
// to enrich, qualify and promote. A result is skipped when it:
//   - has no company account key (a personal or shared host), is the seed, or is on the never list;
//   - is already labelled: an account the deployment knows (in accounts), or one with contacts;
//   - was a candidate in the last 90 days;
//   - has a model fit score below the fit floor.
// Each seed has an inactive discovery_queries row (attribution.ts), so its lookalikes earn
// conversion credit and the seed rotation is kept in last_run_at. Every search is a paid call
// through the spend gate. Results are third-party text, cleaned before storage.
import { accountKey } from "../data/keys.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { respondedAccounts } from "../metrics/accounts.ts";
import { AdapterError } from "../ports/types.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { insertCandidate } from "../sourcing/candidates.ts";
import { matchNeverList } from "../sourcing/identity.ts";
import { MAX_EXCLUDED_DOMAINS } from "../sourcing/search.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { creditResults, ensureSourceQuery, sourceQueryId } from "./attribution.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import type { SimilarSource } from "./ports.ts";

const DAY_MS = 86_400_000;

export interface LookalikeStats {
  seeds: number;
  searches: number;
  inserted: number;
  skipped: number;
  errors: number;
  budgetStopped: boolean;
}

export interface LookalikeRunInput {
  db: D1Database;
  source: SimilarSource;
  brain: SourcingBrain;
  gate: SpendGate;
  now: Date;
  maxRows: number;
  log: JobLogger;
  signal?: AbortSignal;
}

/** Why a lookalike result is skipped, or null when it may become a candidate. */
export async function lookalikeExclusion(db: D1Database, brain: SourcingBrain, domain: string, seed: string, now: Date): Promise<string | null> {
  if (domain === seed) return "the seed itself";
  const never = matchNeverList(brain.never, { domain, accountName: null, title: null });
  if (never) return never;
  const recent = new Date(now.getTime() - SIGNAL_LIMITS.lookalikeRecentCandidateDays * DAY_MS).toISOString();
  const hit = await db
    .prepare(
      `SELECT 'labelled' AS why FROM accounts WHERE account_key = ?1
       UNION ALL SELECT 'known contacts' FROM contacts WHERE account_key = ?1
       UNION ALL SELECT 'a recent candidate' FROM candidates WHERE account_key = ?1 AND created_at >= ?2
       UNION ALL SELECT 'low fit' FROM account_fit WHERE account_key = ?1 AND status = 'scored' AND fit_score < ?3
       LIMIT 1`,
    )
    .bind(domain, recent, LOW_FIT_SCORE)
    .first<{ why: string }>();
  return hit?.why ?? null;
}

export async function runLookalikes(input: LookalikeRunInput): Promise<LookalikeStats> {
  const stats: LookalikeStats = { seeds: 0, searches: 0, inserted: 0, skipped: 0, errors: 0, budgetStopped: false };
  const { db, now, source } = input;
  const responded = await respondedAccounts(db, new Date(now.getTime() - SIGNAL_LIMITS.lookalikeSeedDays * DAY_MS), 200);
  if (responded.length === 0) return stats;
  // Least recently used seeds first, through their attribution rows.
  const rotation: Array<{ seed: string; lastRun: string }> = [];
  for (const seed of responded) {
    const id = await sourceQueryId("lookalike", source.name, seed);
    const row = await db.prepare("SELECT last_run_at FROM discovery_queries WHERE id = ?1").bind(id).first<{ last_run_at: string | null }>();
    rotation.push({ seed, lastRun: row?.last_run_at ?? "" });
  }
  rotation.sort((a, b) => a.lastRun.localeCompare(b.lastRun) || a.seed.localeCompare(b.seed));
  const neverDomains = brainNeverDomains(input.brain);
  const cap = Math.min(SIGNAL_LIMITS.lookalikeInsertsPerRun, input.maxRows);

  for (const { seed } of rotation.slice(0, SIGNAL_LIMITS.lookalikeSeedsPerRun)) {
    if (stats.inserted >= cap || input.signal?.aborted) break;
    stats.seeds += 1;
    if (!(await input.gate.allow())) {
      stats.budgetStopped = true;
      break;
    }
    const queryId = await ensureSourceQuery(db, { kind: "lookalike", provider: source.name, key: seed, text: `companies similar to ${seed}`, now });
    let items;
    try {
      const page = await source.findSimilar({ url: `https://${seed}/`, limit: SIGNAL_LIMITS.lookalikeResultsPerSeed, excludeDomains: [seed, ...neverDomains].slice(0, MAX_EXCLUDED_DOMAINS) });
      await input.gate.record(page.cost, { provider: source.name, capability: "find_similar" });
      items = page.items.slice(0, SIGNAL_LIMITS.lookalikeResultsPerSeed);
    } catch (error) {
      stats.errors += 1;
      input.log.warn("find-similar failed", { source: source.name, error: sanitizeErrorMessage(error) });
      await db.prepare("UPDATE discovery_queries SET last_run_at = ?2 WHERE id = ?1").bind(queryId, now.toISOString()).run();
      if (!(error instanceof AdapterError) || !error.retryable) break;
      continue;
    }
    stats.searches += 1;
    let added = 0;
    for (const item of items) {
      if (stats.inserted >= cap) break;
      const url = cleanProviderUrl(item.url);
      const domain = accountKey(item.domain ?? null) ?? accountKey(url);
      if (!domain || item.kind !== "account" || (await lookalikeExclusion(db, input.brain, domain, seed, now))) {
        stats.skipped += 1;
        continue;
      }
      const inserted = await insertCandidate(
        db,
        {
          source: source.name,
          sourceRef: `similar:${domain}`,
          queryId,
          searchType: "account",
          url,
          resultTitle: cleanProviderText(item.name, PROVIDER_TEXT_CAPS.resultTitle),
          snippet: cleanProviderText(item.summary, PROVIDER_TEXT_CAPS.snippet),
          category: "lookalike",
          accountName: cleanProviderText(item.name, PROVIDER_TEXT_CAPS.accountName),
          accountKey: domain,
          status: "raw",
          attributes: { intent: "lookalike", seed },
        },
        now,
      );
      if (inserted) {
        stats.inserted += 1;
        added += 1;
      } else {
        stats.skipped += 1;
      }
    }
    await db.prepare("UPDATE discovery_queries SET last_run_at = ?2 WHERE id = ?1").bind(queryId, now.toISOString()).run();
    await creditResults(db, queryId, added);
  }
  return stats;
}

function brainNeverDomains(brain: SourcingBrain): string[] {
  const out = new Set<string>();
  for (const entry of brain.never.domains) {
    const key = accountKey(entry);
    if (key) out.add(key);
  }
  return [...out];
}
