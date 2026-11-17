// GTM-agents: the account watch (docs/SIGNALS.md#account-watch): weekly news on the accounts that
// matter most, in one digest.
//
// Each run covers up to SIGNAL_LIMITS.watchAccountsPerRun accounts, in this order: accounts you
// pinned (accounts.attributes.watch, set with watch-add), accounts with an open deal past contacted
// (engaged, demo scheduled, trial, proposal or negotiation), then the best model fit not scored
// below LOW_FIT_SCORE. An account is covered only when its name is distinctive enough to match in a
// title (distinctiveName). For each, one dated news search for its name over the last 7 days goes
// through the spend gate. A hit is kept only when it has a date in the window and an http(s) URL,
// and its title names that account (matchAccount over that account alone). Each kept item, at most
// SIGNAL_LIMITS.watchItemsPerSubject per account, is claimed in the effects ledger
// (watch:<account>:<url hash>), so it is listed in one digest and never again; a funding or
// leadership item is also recorded as a signal by the news rules (recordNewsHit, source
// account_watch).
//
// The digest goes to the operator once per ISO week (deliverOnce). A run in a week whose digest has
// already gone searches nothing. When the digest cannot be sent (no channel, or the channel failed),
// or lost a race with a concurrent run, or the run fails, the run's claims are released, so the next
// run lists those items. Titles are third-party text,
// cleaned to one capped line with injection patterns redacted. They go to the operator, and a
// funding or leadership title is also a signal's headline, which reaches copy only through the
// opt-in, reviewed headline variable (docs/SIGNALS.md). A provider error that cannot be retried
// stops the searches; the digest still lists what was found.
import { claimEffect, hasEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { AdapterError } from "../ports/types.ts";
import { REPORT_EFFECT, deliverOnce, type DeliveryStatus } from "../reports/deliver.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { sha256Hex } from "../shared/hash.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import { distinctiveName, matchAccount, recordNewsHit, type KnownAccount } from "./news.ts";
import type { NewsSource } from "./ports.ts";
import { validEventDate } from "./record.ts";

const DAY_MS = 86_400_000;
export const ACCOUNT_WATCH_SOURCE = "account_watch";
/** Deal stages past contacted that are still open. */
export const WATCHED_DEAL_STAGES = ["engaged", "demo_scheduled", "trial", "proposal", "negotiation"] as const;

/** "2026-W47": the ISO week of a date, for a digest's once-per-week key. Pure. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WatchReason = "pinned" | "deal" | "fit";

export interface WatchedAccount extends KnownAccount {
  reason: WatchReason;
}

/** The accounts the watch covers this run, in order: pinned, then open deals, then fit. */
export async function watchedAccounts(db: D1Database, limit: number = SIGNAL_LIMITS.watchAccountsPerRun): Promise<WatchedAccount[]> {
  const { results } = await db
    .prepare(
      `SELECT a.account_key, a.name,
              CASE WHEN json_extract(a.attributes, '$.watch') IN (1, 'true') THEN 0
                   WHEN EXISTS (SELECT 1 FROM deals d WHERE d.account_key = a.account_key AND d.stage IN (SELECT value FROM json_each(?1))) THEN 1
                   ELSE 2 END AS tier
         FROM accounts a LEFT JOIN account_fit af ON af.account_key = a.account_key
        WHERE json_extract(a.attributes, '$.watch') IN (1, 'true')
           OR EXISTS (SELECT 1 FROM deals d WHERE d.account_key = a.account_key AND d.stage IN (SELECT value FROM json_each(?1)))
           OR af.fit_score >= ?2
        ORDER BY tier, COALESCE(af.fit_score, 0) DESC, a.account_key
        LIMIT ?3`,
    )
    .bind(JSON.stringify(WATCHED_DEAL_STAGES), LOW_FIT_SCORE, limit * 3)
    .all<{ account_key: string; name: string; tier: number }>();
  const reasons: WatchReason[] = ["pinned", "deal", "fit"];
  return results
    .filter((r) => distinctiveName(r.name) !== null)
    .slice(0, limit)
    .map((r) => ({ accountKey: r.account_key, name: r.name, reason: reasons[r.tier] ?? "fit" }));
}

export interface WatchItem {
  title: string;
  url: string;
  publishedAt: string;
}

export interface AccountWatchStats {
  accounts: number;
  searches: number;
  items: number;
  signals: number;
  errors: number;
  budgetStopped: boolean;
  digest: DeliveryStatus | "not_sent";
}

export interface AccountWatchInput {
  db: D1Database;
  source: NewsSource;
  gate: SpendGate;
  now: Date;
  log: JobLogger;
  operator?: OperatorChannel | undefined;
  signal?: AbortSignal;
}

/** A hit kept for the digest, or null: dated in the window, with a URL, naming `subject` alone. */
export function keepHit(hit: { title?: string; url?: string; publishedAt?: string }, subject: KnownAccount, now: Date): WatchItem | null {
  const published = validEventDate(hit.publishedAt, now);
  if (!published || now.getTime() - Date.parse(published) > SIGNAL_LIMITS.watchWindowDays * DAY_MS) return null;
  const title = cleanProviderText(hit.title, 200);
  const url = cleanProviderUrl(hit.url);
  if (!title || !url) return null;
  if (!matchAccount(title, [subject])) return null;
  return { title, url, publishedAt: published };
}

const SIGHTING_EFFECT = "watch_item";

/** Claim an item for the digest: its claim key the first time it is seen for this subject, else null. */
export async function firstSighting(db: D1Database, scope: string, url: string): Promise<string | null> {
  const key = `watch:${scope}:${(await sha256Hex(url)).slice(0, 32)}`;
  return (await claimEffect(db, key, SIGHTING_EFFECT)) ? key : null;
}

/** Release this run's claims when its digest could not be sent, so the next run lists those items. */
export async function releaseSightings(db: D1Database, keys: readonly string[]): Promise<void> {
  for (const key of keys) await releaseEffect(db, key, SIGHTING_EFFECT);
}

/** True when this week's digest has already gone: the run then searches nothing. Fails toward not searching. */
export async function digestSent(db: D1Database, key: string, log: JobLogger): Promise<boolean> {
  try {
    return await hasEffect(db, key, REPORT_EFFECT);
  } catch (error) {
    log.warn("a watch digest's claim could not be read; the run searches nothing", { key, error: sanitizeErrorMessage(error) });
    return true;
  }
}

/**
 * Release a run's claims unless its digest went: a digest that failed, had no channel, or lost a
 * race with a concurrent run (already_sent) listed none of them, so the next run should.
 */
export async function settleSightings(db: D1Database, digest: DeliveryStatus | "not_sent", keys: readonly string[]): Promise<void> {
  if (digest !== "sent") await releaseSightings(db, keys);
}

/** The digest text. Pure. */
export function renderAccountDigest(week: string, found: ReadonlyArray<{ account: WatchedAccount; items: WatchItem[] }>, covered: number): string {
  const lines = [`Account watch, ${week}: ${covered} account${covered === 1 ? "" : "s"} checked`];
  const withNews = found.filter((f) => f.items.length > 0);
  if (withNews.length === 0) {
    lines.push("", "Nothing new this week.");
    return lines.join("\n");
  }
  for (const { account, items } of withNews) {
    lines.push("", `${account.name} (${account.accountKey}, ${account.reason === "pinned" ? "pinned" : account.reason === "deal" ? "open deal" : "top fit"}):`);
    for (const item of items.slice(0, SIGNAL_LIMITS.watchItemsPerSubject)) lines.push(`- ${item.publishedAt.slice(0, 10)} ${item.title}`, `  ${item.url}`);
  }
  lines.push("", "Titles are as the publishers wrote them, unverified.");
  return lines.join("\n");
}

/** Run the account watch and send its digest. Throws only on a database error. */
export async function runAccountWatch(input: AccountWatchInput): Promise<AccountWatchStats> {
  const stats: AccountWatchStats = { accounts: 0, searches: 0, items: 0, signals: 0, errors: 0, budgetStopped: false, digest: "not_sent" };
  const week = isoWeek(input.now);
  const reportKey = `report:account_watch:${week}`;
  if (await digestSent(input.db, reportKey, input.log)) return { ...stats, digest: "already_sent" };
  const claimed: string[] = [];
  try {
    return await accountWatchRun(input, stats, week, reportKey, claimed);
  } catch (error) {
    // A database error mid-run: nothing was listed, so the claims made so far are given back.
    await releaseSightings(input.db, claimed).catch(() => undefined);
    throw error;
  }
}

async function accountWatchRun(input: AccountWatchInput, stats: AccountWatchStats, week: string, reportKey: string, claimed: string[]): Promise<AccountWatchStats> {
  const accounts = await watchedAccounts(input.db);
  const since = new Date(input.now.getTime() - SIGNAL_LIMITS.watchWindowDays * DAY_MS).toISOString();
  const found: Array<{ account: WatchedAccount; items: WatchItem[] }> = [];
  for (const account of accounts) {
    if (input.signal?.aborted) break;
    if (!(await input.gate.allow())) {
      stats.budgetStopped = true;
      break;
    }
    let hits: Awaited<ReturnType<NewsSource["searchNews"]>>["items"];
    try {
      const page = await input.source.searchNews({ text: account.name, since, limit: SIGNAL_LIMITS.watchResultsPerSearch });
      await input.gate.record(page.cost, { provider: input.source.name, capability: "news" });
      hits = page.items.slice(0, SIGNAL_LIMITS.watchResultsPerSearch);
    } catch (error) {
      stats.errors += 1;
      input.log.warn("account watch search failed", { source: input.source.name, error: sanitizeErrorMessage(error) });
      if (!(error instanceof AdapterError) || !error.retryable) break;
      continue;
    }
    stats.searches += 1;
    stats.accounts += 1;
    const items: WatchItem[] = [];
    for (const hit of hits) {
      if (items.length >= SIGNAL_LIMITS.watchItemsPerSubject) break;
      const item = keepHit(hit, account, input.now);
      if (!item || items.some((i) => i.url === item.url)) continue;
      const key = await firstSighting(input.db, account.accountKey, item.url);
      if (!key) continue;
      claimed.push(key);
      items.push(item);
      const signal = await recordNewsHit(input.db, { title: item.title, url: item.url, publishedAt: item.publishedAt }, ["funding", "leadership"], [account], input.now, {
        source: ACCOUNT_WATCH_SOURCE,
        provider: input.source.name,
        eventKey: item.url,
      });
      if (signal.recorded && signal.inserted) stats.signals += 1;
    }
    stats.items += items.length;
    found.push({ account, items });
  }
  if (accounts.length > 0) {
    stats.digest = await deliverOnce({ db: input.db, operator: input.operator, log: input.log }, reportKey, renderAccountDigest(week, found, stats.accounts));
    await settleSightings(input.db, stats.digest, claimed);
  }
  return stats;
}
