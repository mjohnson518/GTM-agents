// GTM-agents: the adapter shapes the signal sources call: websets, find-similar, dated news, search
// monitor deliveries and public hiring boards.
//
// These sit beside the DiscoverySource and SignalSource ports (ports/discovery.ts). Everything an
// adapter returns through them is third-party text: core cleans it before storage and treats it as
// full taint. An adapter makes no decisions (it does not judge fit, match accounts or score), with one
// exception: a hiring-board adapter classifies posting titles into role kinds itself and returns only
// the counts, so a posting title never leaves the adapter.
import type { Candidate } from "../ports/discovery.ts";
import type { Cost, Page } from "../ports/types.ts";

/** A candidate from a webset, which may carry an address the provider found for the person. */
export interface WebsetCandidate extends Candidate {
  /** An address an enrichment returned; unverified. Core keeps it only at the account's own domain. */
  email?: string;
}

/** Accounts similar to a seed page. Optional capability "find_similar". */
export interface SimilarSource {
  readonly name: string;
  findSimilar(args: { url: string; limit: number; excludeDomains?: string[] }): Promise<Page<Candidate>>;
}

export interface NewsHit {
  title: string;
  url: string;
  /** ISO 8601, as the provider reported it. A hit without one is never a signal. */
  publishedAt?: string;
  providerRef: string;
}

/** Dated news search. Optional capability "news". */
export interface NewsSource {
  readonly name: string;
  searchNews(args: { text: string; since: string; limit: number }): Promise<Page<NewsHit>>;
}

/** One result a search monitor delivered, before core cleans it. */
export interface MonitorHit {
  providerRef: string;
  url: string;
  title?: string;
  publishedAt?: string;
}

/** The role kinds a hiring board's postings are counted under. Titles are never kept. */
export const ROLE_KINDS = ["engineering", "data", "product", "design", "sales", "marketing", "customer_success", "operations", "finance", "people", "legal", "other"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const JOB_BOARDS = ["greenhouse", "lever", "ashby"] as const;
export type JobBoard = (typeof JOB_BOARDS)[number];

export interface BoardOpenings {
  status: "found" | "not_found";
  /** Open postings per role kind. Only kinds with at least one posting appear. */
  counts: Partial<Record<RoleKind, number>>;
  total: number;
  /** The newest posting's date (ISO 8601), when the board reports one. */
  latestPostedAt?: string;
  /** The board's public page, for the signal's source URL. */
  boardUrl?: string;
  cost?: Cost;
}

/** Public job boards. */
export interface HiringBoardSource {
  readonly name: string;
  openings(board: JobBoard, token: string): Promise<BoardOpenings>;
}
