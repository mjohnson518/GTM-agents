// GTM-agents: synthetic fakes for the sourcing, enrichment and scoring tests. Every company, person,
// address and hostname here is invented, on *.example domains.
import { computeLock, serializeLock } from "../src/brain/lock.ts";
import { BRAIN_LOCK_KEY, brainFileKey } from "../src/brain/load.ts";
import type { ComponentId } from "../src/brain/components.ts";
import type { FlagReader } from "../src/jobs/registry.ts";
import type { ContactFinder, EmailVerifier, VerificationStatus } from "../src/ports/contact.ts";
import type { Candidate, DiscoveryQuery, DiscoverySource, PeopleProvider, PersonFilters, PersonRecord } from "../src/ports/discovery.ts";
import type { CompletionRequest, CompletionResult, ModelGateway } from "../src/ports/model.ts";
import type { Page } from "../src/ports/types.ts";
import { loadSourcingBrain, type SourcingBrain } from "../src/sourcing/brain.ts";
import type { StageContext } from "../src/sourcing/context.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";

export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

export function brainFile(component: string, body: string, status = "approved"): string {
  return ["---", `component: ${component}`, `status: ${status}`, "version: 1", "updated: 2026-11-01", "---", "", body, ""].join("\n");
}

export const PERSONAS = [
  "# Personas",
  "",
  "## economic-buyer",
  "- role: economic_buyer",
  "- seat: decision_maker",
  "- titles: VP Engineering, Head of Engineering, CTO, Director of Engineering",
  "- seniority: c_level, vp, head, director",
  "- text: Owns the engineering tooling budget.",
  "",
  "## platform-champion",
  "- role: champion",
  "- seat: influencer",
  "- titles: Staff Engineer, Principal Engineer, Platform Lead",
  "- seniority: senior, lead",
  "- text: Feels flaky pipelines every day.",
  "",
  "## engineering-manager",
  "- role: user",
  "- seat: influencer",
  "- titles: Engineering Manager",
  "- seniority: manager",
  "- exclude_titles: Engineering Manager Intern",
  "- text: Watches the team lose focus to reruns.",
].join("\n");

export const ICP = [
  "## who",
  "- kind: who",
  "- text: Software companies with 30 to 300 engineers and CI on every pull request.",
  "",
  "## never-agencies",
  "- kind: never",
  "- text: Agencies build for clients and do not own their CI.",
  "- titles: Agency Owner",
  "",
  "## never-competitors",
  "- kind: never",
  "- text: Never write to companies that sell CI analytics themselves.",
  "- domains: globex.example",
  "- accounts: Initech Analytics",
].join("\n");

export const KEYWORDS = [
  "## flaky-tests-ci",
  "- query: software companies discussing flaky tests slowing their CI pipeline",
  "- intent: problem",
  "",
  "## monorepo-migration",
  "- query: companies migrating to a monorepo with a growing test suite",
  "- intent: trigger",
  "- segment: monorepo teams",
].join("\n");

export const DEFAULT_BRAIN: Partial<Record<ComponentId, string>> = { personas: PERSONAS, icp: ICP, "keyword-portfolio": KEYWORDS };

/** Upload approved, locked brain files to KV, as `gtm brain upload` would. */
export async function uploadBrain(kv: KVNamespace, bodies: Partial<Record<ComponentId, string>> = DEFAULT_BRAIN): Promise<void> {
  const files = Object.entries(bodies).map(([component, body]) => ({ component: component as ComponentId, content: brainFile(component, body ?? "") }));
  const lock = await computeLock(files.map((f) => ({ name: `${f.component}.md`, content: f.content })));
  await kv.put(BRAIN_LOCK_KEY, serializeLock(lock));
  for (const f of files) await kv.put(brainFileKey(f.component), f.content);
}

/** A flag reader over a plain object; a key listed in `failing` throws when read. */
export function flagsOf(values: Record<string, string> = {}, failing: readonly string[] = []): FlagReader & { values: Record<string, string> } {
  return {
    values,
    get(key) {
      if (failing.includes(key) || failing.includes("*")) return Promise.reject(new Error("flag store unavailable"));
      return Promise.resolve(Object.hasOwn(values, key) ? (values[key] ?? null) : null);
    },
  };
}

/** Delete the rows the sourcing tests write. Storage is per test file, so this touches no other suite. */
export async function resetSourcingTables(db: D1Database): Promise<void> {
  const tables = [
    "contact_evidence",
    "account_contacts",
    "contact_fit",
    "candidates",
    "contacts",
    "accounts",
    "account_fit",
    "account_facts",
    "signal_events",
    "email_verifications",
    "discovery_queries",
    "cost_events",
    "suppression",
    "erasure_tombstones",
    "execution_runs",
    "title_fit_reviews",
    "domain_resolutions",
  ];
  await db.batch(tables.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

export interface FakeSource extends DiscoverySource {
  queries: DiscoveryQuery[];
}

/** A discovery source that answers every query with the same results (or per-query results). */
export function fakeSource(name: string, results: Candidate[] | ((q: DiscoveryQuery) => Candidate[]), usd = 0.01): FakeSource {
  const queries: DiscoveryQuery[] = [];
  return {
    name,
    queries,
    async search(q): Promise<Page<Candidate>> {
      queries.push(q);
      const items = (typeof results === "function" ? results(q) : results).slice(0, q.limit);
      return { items, cost: { provider: name, capability: "search", usd, units: 1 } };
    },
  };
}

export function accountResult(name: string, domain: string, ref = `ref-${domain}`, extra: Partial<Candidate> = {}): Candidate {
  return {
    kind: "account",
    name,
    domain,
    url: `https://${domain}/`,
    summary: `${name} runs CI on every pull request.`,
    evidence: [{ url: `https://${domain}/`, provider: "fake-search", retrievedAt: "2026-11-04T09:00:00.000Z" }],
    providerRef: ref,
    ...extra,
  };
}

export interface FakePeople extends PeopleProvider {
  calls: PersonFilters[];
}

export function person(first: string, last: string, title: string, domain: string, email?: string): PersonRecord {
  return {
    firstName: first,
    lastName: last,
    fullName: `${first} ${last}`,
    title,
    accountDomain: domain,
    ...(email ? { email } : {}),
    attributes: {},
    evidence: [{ url: `https://${domain}/team`, provider: "fake-people", retrievedAt: "2026-11-04T09:00:00.000Z" }],
    providerRef: `person-${first.toLowerCase()}-${last.toLowerCase()}-${domain}`,
  };
}

export function fakePeople(name: string, byDomain: Record<string, PersonRecord[]>, usd = 0.02): FakePeople {
  const calls: PersonFilters[] = [];
  return {
    name,
    calls,
    async searchPeople(filters) {
      calls.push(filters);
      const domain = filters.accountDomains?.[0] ?? "";
      return { items: (byDomain[domain] ?? []).slice(0, filters.limit), cost: { provider: name, capability: "people_search", usd, units: 1 } };
    },
    async matchPerson() {
      return { record: null };
    },
  };
}

export interface FakeFinder extends ContactFinder {
  calls: Array<{ firstName: string; lastName: string; domain: string }>;
}

/** A finder keyed by "first last@domain" (lowercase); a missing key finds nothing; the value "throw" throws. */
export function fakeFinder(name: string, addresses: Record<string, string | null>, usd = 0.02): FakeFinder {
  const calls: FakeFinder["calls"] = [];
  return {
    name,
    calls,
    async findWorkEmail(args) {
      calls.push({ firstName: args.firstName, lastName: args.lastName, domain: args.domain });
      const found = addresses[`${args.firstName} ${args.lastName}@${args.domain}`.toLowerCase()];
      if (found === "throw") throw new Error("finder unavailable");
      const cost = { provider: name, capability: "email_find", usd: found ? usd : 0 };
      return found ? { email: found, confidence: 92, sources: [{ url: `https://${args.domain}/team`, provider: name, retrievedAt: "2026-11-04T09:00:00.000Z" }], cost } : { email: null, cost };
    },
  };
}

export interface FakeVerifier extends EmailVerifier {
  calls: string[];
}

export function fakeVerifier(name: string, statuses: Record<string, VerificationStatus> = {}, fallback: VerificationStatus = "deliverable", usd = 0.01): FakeVerifier {
  const calls: string[] = [];
  return {
    name,
    calls,
    async verify(email) {
      calls.push(email);
      const status = statuses[email] ?? fallback;
      return { status, score: status === "deliverable" ? 95 : 40, reason: status, acceptAll: status === "risky", disposable: false, cost: { provider: name, capability: "email_verify", usd } };
    },
  };
}

export interface FakeModel extends ModelGateway {
  requests: CompletionRequest[];
}

export function fakeModel(reply: string | ((req: CompletionRequest) => string), model = "test-classifier-model"): FakeModel {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake-gateway",
    requests,
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      return { text: typeof reply === "string" ? reply : reply(req), toolCalls: [], stopReason: "end", usage: { inputTokens: 1000, outputTokens: 100 }, model };
    },
    async embed() {
      return { vectors: [], model };
    },
  };
}

/** A stage context over the test database, with the uploaded brain. */
export async function stageContext(db: D1Database, kv: KVNamespace, overrides: Partial<StageContext> & { flags?: FlagReader; jobCapCents?: number } = {}): Promise<StageContext> {
  const flags = overrides.flags ?? flagsOf();
  const brain: SourcingBrain = overrides.brain ?? (await loadSourcingBrain(kv));
  const job = overrides.job ?? "discovery_cycle";
  return {
    db,
    flags,
    brain,
    gate: overrides.gate ?? createSpendGate({ db, flags, job, runId: overrides.runId ?? "run-test", ...(overrides.jobCapCents !== undefined ? { jobCapCents: overrides.jobCapCents } : {}) }),
    now: overrides.now ?? new Date("2026-11-04T09:00:00.000Z"),
    job,
    runId: overrides.runId ?? "run-test",
    log: silentLog,
  };
}
