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

/** The fields a company research run asks for, named as they are stored (account_facts and its attributes). */
export const RESEARCH_FIELDS = [
  "employee_range",
  "employees_count",
  "hq_country",
  "founded_year",
  "industry",
  "sector",
  "company_type",
  "funding_stage",
  "last_round_date",
  "raised_usd",
  "technologies",
  "hiring_functions",
] as const;
export type ResearchField = (typeof RESEARCH_FIELDS)[number];

/** The functions a company research run may say an account is hiring for. */
export const RESEARCH_HIRING_FUNCTIONS = ["engineering", "data", "product", "design", "sales", "marketing", "customer_success", "operations", "finance", "people", "legal"] as const;
export type ResearchHiringFunction = (typeof RESEARCH_HIRING_FUNCTIONS)[number];

/** The source of one kept field: the first citation the provider grounded it with. */
export interface FieldEvidence extends Evidence {
  field: ResearchField;
  /** An http or https URL. */
  url: string;
}

/**
 * A researched company. Every value kept is under `attributes`, keyed by its ResearchField name; the
 * CompanyRecord fields repeat the ones it names. Every kept field has exactly one FieldEvidence.
 */
export interface CompanyResearchRecord extends CompanyRecord {
  evidence: FieldEvidence[];
  /** The provider's own verdict: it found the company, found nothing, or could not inspect the site. */
  verdict: "found" | "not_found" | "cannot_verify";
}

export type CompanyResearchRead =
  | { status: "pending" }
  | { status: "failed"; reason: string; cost?: Cost }
  /** `dropped` names the fields the provider returned that were not kept (ungrounded, weakly grounded or invalid). */
  | { status: "done"; record: CompanyResearchRecord | null; dropped: ResearchField[]; cost: Cost };

/**
 * Asynchronous company research. Optional capability "company_research". A run takes seconds to
 * minutes, so it is started in one job run and read in a later one. The adapter keeps a field only
 * when the provider cites a source for it; core stores only what is kept.
 */
export interface CompanyResearchSource {
  readonly name: string;
  /** Start a run for the company at `domain`. The cost is what the run is expected to bill. */
  startCompanyResearch(args: { domain: string; name?: string }): Promise<{ runId: string; cost: Cost }>;
  readCompanyResearch(runId: string): Promise<CompanyResearchRead>;
  /** What one start is expected to bill. Core records it when a start fails in a way that may still have created a run. */
  startCost(): Cost;
}
