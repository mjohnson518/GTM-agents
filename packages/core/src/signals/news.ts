// GTM-agents: funding and leadership news: fixed news searches that become signals at known accounts.
//
// Each run sends a few fixed searches (DEFAULT_NEWS_QUERIES, or the operator's own) over the last 30
// days through a NewsSource (the Exa adapter's dated news search). A hit becomes a signal only when:
//   - it has a published date inside the window and an http(s) URL (no date or no URL, no signal);
//   - its title names exactly one known account (an account not scored below the fit floor) by that
//     account's distinctive name, as a whole phrase;
//   - with that name removed, the rest of the title still reads as the category (a round raised, a
//     leader appointed). Generic words alone never count, so "Acme Funding launches a podcast" is
//     not a funding signal for an account named Acme Funding.
// Funding hits are category funding; severity scales with the round where one is named (0.60 for an
// unnamed or seed round up to 0.64 for a Series D or later), staying below the 0.70 auto-draft line.
// Leadership hits are category news with evidence.category "leadership", severity 0.60. Both expire
// after 30 days. The title is stored cleaned, as data; the opener a message uses is fixed text.
// Each search is a paid call through the spend gate.
import type { JobLogger } from "../jobs/registry.ts";
import { AdapterError } from "../ports/types.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import type { NewsHit, NewsSource } from "./ports.ts";
import { expiryAfter, recordSignal, validEventDate } from "./record.ts";

export type NewsCategory = "funding" | "leadership";

export interface NewsQuery {
  category: NewsCategory;
  text: string;
}

export const DEFAULT_NEWS_QUERIES: readonly NewsQuery[] = Object.freeze([
  { category: "funding", text: "software company raises Series A or Series B funding round" },
  { category: "funding", text: "startup announces seed funding round led by investors" },
  { category: "leadership", text: "software company appoints new chief technology officer" },
  { category: "leadership", text: "company names new VP of engineering" },
]);

const DAY_MS = 86_400_000;

/** Words too common to identify an account on their own. */
const GENERIC_NAMES = new Set(["the", "labs", "group", "company", "software", "tech", "systems", "global", "digital", "data", "cloud", "health", "capital", "ventures", "partners", "solutions"]);

const PATTERNS: Readonly<Record<NewsCategory, RegExp>> = {
  funding: /\b(raises?|raised|raising|secures?|secured|closes?|closed|lands?|announces?)\b[^.]*(\b(funding|financing|round|seed|series [a-h]|investment|million|billion)\b|[$€£]\s?\d)|\b(seed|series [a-h]) (round|funding)\b/i,
  leadership: /\b(appoints?|appointed|names?|named|hires?|hired|welcomes?|promotes?|promoted|joins?)\b[^.]*\b(ceo|cto|cfo|coo|cio|ciso|cpo|cro|chief [a-z]+ officer|vp|vice president|head of [a-z]+|president|general manager)\b/i,
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu");

export interface KnownAccount {
  accountKey: string;
  name: string;
}

/** A distinctive account name for matching: at least 4 letters or digits and not a generic word. Pure. */
export function distinctiveName(name: string | null | undefined): string | null {
  const v = name?.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!v || v.length > 80) return null;
  const compact = v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (compact.length < 4 || GENERIC_NAMES.has(v.toLowerCase())) return null;
  return v;
}

/**
 * The one known account a title names, with the title's remainder after the name is removed, or
 * null when it names none or more than one (a shorter name inside a longer matched one does not
 * count as a second). Pure.
 */
export function matchAccount(title: string, accounts: readonly KnownAccount[]): { account: KnownAccount; rest: string } | null {
  const hits: Array<{ account: KnownAccount; name: string }> = [];
  for (const account of accounts) {
    const name = distinctiveName(account.name);
    if (name && phrase(name).test(title)) hits.push({ account, name });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.name.length - a.name.length);
  const top = hits[0];
  if (!top) return null;
  const others = hits.slice(1).filter((h) => h.account.accountKey !== top.account.accountKey && !top.name.toLowerCase().includes(h.name.toLowerCase()));
  if (others.length > 0) return null;
  return { account: top.account, rest: title.replace(phrase(top.name), " ").replace(/\s+/g, " ").trim() };
}

/** True when a title's remainder reads as the category. Pure. */
export function readsAs(category: NewsCategory, rest: string): boolean {
  return PATTERNS[category].test(rest);
}

/** Funding severity by the round named in the title: 0.60 to 0.64. Pure. */
export function fundingSeverity(title: string): number {
  const series = /\bseries\s+([a-h])\b/i.exec(title)?.[1]?.toLowerCase();
  if (series) return Math.min(0.64, SIGNAL_LIMITS.sourcedSeverity + 0.01 * (series.charCodeAt(0) - 96));
  return SIGNAL_LIMITS.sourcedSeverity;
}

export interface NewsStats {
  searches: number;
  hits: number;
  recorded: number;
  skipped: number;
  errors: number;
  budgetStopped: boolean;
}

export interface NewsRunInput {
  db: D1Database;
  source: NewsSource;
  gate: SpendGate;
  now: Date;
  queries?: readonly NewsQuery[];
  log: JobLogger;
  signal?: AbortSignal;
}

/** Known accounts in scope for news: not scored below the fit floor, best fit first. */
export async function knownAccounts(db: D1Database, limit: number): Promise<KnownAccount[]> {
  const { results } = await db
    .prepare(
      `SELECT a.account_key, a.name FROM accounts a LEFT JOIN account_fit af ON af.account_key = a.account_key
        WHERE af.fit_score IS NULL OR af.fit_score >= ?1
        ORDER BY COALESCE(af.fit_score, 0) DESC, COALESCE(af.prescore, 0) DESC, a.account_key LIMIT ?2`,
    )
    .bind(LOW_FIT_SCORE, limit)
    .all<{ account_key: string; name: string }>();
  return results.map((r) => ({ accountKey: r.account_key, name: r.name }));
}

/** A dated article to read as news: its title, URL and published date, from any source. */
export interface NewsArticle {
  title: string;
  url: string;
  publishedAt?: string;
}

export interface NewsHitOptions {
  /** The signal's source type (signal_events.source), such as exa_news or search_monitor. */
  source: string;
  /** The provider that returned the article, for the evidence. */
  provider: string;
  /** The event key the signal is deduplicated on, per source and account. */
  eventKey: string;
  /** Extra evidence fields, stored as data. */
  evidence?: Readonly<Record<string, string>>;
}

export type NewsHitOutcome = { recorded: true; inserted: boolean; signalId: string | null } | { recorded: false };

/**
 * Record an article as a funding or leadership signal at the one known account its title names, when
 * its published date is inside the news window and the rest of the title reads as one of `categories`
 * (tried in order). An article already recorded for the account under another source with the same
 * URL is not recorded again. That check is best effort: it matches the cleaned URL exactly and is
 * not a claim, so the same story under a different URL, or two jobs racing, can still record it
 * under both sources. `signalId` is one of the event's signal_events rows (the lowest id): an
 * event routed to two contacts has a row each.
 */
export async function recordNewsHit(db: D1Database, article: NewsArticle, categories: readonly NewsCategory[], accounts: readonly KnownAccount[], now: Date, options: NewsHitOptions): Promise<NewsHitOutcome> {
  const published = validEventDate(article.publishedAt, now);
  if (!published || now.getTime() - Date.parse(published) > SIGNAL_LIMITS.newsWindowDays * DAY_MS) return { recorded: false };
  const title = cleanProviderText(article.title, 300);
  const url = cleanProviderUrl(article.url);
  if (!title || !url) return { recorded: false };
  const matched = matchAccount(title, accounts);
  if (!matched) return { recorded: false };
  const category = categories.find((c) => readsAs(c, matched.rest));
  if (!category) return { recorded: false };
  const elsewhere = await db
    .prepare("SELECT 1 AS hit FROM signal_events WHERE account_key = ?1 AND source_url = ?2 AND source <> ?3 LIMIT 1")
    .bind(matched.account.accountKey, url, options.source)
    .first<{ hit: number }>();
  if (elsewhere) return { recorded: false };
  const outcome = await recordSignal(
    db,
    {
      type: category === "funding" ? "funding" : "news",
      source: options.source,
      accountKey: matched.account.accountKey,
      headline: title,
      url,
      eventDate: published,
      severity: category === "funding" ? fundingSeverity(title) : SIGNAL_LIMITS.sourcedSeverity,
      expiresAt: expiryAfter(now, SIGNAL_LIMITS.newsExpiryDays),
      evidence: { ...options.evidence, category, provider: options.provider, published_at: published, source_url: url },
      eventKey: options.eventKey,
    },
    now,
  );
  if (outcome.status !== "recorded") return { recorded: false };
  return { recorded: true, inserted: outcome.inserted > 0, signalId: [...outcome.ids].sort()[0] ?? null };
}

export async function runNewsSignals(input: NewsRunInput): Promise<NewsStats> {
  const stats: NewsStats = { searches: 0, hits: 0, recorded: 0, skipped: 0, errors: 0, budgetStopped: false };
  const accounts = await knownAccounts(input.db, SIGNAL_LIMITS.newsAccountsScanned);
  if (accounts.length === 0) return stats;
  const since = new Date(input.now.getTime() - SIGNAL_LIMITS.newsWindowDays * DAY_MS).toISOString();
  for (const query of (input.queries ?? DEFAULT_NEWS_QUERIES).slice(0, SIGNAL_LIMITS.newsQueriesPerRun)) {
    if (input.signal?.aborted) break;
    if (!(await input.gate.allow())) {
      stats.budgetStopped = true;
      break;
    }
    let hits: NewsHit[];
    try {
      const page = await input.source.searchNews({ text: query.text, since, limit: SIGNAL_LIMITS.newsResultsPerQuery });
      await input.gate.record(page.cost, { provider: input.source.name, capability: "news" });
      hits = page.items.slice(0, SIGNAL_LIMITS.newsResultsPerQuery);
    } catch (error) {
      stats.errors += 1;
      input.log.warn("news search failed", { source: input.source.name, error: sanitizeErrorMessage(error) });
      if (!(error instanceof AdapterError) || !error.retryable) break;
      continue;
    }
    stats.searches += 1;
    for (const hit of hits) {
      stats.hits += 1;
      const outcome = await recordNewsHit(input.db, hit, [query.category], accounts, input.now, { source: "exa_news", provider: input.source.name, eventKey: hit.providerRef || hit.url });
      if (outcome.recorded) stats.recorded += 1;
      else stats.skipped += 1;
    }
  }
  return stats;
}
