// GTM-agents: synthetic fakes for the signal tests. Every company, person, address, board and
// headline here is invented, on *.example domains.
import type { Candidate, DiscoveryQuery, DiscoverySource, WatchHandle } from "../src/ports/discovery.ts";
import type { Page } from "../src/ports/types.ts";
import type { BoardOpenings, HiringBoardSource, JobBoard, NewsHit, NewsSource, SimilarSource, WebsetCandidate } from "../src/signals/ports.ts";
import { expiryAfter, type NewSignal } from "../src/signals/record.ts";

export const NOW = new Date("2026-11-04T09:00:00.000Z");
export const DAY_MS = 86_400_000;
export const daysAgo = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY_MS).toISOString();

export async function resetSignalTables(db: D1Database): Promise<void> {
  const tables = [
    "signal_events",
    "monitor_items",
    "account_hiring_roles",
    "account_job_boards",
    "account_board_checks",
    "resource_claims",
    "outreach_sends",
    "calendar_meetings",
    "funnel_events",
    "contact_evidence",
    "account_contacts",
    "contact_fit",
    "candidates",
    "email_verifications",
    "contacts",
    "accounts",
    "account_fit",
    "discovery_queries",
    "cost_events",
    "suppression",
    "erasure_tombstones",
    "title_fit_reviews",
    "domain_resolutions",
  ];
  await db.batch(tables.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

export async function seedAccount(db: D1Database, key: string, name: string, fit: { score?: number | null; prescore?: number } = {}): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO accounts (account_key, name, domain, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?3)").bind(key, name, daysAgo(60)).run();
  if (fit.score !== undefined || fit.prescore !== undefined) {
    await db
      .prepare("INSERT OR REPLACE INTO account_fit (account_key, account_name, prescore, status, fit_score, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)")
      .bind(key, name, fit.prescore ?? 50, fit.score === null || fit.score === undefined ? "prescored" : "scored", fit.score ?? null, daysAgo(10))
      .run();
  }
}

/** A valid sourced signal at an account, with fields a test may override. */
export function newSignal(account: string, patch: Partial<NewSignal> = {}): NewSignal {
  return {
    type: "funding",
    source: "exa_news",
    accountKey: account,
    headline: "Brightloop Labs raises Series B",
    url: "https://news.example/brightloop-series-b",
    eventDate: daysAgo(3),
    severity: 0.62,
    expiresAt: expiryAfter(NOW, 30),
    evidence: { category: "funding" },
    eventKey: `news-${account}`,
    ...patch,
  };
}

export interface FakeNews extends NewsSource {
  calls: Array<{ text: string; since: string; limit: number }>;
}

export function fakeNews(hits: NewsHit[] | ((text: string) => NewsHit[]), usd = 0.005): FakeNews {
  const calls: FakeNews["calls"] = [];
  return {
    name: "fake-news",
    calls,
    async searchNews(args): Promise<Page<NewsHit>> {
      calls.push(args);
      return { items: typeof hits === "function" ? hits(args.text) : hits, cost: { provider: "fake-news", capability: "news", usd } };
    },
  };
}

export interface FakeBoards extends HiringBoardSource {
  calls: Array<{ board: JobBoard; token: string }>;
}

export function fakeBoards(byToken: Record<string, Partial<Record<JobBoard, BoardOpenings>>>): FakeBoards {
  const calls: FakeBoards["calls"] = [];
  return {
    name: "fake-boards",
    calls,
    async openings(board, token) {
      calls.push({ board, token });
      return byToken[token]?.[board] ?? { status: "not_found", counts: {}, total: 0 };
    },
  };
}

export interface FakeSimilar extends SimilarSource {
  calls: Array<{ url: string; limit: number; excludeDomains?: string[] }>;
}

export function fakeSimilar(bySeed: Record<string, Candidate[]>, usd = 0.005): FakeSimilar {
  const calls: FakeSimilar["calls"] = [];
  return {
    name: "fake-similar",
    calls,
    async findSimilar(args) {
      calls.push(args);
      const seed = new URL(args.url).hostname;
      return { items: (bySeed[seed] ?? []).slice(0, args.limit), cost: { provider: "fake-similar", capability: "find_similar", usd } };
    },
  };
}

export interface FakeWebsets extends DiscoverySource {
  created: DiscoveryQuery[];
  polls: Array<{ id: string; since?: string }>;
}

export function fakeWebsets(items: WebsetCandidate[], usd = 0.05): FakeWebsets {
  const created: DiscoveryQuery[] = [];
  const polls: FakeWebsets["polls"] = [];
  return {
    name: "fake-websets",
    created,
    polls,
    async search() {
      return { items: [], cost: { provider: "fake-websets", capability: "search", usd: 0 } };
    },
    async createWatch(q): Promise<WatchHandle> {
      created.push(q);
      return { id: `ws_${created.length}`, provider: "fake-websets", createdAt: NOW.toISOString() };
    },
    async pollWatch(handle, since) {
      polls.push({ id: handle.id, ...(since ? { since } : {}) });
      return { items, cost: { provider: "fake-websets", capability: "webset_items", usd } };
    },
    async deleteWatch() {},
  };
}

export function accountCandidate(name: string, domain: string): Candidate {
  return { kind: "account", name, domain, url: `https://${domain}/`, evidence: [{ url: `https://${domain}/`, provider: "fake-similar", retrievedAt: NOW.toISOString() }], providerRef: `sim-${domain}` };
}
