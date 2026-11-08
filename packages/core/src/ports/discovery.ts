// GTM-agents: ports for finding accounts and people, signals, and structured B2B data.
import type { Cost, Evidence, Page } from "./types.ts";

export interface DiscoveryQuery {
  kind: "account" | "person";
  /** Natural-language or keyword query. */
  text: string;
  /** Brain segment id, for attribution. */
  segment?: string;
  /** Restrict to these domains when supported. */
  domains?: string[];
  excludeDomains?: string[];
  limit: number;
}

export interface Candidate {
  kind: "account" | "person";
  name: string;
  /** Lowercased registrable domain when known. */
  domain?: string;
  url?: string;
  /** Person only. */
  title?: string;
  /** Person only. */
  accountName?: string;
  summary?: string;
  evidence: Evidence[];
  /** The provider's own id, for dedup and later lookups. */
  providerRef: string;
}

export interface ResearchDossier {
  subject: { kind: "account" | "person"; name: string; domain?: string };
  facts: Array<{ field: string; value: string; evidence: Evidence[] }>;
  /** Blob keys core wrote; raw pages are never inlined. */
  rawTextRefs: string[];
  cost?: Cost;
}

export interface WatchHandle {
  id: string;
  provider: string;
  createdAt: string;
}

export interface DiscoverySource {
  readonly name: string;
  search(q: DiscoveryQuery): Promise<Page<Candidate>>;
  /** Deep research on one subject. Optional capability "research". */
  research?(subject: { kind: "account" | "person"; name: string; domain?: string; urls?: string[] }): Promise<ResearchDossier>;
  /** Standing queries (websets, monitors). Optional capability "watch". */
  createWatch?(q: DiscoveryQuery): Promise<WatchHandle>;
  pollWatch?(handle: WatchHandle, since?: string): Promise<Page<Candidate>>;
  deleteWatch?(handle: WatchHandle): Promise<void>;
}

export const SIGNAL_TYPES = ["job_change", "hiring", "funding", "launch", "post", "news", "filing", "product_usage", "custom"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export interface Signal {
  type: SignalType;
  accountDomain?: string;
  personRef?: { name: string; url?: string; email?: string };
  occurredAt: string;
  /** Provider text; core sanitizes it and taints it as full. */
  summary: string;
  url?: string;
  evidence: Evidence[];
  providerRef: string;
}

export interface SignalSource {
  readonly name: string;
  poll(args: { since: string; accountDomains?: string[]; limit: number }): Promise<Page<Signal>>;
}

export interface PersonFilters {
  titles?: string[];
  seniority?: string[];
  accountDomains?: string[];
  locations?: string[];
  keywords?: string[];
  limit: number;
}

export interface PersonRecord {
  firstName?: string;
  lastName?: string;
  fullName: string;
  title?: string;
  seniority?: string;
  accountName?: string;
  accountDomain?: string;
  location?: string;
  profileUrl?: string;
  /** Only when the provider returned one; unverified. */
  email?: string;
  /** Provider-specific extras, stored under contacts.attributes. */
  attributes: Record<string, unknown>;
  evidence: Evidence[];
  providerRef: string;
}

export interface CompanyRecord {
  name: string;
  domain: string;
  description?: string;
  industry?: string;
  employeeRange?: string;
  foundedYear?: number;
  location?: string;
  fundingStage?: string;
  attributes: Record<string, unknown>;
  evidence: Evidence[];
  providerRef: string;
}

export interface PeopleProvider {
  readonly name: string;
  searchPeople(filters: PersonFilters, cursor?: string): Promise<Page<PersonRecord>>;
  matchPerson(identity: { fullName?: string; accountDomain?: string; profileUrl?: string; email?: string }): Promise<{ record: PersonRecord | null; cost?: Cost }>;
}

export interface CompanyProvider {
  readonly name: string;
  enrichCompany(domain: string): Promise<{ record: CompanyRecord | null; cost?: Cost }>;
}
