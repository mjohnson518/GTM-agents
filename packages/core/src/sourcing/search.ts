// GTM-agents: the search stage: discovery queries become raw candidates.
//
// Queries come from two places, and both are recorded in discovery_queries so every candidate (and
// later every contact) can be traced to the query that found it:
//   - the brain's keyword-portfolio items (operator-approved, part of the `sourcing` task's
//     components), registered once per source as account searches;
//   - rows an operator adds to discovery_queries directly (search_type `person` for person
//     searches, anything else for account searches).
// Each run searches the least recently run active queries, up to discovery:searches_per_cycle. A
// query that was deactivated is never revived. When more than discovery:raw_backlog_max raw
// candidates are waiting, no new search is paid for: the backlog drains first.
//
// Each search is a paid call: the spend gate is asked first and the cost recorded after. Results
// are third-party text, cleaned before storage (text.ts), and deduplicated by (source, source_ref).
// A result with no company account key (a personal mailbox domain, a shared host such as a social
// network or a site builder, or nothing parseable), or on the brain's never list, is stored as
// rejected, so the same result is not paid for or reconsidered again. Accounts on the never list
// and accounts scored below the fit floor are sent to the provider as exclusions.
import { accountKey } from "../data/keys.ts";
import { sha256Hex } from "../shared/hash.ts";
import { AdapterError } from "../ports/types.ts";
import type { Candidate, DiscoverySource } from "../ports/discovery.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import type { SourcingBrain } from "./brain.ts";
import { insertCandidate } from "./candidates.ts";
import type { StageContext } from "./context.ts";
import { accountNameKey, matchNeverList, splitPersonName } from "./identity.ts";
import { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "./text.ts";

/** At most this many domains are sent to a provider as exclusions. */
export const MAX_EXCLUDED_DOMAINS = 100;

export interface PlannedQuery {
  id: string;
  source: string;
  text: string;
  kind: "account" | "person";
  segment?: string;
  intent?: string;
  domains?: string[];
}

export interface SearchLimits {
  searches: number;
  resultsPerSearch: number;
  rawBacklogMax: number;
  /** New candidate rows one run may write (the job's ceilings.maxRows). No further search starts once it is reached. */
  maxRows?: number;
}

export interface SearchStats {
  searches: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  errors: number;
  budgetStopped: boolean;
  /** Why the stage searched nothing on purpose. */
  skipped?: string;
}

/** The discovery_queries id of a brain query for one source: stable, so it is registered once. */
export async function brainQueryId(source: string, query: string): Promise<string> {
  return `kw_${(await sha256Hex(`${source}\n${query}`)).slice(0, 24)}`;
}

/** Register the brain's queries for each source, then pick the least recently run active ones. */
export async function planQueries(db: D1Database, brain: SourcingBrain, sources: readonly string[], limit: number, now: Date): Promise<PlannedQuery[]> {
  if (limit <= 0 || sources.length === 0) return [];
  const stamp = now.toISOString();
  const bySegment = new Map<string, { segment?: string; intent: string }>();
  const register: D1PreparedStatement[] = [];
  for (const source of sources) {
    for (const q of brain.queries) {
      const id = await brainQueryId(source, q.query);
      bySegment.set(id, { intent: q.intent, ...(q.segment ? { segment: q.segment } : {}) });
      register.push(
        db
          .prepare("INSERT OR IGNORE INTO discovery_queries (id, query, source, search_type, category, created_at) VALUES (?1, ?2, ?3, 'account', ?4, ?5)")
          .bind(id, q.query, source, q.intent, stamp),
      );
    }
  }
  for (let i = 0; i < register.length; i += 50) await db.batch(register.slice(i, i + 50));
  const placeholders = sources.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, query, source, search_type, category, include_domains FROM discovery_queries
        WHERE is_active = 1 AND source IN (${placeholders})
        ORDER BY (last_run_at IS NOT NULL), last_run_at, created_at, id LIMIT ?1`,
    )
    .bind(limit, ...sources)
    .all<{ id: string; query: string; source: string; search_type: string | null; category: string | null; include_domains: string | null }>();
  return results.map((row) => {
    const meta = bySegment.get(row.id);
    let domains: string[] | undefined;
    try {
      const parsed: unknown = row.include_domains ? JSON.parse(row.include_domains) : undefined;
      if (Array.isArray(parsed)) domains = parsed.map((d) => accountKey(typeof d === "string" ? d : null)).filter((d): d is string => d !== null);
    } catch {
      domains = undefined;
    }
    return {
      id: row.id,
      source: row.source,
      text: row.query,
      kind: row.search_type === "person" ? "person" : "account",
      ...(meta?.segment ? { segment: meta.segment } : {}),
      ...(meta?.intent || row.category ? { intent: meta?.intent ?? row.category ?? "" } : {}),
      ...(domains && domains.length > 0 ? { domains } : {}),
    };
  });
}

/** Domains sent to providers as exclusions: the never list, then accounts scored below the fit floor. */
export async function exclusionDomains(db: D1Database, brain: SourcingBrain): Promise<string[]> {
  const domains = new Set<string>();
  for (const entry of brain.never.domains) {
    const key = accountKey(entry);
    if (key) domains.add(key);
  }
  const { results } = await db
    .prepare("SELECT account_key FROM account_fit WHERE status = 'scored' AND fit_score < ?1 ORDER BY updated_at DESC LIMIT ?2")
    .bind(LOW_FIT_SCORE, MAX_EXCLUDED_DOMAINS)
    .all<{ account_key: string }>();
  for (const row of results) domains.add(row.account_key);
  return [...domains].slice(0, MAX_EXCLUDED_DOMAINS);
}

/** An account key for a company name from free sources only: known accounts and cached resolutions. */
export async function resolveAccountByName(db: D1Database, name: string): Promise<string | null> {
  const key = accountNameKey(name);
  if (!key) return null;
  const cached = await db.prepare("SELECT domain FROM domain_resolutions WHERE name_key = ?1 AND domain IS NOT NULL").bind(key).first<{ domain: string }>();
  if (cached) return accountKey(cached.domain);
  const { results } = await db.prepare("SELECT account_key, name FROM accounts WHERE lower(name) = lower(?1) LIMIT 2").bind(name).all<{ account_key: string; name: string }>();
  // Two accounts with the same name is ambiguous: skip rather than guess.
  return results.length === 1 && accountNameKey(results[0]?.name) === key ? (results[0]?.account_key ?? null) : null;
}

type Stored = "inserted" | "duplicate" | "rejected" | "skipped";

async function storeResult(ctx: StageContext, source: string, query: PlannedQuery, item: Candidate): Promise<Stored> {
  const ref = cleanProviderText(item.providerRef, PROVIDER_TEXT_CAPS.ref);
  if (!ref) return "skipped";
  const kind = item.kind === "person" ? "person" : "account";
  const url = cleanProviderUrl(item.url);
  const name = cleanProviderText(item.name, kind === "person" ? PROVIDER_TEXT_CAPS.name : PROVIDER_TEXT_CAPS.accountName);
  const quotes = (item.evidence ?? []).map((e) => e.quote).filter((q): q is string => typeof q === "string");
  const snippet = cleanProviderText(item.summary ?? quotes.join(" "), PROVIDER_TEXT_CAPS.snippet);
  const accountName = kind === "account" ? name : cleanProviderText(item.accountName, PROVIDER_TEXT_CAPS.accountName);
  const title = kind === "person" ? cleanProviderText(item.title, PROVIDER_TEXT_CAPS.title) : null;
  const person = kind === "person" ? splitPersonName(name) : null;
  let domain = accountKey(item.domain ?? null) ?? (kind === "account" ? accountKey(url) : null);
  if (!domain && kind === "person" && accountName) domain = await resolveAccountByName(ctx.db, accountName);

  let status: "raw" | "rejected" = "raw";
  let notes: string | null = null;
  const never = matchNeverList(ctx.brain.never, { domain, accountName, title });
  if (!domain) {
    status = "rejected";
    notes = "no company domain: a personal mailbox, a shared host or no domain at all";
  } else if (never) {
    status = "rejected";
    notes = never;
  } else if (kind === "person" && !person?.first) {
    status = "rejected";
    notes = "the person's name could not be read";
  }
  const inserted = await insertCandidate(
    ctx.db,
    {
      source,
      sourceRef: ref,
      queryId: query.id,
      searchType: kind,
      url,
      resultTitle: name,
      snippet,
      category: query.intent ?? null,
      firstName: person?.first ?? null,
      lastName: person?.last ?? null,
      jobTitle: title,
      accountName,
      accountKey: domain,
      status,
      notes,
      attributes: { ...(query.segment ? { segment: query.segment } : {}), ...(query.intent ? { intent: query.intent } : {}) },
    },
    ctx.now,
  );
  if (!inserted) return "duplicate";
  return status === "raw" ? "inserted" : "rejected";
}

export async function searchStage(ctx: StageContext, sources: readonly DiscoverySource[], limits: SearchLimits): Promise<SearchStats> {
  const stats: SearchStats = { searches: 0, inserted: 0, duplicates: 0, rejected: 0, errors: 0, budgetStopped: false };
  if (limits.searches <= 0 || limits.resultsPerSearch <= 0) return { ...stats, skipped: "no searches allowed this run" };
  if (sources.length === 0) return { ...stats, skipped: "no discovery source configured" };
  const backlog = await ctx.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'raw'").first<{ n: number }>();
  if (Number(backlog?.n ?? 0) >= limits.rawBacklogMax) return { ...stats, skipped: `the raw backlog (${backlog?.n}) is at or over ${limits.rawBacklogMax}` };

  const byName = new Map(sources.map((s) => [s.name, s]));
  const queries = await planQueries(ctx.db, ctx.brain, [...byName.keys()], limits.searches, ctx.now);
  if (queries.length === 0) return { ...stats, skipped: "no active queries: add keyword-portfolio items to the brain" };
  const exclude = await exclusionDomains(ctx.db, ctx.brain);
  const disabled = new Set<string>();

  for (const query of queries) {
    if (ctx.signal?.aborted) break;
    if (limits.maxRows !== undefined && stats.inserted + stats.rejected >= limits.maxRows) break;
    const source = byName.get(query.source);
    if (!source || disabled.has(source.name)) continue;
    if (!(await ctx.gate.allow())) {
      stats.budgetStopped = true;
      break;
    }
    let page: Awaited<ReturnType<DiscoverySource["search"]>>;
    try {
      page = await source.search({
        kind: query.kind,
        text: query.text,
        limit: limits.resultsPerSearch,
        ...(query.segment ? { segment: query.segment } : {}),
        ...(query.domains ? { domains: query.domains } : {}),
        ...(exclude.length > 0 ? { excludeDomains: exclude } : {}),
      });
    } catch (error) {
      stats.errors += 1;
      if (!(error instanceof AdapterError) || !error.retryable) disabled.add(source.name);
      ctx.log.warn("search failed", { source: source.name, error: sanitizeErrorMessage(error) });
      // Stamped anyway, so a query that keeps failing rotates to the back instead of blocking the rest.
      await ctx.db.prepare("UPDATE discovery_queries SET last_run_at = ?2 WHERE id = ?1").bind(query.id, ctx.now.toISOString()).run();
      continue;
    }
    await ctx.gate.record(page.cost, { provider: source.name, capability: "search" });
    stats.searches += 1;
    let added = 0;
    for (const item of (page.items ?? []).slice(0, limits.resultsPerSearch)) {
      if (limits.maxRows !== undefined && stats.inserted + stats.rejected >= limits.maxRows) break;
      const stored = await storeResult(ctx, source.name, query, item);
      if (stored === "inserted") {
        stats.inserted += 1;
        added += 1;
      } else if (stored === "duplicate") {
        stats.duplicates += 1;
      } else if (stored === "rejected") {
        stats.rejected += 1;
      }
    }
    await ctx.db
      .prepare("UPDATE discovery_queries SET total_results = total_results + ?2, last_run_at = ?3 WHERE id = ?1")
      .bind(query.id, added, ctx.now.toISOString())
      .run();
  }
  return stats;
}
