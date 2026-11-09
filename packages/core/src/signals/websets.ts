// GTM-agents: websets: standing person searches with natural-language criteria, run weekly.
//
// The operator lists webset specs (a natural-language description of the people wanted, and how
// many). Each run:
//   1. for each spec with no webset created in the last 7 days, creates one through the source's
//      watch capability (createWatch) and records it as an inactive discovery_queries row
//      (attribution.ts) with the provider's id in provider_ref. At most 3 are created per run. The
//      provider bills for every item a webset finds, so before each creation the worst case (items
//      times itemUsd) must fit what is left of the run's reservation (maxReserveUsd, the job's daily
//      cap), the spend gate must allow it, and the worst case is recorded as spent at creation;
//      polling records nothing more;
//   2. polls every webset created in the last 14 days (pollWatch, since its last poll) and writes
//      each item as a candidate, up to 200 per run. The poll point advances only when every item
//      was stored, so nothing paid for is skipped.
// An item with a clean work address at its own account domain (screenAddress) is inserted
// qualified, at the fixed score 0.6, so enrichment does not pay to find what the webset found.
// Promotion still runs every check on it: identity, suppression, conflicts, person fit from the
// current brain, the never list, account fit and a fresh verification. An item at an account scored
// below the fit floor is rejected here. Any other item is inserted raw, for
// enrichment to finish, or rejected when it has no company account or is on the never list.
// Everything an item carries is third-party text, cleaned before storage.
import { accountKey } from "../data/keys.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { DiscoverySource, WatchHandle } from "../ports/discovery.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { insertCandidate } from "../sourcing/candidates.ts";
import { matchNeverList, screenAddress, splitPersonName } from "../sourcing/identity.ts";
import { resolveAccountByName } from "../sourcing/search.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { creditResults, ensureSourceQuery } from "./attribution.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import type { WebsetCandidate } from "./ports.ts";

export interface WebsetSpec {
  /** Natural-language criteria for the people wanted. */
  query: string;
  /** Items requested, 1 to 100 (lowered to what the reservation allows). */
  count: number;
  segment?: string;
}

export interface WebsetStats {
  created: number;
  polled: number;
  inserted: number;
  qualified: number;
  rejected: number;
  duplicates: number;
  errors: number;
  budgetStopped: boolean;
}

export interface WebsetRunInput {
  db: D1Database;
  source: DiscoverySource;
  specs: readonly WebsetSpec[];
  brain: SourcingBrain;
  gate: SpendGate;
  now: Date;
  maxRows: number;
  /**
   * The worst-case price of one webset item, in dollars (an item plus its email enrichment). The
   * provider bills for what a webset finds after it is created, so the whole worst case is reserved
   * through the spend gate before creation, and the poll records nothing more.
   */
  itemUsd: number;
  /** The most one run may reserve, in dollars (the job's daily cap). */
  maxReserveUsd: number;
  log: JobLogger;
  signal?: AbortSignal;
}

const DAY_MS = 86_400_000;

type Stored = "inserted" | "qualified" | "rejected" | "duplicate" | "skipped";

async function storeItem(input: WebsetRunInput, queryId: string, spec: WebsetSpec | undefined, item: WebsetCandidate): Promise<Stored> {
  const ref = cleanProviderText(item.providerRef, PROVIDER_TEXT_CAPS.ref);
  if (!ref || item.kind !== "person") return "skipped";
  const name = cleanProviderText(item.name, PROVIDER_TEXT_CAPS.name);
  const person = splitPersonName(name);
  const title = cleanProviderText(item.title, PROVIDER_TEXT_CAPS.title);
  const accountName = cleanProviderText(item.accountName, PROVIDER_TEXT_CAPS.accountName);
  const url = cleanProviderUrl(item.url);
  // The account comes from the item's company, never from the address: an address only counts when
  // it is at the account the company resolves to.
  let domain = accountKey(item.domain ?? null);
  if (!domain && accountName) domain = await resolveAccountByName(input.db, accountName);
  const screened = domain && item.email ? screenAddress(item.email, domain) : null;
  const email = screened?.verdict === "clean" ? (screened.email ?? null) : null;

  let status: "raw" | "rejected" | "qualified" = email && person?.first && title ? "qualified" : "raw";
  let notes: string | null = status === "qualified" ? `webset: fixed score ${SIGNAL_LIMITS.websetScore}; promotion runs every check` : null;
  const never = matchNeverList(input.brain.never, { domain, accountName, title });
  const fit = domain ? await input.db.prepare("SELECT fit_score FROM account_fit WHERE account_key = ?1 AND status = 'scored'").bind(domain).first<{ fit_score: number | null }>() : null;
  if (!domain) {
    status = "rejected";
    notes = "no company domain: a personal mailbox, a shared host or no domain at all";
  } else if (never) {
    status = "rejected";
    notes = never;
  } else if (!person?.first) {
    status = "rejected";
    notes = "the person's name could not be read";
  } else if (fit?.fit_score !== null && fit?.fit_score !== undefined && fit.fit_score < LOW_FIT_SCORE) {
    status = "rejected";
    notes = `the account's fit score is below ${LOW_FIT_SCORE}`;
  }
  const inserted = await insertCandidate(
    input.db,
    {
      source: input.source.name,
      sourceRef: `webset:${ref}`,
      queryId,
      searchType: "person",
      url,
      resultTitle: name,
      snippet: cleanProviderText(item.summary, PROVIDER_TEXT_CAPS.snippet),
      category: "webset",
      firstName: person?.first ?? null,
      lastName: person?.last ?? null,
      email: status === "rejected" ? null : email,
      emailSource: status === "rejected" || !email ? null : input.source.name,
      jobTitle: title,
      accountName,
      accountKey: domain,
      status,
      ...(status === "qualified" ? { qualificationScore: SIGNAL_LIMITS.websetScore } : {}),
      notes,
      attributes: { ...(spec?.segment ? { segment: spec.segment } : {}), intent: "webset", ...(url ? { profile_url: url } : {}) },
    },
    input.now,
  );
  if (!inserted) return "duplicate";
  return status === "raw" ? "inserted" : status;
}

export async function runWebsets(input: WebsetRunInput): Promise<WebsetStats> {
  const stats: WebsetStats = { created: 0, polled: 0, inserted: 0, qualified: 0, rejected: 0, duplicates: 0, errors: 0, budgetStopped: false };
  const { source, db, now } = input;
  if (!source.createWatch || !source.pollWatch) return stats;
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  // 1. Create this week's websets.
  let reserved = 0;
  for (const spec of input.specs) {
    if (stats.created >= SIGNAL_LIMITS.websetMaxPerRun || input.signal?.aborted) break;
    const text = spec.query.replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    const recent = await db.prepare("SELECT 1 AS hit FROM discovery_queries WHERE search_type = 'webset' AND source = ?1 AND query = ?2 AND created_at >= ?3 LIMIT 1").bind(source.name, text.slice(0, 500), weekAgo).first();
    if (recent) continue;
    const left = input.maxReserveUsd - reserved;
    const count = Math.min(100, Math.floor(spec.count), input.itemUsd > 0 ? Math.floor(left / input.itemUsd) : 0);
    if (count < 1) {
      stats.budgetStopped = true;
      break;
    }
    if (!(await input.gate.allow())) {
      stats.budgetStopped = true;
      break;
    }
    let handle: WatchHandle;
    try {
      handle = await source.createWatch({ kind: "person", text, limit: count, ...(spec.segment ? { segment: spec.segment } : {}) });
    } catch (error) {
      stats.errors += 1;
      input.log.warn("webset creation failed", { source: source.name, error: sanitizeErrorMessage(error) });
      continue;
    }
    // The worst case is reserved now: the provider bills for every item the webset finds.
    reserved += count * input.itemUsd;
    await input.gate.record({ provider: source.name, capability: "webset_reserve", usd: count * input.itemUsd, units: count }, { provider: source.name, capability: "webset_reserve" });
    const id = await ensureSourceQuery(db, { kind: "webset", provider: source.name, key: handle.id, text, now });
    await db.prepare("UPDATE discovery_queries SET provider_ref = ?2 WHERE id = ?1").bind(id, handle.id).run();
    stats.created += 1;
  }

  // 2. Poll the open ones.
  const { results: open } = await db
    .prepare("SELECT id, query, provider_ref, last_run_at, created_at FROM discovery_queries WHERE search_type = 'webset' AND source = ?1 AND provider_ref IS NOT NULL AND created_at >= ?2 ORDER BY (last_run_at IS NOT NULL), last_run_at, id LIMIT 20")
    .bind(source.name, new Date(now.getTime() - SIGNAL_LIMITS.websetPollDays * DAY_MS).toISOString())
    .all<{ id: string; query: string; provider_ref: string; last_run_at: string | null; created_at: string }>();
  const specs = new Map(input.specs.map((s) => [s.query.replace(/\s+/g, " ").trim(), s]));
  const cap = Math.min(SIGNAL_LIMITS.websetItemsPerRun, input.maxRows);
  let written = 0;
  for (const row of open) {
    if (written >= cap || input.signal?.aborted) break;
    let items: readonly WebsetCandidate[];
    try {
      // Reading items is covered by the reservation made at creation, so nothing is recorded here.
      const page = await source.pollWatch({ id: row.provider_ref, provider: source.name, createdAt: row.created_at }, row.last_run_at ?? undefined);
      // A webset item may carry the address an enrichment found (WebsetCandidate.email).
      items = page.items;
    } catch (error) {
      stats.errors += 1;
      input.log.warn("webset poll failed", { source: source.name, error: sanitizeErrorMessage(error) });
      continue;
    }
    stats.polled += 1;
    let added = 0;
    let complete = true;
    for (const item of items) {
      if (written >= cap) {
        complete = false;
        break;
      }
      const stored = await storeItem(input, row.id, specs.get(row.query), item);
      if (stored === "skipped") continue;
      written += 1;
      if (stored === "duplicate") stats.duplicates += 1;
      else if (stored === "rejected") stats.rejected += 1;
      else {
        added += 1;
        if (stored === "qualified") stats.qualified += 1;
        else stats.inserted += 1;
      }
    }
    // Advance the poll point only when every item was stored, so items past the cap are read again
    // next run (those already stored are duplicates by source_ref).
    if (complete) await db.prepare("UPDATE discovery_queries SET last_run_at = ?2 WHERE id = ?1").bind(row.id, now.toISOString()).run();
    await creditResults(db, row.id, added);
  }
  return stats;
}
