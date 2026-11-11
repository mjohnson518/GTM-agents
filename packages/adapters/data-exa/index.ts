// GTM-agents: the Exa adapter: a DiscoverySource backed by Exa's search API, with websets,
// find-similar, dated news search and search monitor deliveries.
//
// Capabilities (manifest.json lists each with its cost and its tool class):
//   search        POST /search: account and person searches (the discovery cycle);
//   watch         websets: createWatch (POST /websets/v0/websets, a person search with natural-language
//                 criteria and an email enrichment), pollWatch (GET .../items, newest items since the
//                 last poll) and deleteWatch (DELETE .../{id});
//   find_similar  POST /findSimilar: companies like a seed site (responder lookalikes);
//   news          POST /search with category news and a published-date floor (funding and leadership);
//   monitor       verifyMonitorSignature and parseMonitorDelivery for the signed deliveries a search
//                 monitor posts to /api/webhooks/search/:key (Exa-Signature: t=<unix>,v1=<hex>, an
//                 HMAC-SHA256 of "<t>.<raw body>" with the monitor's secret);
//   company_research  the Agent API, asynchronously: startCompanyResearch (POST /agent/runs with a fixed
//                 output schema and system prompt) and readCompanyResearch (GET /agent/runs/{id}). A
//                 field is kept only when the run grounds it with an http(s) citation at medium or high
//                 confidence; everything else is reported as dropped.
// Requests and responses are translated in small, separate functions, so a change in the vendor's
// API is corrected in one place. The adapter makes no decisions: it does not sanitize, deduplicate or
// filter results, and it does not judge which domain is a company or which account a headline names.
// Core does all of that, and treats everything returned as full taint.
//
// Options (gtm.config.ts, adapters["data-exa"].options), all optional:
//   baseUrl          default https://api.exa.ai
//   searchType       default "auto"
//   accountCategory  default "company"   (the category used for account searches)
//   personCategory   default "people"    (the category used for person searches)
//   highlightChars   default 400         (characters of highlights per result; 0 requests none)
//   websetEmail      default true        (ask websets for a work email enrichment)
//   creditUsd        default 0.006       (dollars per websets credit, for the cost estimate)
//   researchEffort   default "medium"    (company research effort: "medium" or "low"; anything else is
//                                         refused when the adapter is created, because only these two
//                                         have a fixed price that can be reserved before a run)
// Secret: EXA_API_KEY (wrangler secret put EXA_API_KEY). Each monitor's signing secret is its own
// Worker secret, named in the deployment's monitor config.
import {
  AdapterError,
  RESEARCH_HIRING_FUNCTIONS,
  type AdapterContext,
  type AdapterErrorCode,
  type Candidate,
  type CompanyResearchRead,
  type CompanyResearchRecord,
  type CompanyResearchSource,
  type Cost,
  type DiscoveryQuery,
  type DiscoverySource,
  type FieldEvidence,
  type Page,
  type ResearchField,
  type WatchHandle,
} from "@gtm-agents/core/ports";
import type { MonitorHit, NewsHit, NewsSource, SimilarSource, WebsetCandidate } from "@gtm-agents/core/signals";

/** Release a response body we will not read. Not awaited: a cancelled stream need not settle first. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

export const NAME = "data-exa";
export const SECRET = "EXA_API_KEY";
/**
 * Prices from manifest.json, used when a response does not report its own cost. A search-type
 * request includes up to INCLUDED_RESULTS results; each result asked for beyond that is billed
 * at extraResult.
 */
export const PRICES = Object.freeze({ search: 0.007, extraResult: 0.001, highlightsPerResult: 0.001, findSimilar: 0.007, news: 0.007, researchMedium: 0.1, researchLow: 0.025 });
/** Results included in the base price of one search-type request. */
export const INCLUDED_RESULTS = 10;

/** The estimated price of one search-type request asking for `results` results. */
export function requestPrice(base: number, results: number): number {
  return base + Math.max(0, Math.floor(results) - INCLUDED_RESULTS) * PRICES.extraResult;
}
/** Websets credits, from manifest.json: per matching item, and per email enrichment. */
export const WEBSET_CREDITS = Object.freeze({ item: 10, email: 5 });
const MAX_RESULTS = 100;
/** Items read from one webset per poll. */
export const WEBSET_POLL_MAX = 200;
/** A monitor delivery older than this is refused, so a captured one cannot be replayed later. */
export const MONITOR_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

interface ExaOptions {
  baseUrl: string;
  searchType: string;
  accountCategory: string;
  personCategory: string;
  highlightChars: number;
  websetEmail: boolean;
  creditUsd: number;
  researchEffort: ResearchEffort;
}

/** The research efforts this adapter allows: the two with a fixed price that can be reserved before a run. */
export const RESEARCH_EFFORTS = ["medium", "low"] as const;
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

/** The fixed price of one research run at an effort. */
export function researchPrice(effort: ResearchEffort): number {
  return effort === "low" ? PRICES.researchLow : PRICES.researchMedium;
}

function readEffort(value: unknown): ResearchEffort {
  if (value === undefined) return "medium";
  if (typeof value === "string" && (RESEARCH_EFFORTS as readonly string[]).includes(value)) return value as ResearchEffort;
  throw new Error(`data-exa option researchEffort must be one of ${RESEARCH_EFFORTS.join(", ")}`);
}

function readOptions(raw: Record<string, unknown>): ExaOptions {
  const str = (key: string, fallback: string) => {
    const value = raw[key];
    return typeof value === "string" && value.length > 0 ? value : fallback;
  };
  const chars = typeof raw.highlightChars === "number" && Number.isInteger(raw.highlightChars) && raw.highlightChars >= 0 ? raw.highlightChars : 400;
  return {
    baseUrl: str("baseUrl", "https://api.exa.ai").replace(/\/+$/, ""),
    searchType: str("searchType", "auto"),
    accountCategory: str("accountCategory", "company"),
    personCategory: str("personCategory", "people"),
    highlightChars: chars,
    websetEmail: raw.websetEmail !== false,
    creditUsd: typeof raw.creditUsd === "number" && Number.isFinite(raw.creditUsd) && raw.creditUsd >= 0 ? raw.creditUsd : 0.006,
    researchEffort: readEffort(raw.researchEffort),
  };
}

/** The JSON body for POST /search. */
export function buildSearchRequest(q: DiscoveryQuery, options: ExaOptions): Record<string, unknown> {
  const category = q.kind === "person" ? options.personCategory : options.accountCategory;
  const body: Record<string, unknown> = {
    query: q.text,
    type: options.searchType,
    category,
    numResults: Math.max(1, Math.min(MAX_RESULTS, Math.floor(q.limit))),
  };
  if (q.domains && q.domains.length > 0) body.includeDomains = q.domains;
  // The people category does not accept excludeDomains.
  if (q.excludeDomains && q.excludeDomains.length > 0 && category !== "people") body.excludeDomains = q.excludeDomains;
  if (options.highlightChars > 0) body.contents = { highlights: { maxCharacters: options.highlightChars } };
  return body;
}

interface ExaEntity {
  type?: unknown;
  properties?: Record<string, unknown>;
}

interface ExaResult {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  author?: unknown;
  summary?: unknown;
  highlights?: unknown;
  entities?: unknown;
}

interface ExaResponse {
  results?: unknown;
  costDollars?: { total?: unknown };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function entity(result: ExaResult, type: string): Record<string, unknown> | undefined {
  if (!Array.isArray(result.entities)) return undefined;
  const found = (result.entities as ExaEntity[]).find((e) => e && e.type === type);
  return found?.properties;
}

/** Split a profile page title such as "Jane Doe - Staff Engineer - Brightloop" into its parts. */
function splitProfileTitle(title: string | undefined): { name?: string; role?: string; company?: string } {
  if (!title) return {};
  const head = title.split(" | ")[0] ?? title;
  const parts = head.split(" - ").map((p) => p.trim()).filter((p) => p.length > 0);
  const [name, role, company] = parts;
  if (role && !company && role.includes(" at ")) {
    const [r, c] = role.split(" at ");
    return { ...(name ? { name } : {}), ...(r ? { role: r.trim() } : {}), ...(c ? { company: c.trim() } : {}) };
  }
  return { ...(name ? { name } : {}), ...(role ? { role } : {}), ...(company ? { company } : {}) };
}

/** Map a /search response to candidates and a cost. */
export function mapSearchResponse(body: ExaResponse, q: DiscoveryQuery, retrievedAt: string, highlightChars: number): Page<Candidate> {
  const results = Array.isArray(body.results) ? (body.results as ExaResult[]) : [];
  const items: Candidate[] = [];
  for (const r of results.slice(0, MAX_RESULTS)) {
    const id = text(r.id);
    const url = text(r.url);
    if (!id || !url) continue;
    const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : [];
    const summary = text(r.summary) ?? (highlights.length > 0 ? highlights.join(" ") : undefined);
    const evidence = [{ url, ...(highlights[0] ? { quote: highlights[0] } : {}), provider: NAME, retrievedAt }];
    if (q.kind === "person") {
      const person = entity(r, "person");
      const parsed = splitProfileTitle(text(r.title));
      const name = text(person?.name) ?? text(r.author) ?? parsed.name;
      if (!name) continue;
      const title = text(person?.title) ?? text(person?.position) ?? parsed.role;
      const accountName = text(person?.company) ?? parsed.company;
      items.push({ kind: "person", name, url, ...(title ? { title } : {}), ...(accountName ? { accountName } : {}), ...(summary ? { summary } : {}), evidence, providerRef: id });
    } else {
      const company = entity(r, "company");
      const name = text(company?.name) ?? text(r.title) ?? hostOf(url);
      const domain = hostOf(url);
      if (!name) continue;
      items.push({ kind: "account", name, url, ...(domain ? { domain } : {}), ...(summary ? { summary } : {}), evidence, providerRef: id });
    }
  }
  const reported = typeof body.costDollars?.total === "number" && Number.isFinite(body.costDollars.total) ? body.costDollars.total : undefined;
  const estimate = requestPrice(PRICES.search, Math.min(MAX_RESULTS, q.limit)) + (highlightChars > 0 ? results.length * PRICES.highlightsPerResult : 0);
  const cost: Cost = { provider: NAME, capability: "search", usd: reported ?? estimate, units: 1 };
  return { items, cost };
}

/** The AdapterError for a failed HTTP response. */
export function errorForStatus(status: number, retryAfter: string | null): AdapterError {
  const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined;
  const table: Record<number, [AdapterErrorCode, boolean]> = {
    400: ["invalid", false],
    401: ["auth", false],
    402: ["quota", false],
    403: ["auth", false],
    404: ["not_found", false],
    408: ["timeout", true],
    422: ["invalid", false],
    429: ["rate_limited", true],
  };
  const [code, retryable] = table[status] ?? (status >= 500 ? ["unavailable", true] : ["unknown", false]);
  return new AdapterError(`Exa search returned HTTP ${status}`, code, retryable, retryAfterMs !== undefined ? { retryAfterMs } : {});
}

/** The JSON body for POST /websets/v0/websets: a person search with an optional email enrichment. */
export function buildWebsetRequest(q: DiscoveryQuery, options: Pick<ExaOptions, "websetEmail">): Record<string, unknown> {
  return {
    search: { query: q.text, count: Math.max(1, Math.min(MAX_RESULTS, Math.floor(q.limit))), entity: { type: q.kind === "person" ? "person" : "company" } },
    ...(options.websetEmail && q.kind === "person" ? { enrichments: [{ description: "The person's work email address", format: "email" }] } : {}),
  };
}

interface WebsetItem {
  id?: unknown;
  createdAt?: unknown;
  properties?: {
    type?: unknown;
    url?: unknown;
    description?: unknown;
    person?: { name?: unknown; position?: unknown; company?: { name?: unknown } | null };
    company?: { name?: unknown };
  };
  enrichments?: unknown;
}

/** Map webset items newer than `since` to candidates. */
export function mapWebsetItems(items: readonly WebsetItem[], since: string | undefined, retrievedAt: string): WebsetCandidate[] {
  const floor = since && Number.isFinite(Date.parse(since)) ? Date.parse(since) : -Infinity;
  const out: WebsetCandidate[] = [];
  for (const item of items) {
    const id = text(item.id);
    const created = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
    // After the first poll, an item with no creation date cannot be placed after the last poll, so
    // it is skipped rather than read again on every poll.
    if (!id || (Number.isFinite(created) ? created <= floor : since !== undefined)) continue;
    const props = item.properties ?? {};
    const url = text(props.url);
    const evidence = [{ ...(url ? { url } : {}), provider: NAME, retrievedAt }];
    if (props.type === "person") {
      const name = text(props.person?.name);
      if (!name) continue;
      const title = text(props.person?.position);
      const accountName = text(props.person?.company?.name);
      const enrichments = Array.isArray(item.enrichments) ? (item.enrichments as Array<{ format?: unknown; status?: unknown; result?: unknown }>) : [];
      const email = enrichments.find((e) => e && e.format === "email" && e.status === "completed" && Array.isArray(e.result) && typeof e.result[0] === "string")?.result as string[] | undefined;
      out.push({ kind: "person", name, ...(url ? { url } : {}), ...(title ? { title } : {}), ...(accountName ? { accountName } : {}), ...(email?.[0] ? { email: email[0] } : {}), evidence, providerRef: id });
    } else if (props.type === "company") {
      const name = text(props.company?.name) ?? hostOf(url);
      const domain = hostOf(url);
      if (!name) continue;
      out.push({ kind: "account", name, ...(url ? { url } : {}), ...(domain ? { domain } : {}), ...(text(props.description) ? { summary: text(props.description) } : {}), evidence, providerRef: id });
    }
  }
  return out;
}

/** The JSON body for POST /findSimilar. */
export function buildSimilarRequest(args: { url: string; limit: number; excludeDomains?: string[] }): Record<string, unknown> {
  return {
    url: args.url,
    numResults: Math.max(1, Math.min(MAX_RESULTS, Math.floor(args.limit))),
    excludeSourceDomain: true,
    category: "company",
    ...(args.excludeDomains && args.excludeDomains.length > 0 ? { excludeDomains: args.excludeDomains } : {}),
  };
}

/** The JSON body for a dated news search. */
export function buildNewsRequest(args: { text: string; since: string; limit: number }, options: Pick<ExaOptions, "searchType">): Record<string, unknown> {
  return { query: args.text, type: options.searchType, category: "news", numResults: Math.max(1, Math.min(MAX_RESULTS, Math.floor(args.limit))), startPublishedDate: args.since };
}

/** Map a news search response to hits. A result without a URL or a title is dropped; the date is passed on as reported. */
export function mapNewsResponse(body: { results?: unknown; costDollars?: { total?: unknown } }, limit: number): Page<NewsHit> {
  const results = Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : [];
  const items: NewsHit[] = [];
  for (const r of results.slice(0, Math.max(0, limit))) {
    const id = text(r.id);
    const url = text(r.url);
    const title = text(r.title);
    if (!id || !url || !title) continue;
    const publishedAt = text(r.publishedDate);
    items.push({ title, url, providerRef: id, ...(publishedAt ? { publishedAt } : {}) });
  }
  const reported = typeof body.costDollars?.total === "number" && Number.isFinite(body.costDollars.total) ? body.costDollars.total : undefined;
  return { items, cost: { provider: NAME, capability: "news", usd: reported ?? requestPrice(PRICES.news, Math.min(MAX_RESULTS, limit)), units: 1 } };
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 of "<t>.<raw body>" with the secret, as lowercase hex. */
export async function signMonitorDelivery(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
}

/**
 * Verify a monitor delivery's Exa-Signature header: t=<unix seconds>,v1=<hex>[,v1=<hex>...]. Valid
 * when the timestamp is within five minutes of now and any v1 matches, compared in constant time.
 */
export async function verifyMonitorSignature(args: { secret: string; headers: Headers; rawBody: string; now: Date }): Promise<boolean> {
  const header = args.headers.get("exa-signature");
  if (!header || args.secret.length === 0) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    if (k === "v1" && v && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(args.now.getTime() - timestamp * 1000) > MONITOR_SIGNATURE_TOLERANCE_MS) return false;
  const expected = await signMonitorDelivery(args.secret, timestamp, args.rawBody);
  return signatures.some((s) => timingSafeEqual(s, expected));
}

/**
 * The results a monitor delivery carries, or null when the body is not a monitor run event. Results
 * are read from data.results, data.output.results or data.items, whichever is present.
 */
export function parseMonitorDelivery(body: unknown): MonitorHit[] | null {
  if (!body || typeof body !== "object") return null;
  const event = body as { type?: unknown; data?: unknown };
  if (typeof event.type !== "string" || !event.type.startsWith("monitor.")) return null;
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
  const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : {};
  const list = [data.results, output.results, data.items].find((v) => Array.isArray(v)) as Array<Record<string, unknown>> | undefined;
  if (!list) return [];
  const hits: MonitorHit[] = [];
  for (const r of list.slice(0, 1000)) {
    const url = text(r?.url);
    if (!url) continue;
    const title = text(r.title);
    const publishedAt = text(r.publishedDate);
    hits.push({ providerRef: text(r.id) ?? url, url, ...(title ? { title } : {}), ...(publishedAt ? { publishedAt } : {}) });
  }
  return hits;
}

const nullable = (schema: Record<string, unknown> & { type: string }): Record<string, unknown> => ({ ...schema, type: [schema.type, "null"] });

/**
 * The output schema every research run is held to. It is fixed here, never written by a model or
 * taken from provider text: every field nullable, plus the run's verdict.
 */
export const RESEARCH_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["employee_range", "employees_count", "hq_country", "founded_year", "industry", "sector", "company_type", "funding_stage", "last_round_date", "raised_usd", "technologies", "hiring_functions", "verdict"],
  properties: {
    employee_range: nullable({ type: "string", maxLength: 40, description: "Employee headcount band, for example 51-200" }),
    employees_count: nullable({ type: "integer", minimum: 1, description: "Number of employees" }),
    hq_country: nullable({ type: "string", pattern: "^[A-Z]{2}$", description: "Headquarters country, ISO 3166-1 alpha-2" }),
    founded_year: nullable({ type: "integer", minimum: 1800, description: "Year the company was founded" }),
    industry: nullable({ type: "string", maxLength: 80 }),
    sector: nullable({ type: "string", maxLength: 80 }),
    company_type: nullable({ type: "string", maxLength: 40, description: "For example private, public, non-profit, subsidiary" }),
    funding_stage: nullable({ type: "string", maxLength: 40, description: "Latest funding stage, for example seed, series_a" }),
    last_round_date: nullable({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Date of the latest funding round, YYYY-MM-DD" }),
    raised_usd: nullable({ type: "integer", minimum: 0, description: "Total funding raised, in US dollars" }),
    technologies: nullable({ type: "array", maxItems: 10, items: { type: "string", maxLength: 60 } }),
    hiring_functions: nullable({ type: "array", maxItems: 5, items: { type: "string", enum: [...RESEARCH_HIRING_FUNCTIONS] } }),
    verdict: { type: "string", enum: ["found", "not_found", "cannot_verify"] },
  },
});

/** The fixed system prompt for every research run. No account, provider or brain text is ever added to it. */
export const RESEARCH_SYSTEM_PROMPT = [
  "You research one company: the company whose website is at the domain named in the query. Judge only that company, never a similarly named one.",
  "Use only that company's own website and named public sources about it (company registries, funding announcements, press coverage, its job board). Cite every value you return.",
  "Return null for any field you cannot source. Never guess, estimate or infer a value without a source.",
  "Set verdict to found when you identified the company, not_found when no such company can be identified, and cannot_verify when the website cannot be inspected.",
].join("\n");

/** A lowercased hostname; labels may be punycode (xn--), the top-level label included. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const RUN_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** The JSON body for POST /agent/runs. The query names only the domain, never provider text. */
export function buildResearchRequest(args: { domain: string }, effort: ResearchEffort): Record<string, unknown> {
  const domain = args.domain.trim().toLowerCase();
  if (!DOMAIN.test(domain)) throw new AdapterError("company research needs a registrable domain", "invalid", false);
  return {
    query: `Research the company whose website is https://${domain}/ and fill the output schema for it.`,
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    effort,
    outputSchema: RESEARCH_OUTPUT_SCHEMA,
    metadata: { domain },
  };
}

interface Grounding {
  field?: unknown;
  citations?: unknown;
  confidence?: unknown;
}

/**
 * True when a grounding entry's field names `field`: the same name, or a path into it. A leading
 * "$." or "/" is stripped first, so "funding_stage", "$.funding_stage", "/funding_stage",
 * "technologies[0]", "technologies.0" and "funding_stage/value" all match their field.
 */
export function groundsField(groundingField: unknown, field: string): boolean {
  if (typeof groundingField !== "string") return false;
  if (groundingField === field) return true;
  const path = groundingField.replace(/^\$\./, "").replace(/^\//, "");
  if (path === field) return true;
  return path.startsWith(field) && [".", "[", "/"].includes(path.charAt(field.length));
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The URL that grounds a field: the first http(s) citation of the first grounding entry for it whose
 * confidence is medium or high. A null or missing confidence does not count, so a field the provider
 * would not rate is not kept.
 */
export function citationFor(grounding: readonly Grounding[], field: string): string | undefined {
  for (const g of grounding) {
    if (!g || !groundsField(g.field, field)) continue;
    if (g.confidence !== "medium" && g.confidence !== "high") continue;
    const citations = Array.isArray(g.citations) ? (g.citations as Array<{ url?: unknown }>) : [];
    for (const c of citations) {
      const url = httpUrl(c?.url);
      if (url) return url;
    }
  }
  return undefined;
}

const shortText = (max: number) => (v: unknown): string | undefined => {
  const t = text(v);
  return t !== undefined && t.length <= max ? t : undefined;
};

/** Each field's validator: the value to keep, or undefined when it is not valid. */
function validators(now: Date): Record<ResearchField, (v: unknown) => unknown> {
  const year = now.getUTCFullYear();
  return {
    employee_range: shortText(40),
    employees_count: (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined),
    hq_country: (v) => (typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined),
    founded_year: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1800 && v <= year ? v : undefined),
    industry: shortText(80),
    sector: shortText(80),
    company_type: shortText(40),
    funding_stage: shortText(40),
    last_round_date: (v) => {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
      const t = Date.parse(`${v}T00:00:00.000Z`);
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v && t <= now.getTime() ? v : undefined;
    },
    raised_usd: (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined),
    technologies: (v) => {
      if (!Array.isArray(v)) return undefined;
      const kept = [...new Set(v.map(shortText(60)).filter((t): t is string => t !== undefined))].slice(0, 10);
      return kept.length > 0 ? kept : undefined;
    },
    hiring_functions: (v) => {
      if (!Array.isArray(v)) return undefined;
      const allowed = RESEARCH_HIRING_FUNCTIONS as readonly string[];
      const kept = [...new Set(v.filter((f): f is string => typeof f === "string" && allowed.includes(f)))].slice(0, 5);
      return kept.length > 0 ? kept : undefined;
    },
  };
}

const RESEARCH_FIELD_ORDER = Object.keys(RESEARCH_OUTPUT_SCHEMA.properties).filter((k) => k !== "verdict") as ResearchField[];
const FAILED_STOPS = new Set(["error", "cancelled"]);

function runCost(body: { costDollars?: { total?: unknown } }, effort: ResearchEffort): Cost {
  const reported = typeof body.costDollars?.total === "number" && Number.isFinite(body.costDollars.total) && body.costDollars.total >= 0 ? body.costDollars.total : undefined;
  return { provider: NAME, capability: "company_research", usd: reported ?? researchPrice(effort), units: 1 };
}

/** A reason code from the provider: its error code when it looks like one, else the fallback. */
function reasonCode(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code.toLowerCase() : fallback;
}

/**
 * Map an agent run to what core reads. Queued and running runs are pending; failed and cancelled
 * runs, and completed runs that stopped on an error, are failed; every other completed run is done,
 * with each field kept only when it is valid and grounded (citationFor), and every other non-null
 * field named in `dropped`.
 */
export function mapResearchRun(body: Record<string, unknown>, args: { effort: ResearchEffort; now: Date }): CompanyResearchRead {
  const status = body.status;
  if (status === "queued" || status === "running") return { status: "pending" };
  const cost = runCost(body, args.effort);
  const reported = (body as { costDollars?: { total?: unknown } }).costDollars?.total !== undefined;
  if (status === "failed" || status === "cancelled") return { status: "failed", reason: reasonCode(body.error, status), ...(reported ? { cost } : {}) };
  if (status !== "completed") return { status: "pending" };
  if (typeof body.stopReason === "string" && FAILED_STOPS.has(body.stopReason)) return { status: "failed", reason: reasonCode(body.error, body.stopReason), cost };

  const output = body.output && typeof body.output === "object" ? (body.output as { structured?: unknown; grounding?: unknown }) : {};
  const structured = output.structured && typeof output.structured === "object" && !Array.isArray(output.structured) ? (output.structured as Record<string, unknown>) : null;
  if (!structured) return { status: "done", record: null, dropped: [], cost };
  const grounding = Array.isArray(output.grounding) ? (output.grounding as Grounding[]) : [];
  const retrievedAt = (text(body.completedAt) && Number.isFinite(Date.parse(String(body.completedAt))) ? new Date(String(body.completedAt)) : args.now).toISOString();
  const check = validators(args.now);
  const attributes: Record<string, unknown> = {};
  const evidence: FieldEvidence[] = [];
  const dropped: ResearchField[] = [];
  for (const field of RESEARCH_FIELD_ORDER) {
    const raw = structured[field];
    if (raw === null || raw === undefined) continue;
    const value = check[field](raw);
    const url = value === undefined ? undefined : citationFor(grounding, field);
    if (value === undefined || url === undefined) {
      dropped.push(field);
      continue;
    }
    attributes[field] = value;
    evidence.push({ field, url, provider: NAME, retrievedAt });
  }
  const verdict = structured.verdict === "found" || structured.verdict === "not_found" ? structured.verdict : "cannot_verify";
  const metadata = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  const domain = typeof metadata.domain === "string" && DOMAIN.test(metadata.domain) ? metadata.domain : "";
  const str = (k: string) => {
    const v = attributes[k];
    return typeof v === "string" ? v : undefined;
  };
  const num = (k: string) => {
    const v = attributes[k];
    return typeof v === "number" ? v : undefined;
  };
  const record: CompanyResearchRecord = {
    name: domain,
    domain,
    ...(str("industry") ? { industry: str("industry") } : {}),
    ...(str("employee_range") ? { employeeRange: str("employee_range") } : {}),
    ...(num("founded_year") !== undefined ? { foundedYear: num("founded_year") } : {}),
    ...(str("hq_country") ? { location: str("hq_country") } : {}),
    ...(str("funding_stage") ? { fundingStage: str("funding_stage") } : {}),
    attributes,
    evidence,
    verdict,
    providerRef: text(body.id) ?? "",
  };
  return { status: "done", record, dropped, cost };
}

export type ExaAdapter = DiscoverySource & SimilarSource & NewsSource & CompanyResearchSource & {
  createWatch(q: DiscoveryQuery): Promise<WatchHandle>;
  pollWatch(handle: WatchHandle, since?: string): Promise<Page<Candidate>>;
  deleteWatch(handle: WatchHandle): Promise<void>;
};

export function createAdapter(ctx: AdapterContext): ExaAdapter {
  const options = readOptions(ctx.options);
  const call = async <T>(what: string, path: string, init: { method: string; body?: unknown }): Promise<T> => {
    const key = ctx.secret(SECRET);
    let response: Response;
    try {
      response = await ctx.fetch(`${options.baseUrl}${path}`, {
        method: init.method,
        headers: { "x-api-key": key, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AdapterError(timeout ? `Exa ${what} timed out` : `Exa ${what} could not be reached`, timeout ? "timeout" : "unavailable", true, { cause: error });
    }
    if (!response.ok) {
      discard(response);
      throw errorForStatus(response.status, response.headers.get("retry-after"));
    }
    if (init.method === "DELETE") {
      discard(response);
      return undefined as T;
    }
    try {
      return await response.json<T>();
    } catch (error) {
      throw new AdapterError(`Exa ${what} returned a body that is not JSON`, "unknown", true, { cause: error });
    }
  };
  const startCost = (): Cost => ({ provider: NAME, capability: "company_research", usd: researchPrice(options.researchEffort), units: 1 });
  const runPath = (id: string) => {
    if (!RUN_ID.test(id) || /^\.+$/.test(id)) throw new AdapterError("not an agent run id", "invalid", false);
    return `/agent/runs/${id}`;
  };
  const websetPath = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new AdapterError("not a webset id", "invalid", false);
    return `/websets/v0/websets/${id}`;
  };
  return {
    name: NAME,
    async search(q) {
      const body = await call<ExaResponse>("search", "/search", { method: "POST", body: buildSearchRequest(q, options) });
      return mapSearchResponse(body, q, ctx.now().toISOString(), options.highlightChars);
    },
    async createWatch(q) {
      const body = await call<{ id?: unknown; createdAt?: unknown }>("webset creation", "/websets/v0/websets", { method: "POST", body: buildWebsetRequest(q, options) });
      const id = text(body.id);
      if (!id) throw new AdapterError("Exa returned a webset without an id", "unknown", false);
      return { id, provider: NAME, createdAt: text(body.createdAt) ?? ctx.now().toISOString() };
    },
    async pollWatch(handle, since) {
      const items: WebsetItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ data?: unknown; hasMore?: unknown; nextCursor?: unknown }>("webset poll", `${websetPath(handle.id)}/items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { method: "GET" });
        if (Array.isArray(page.data)) items.push(...(page.data as WebsetItem[]));
        cursor = page.hasMore === true ? text(page.nextCursor) : undefined;
      } while (cursor && items.length < WEBSET_POLL_MAX);
      const mapped = mapWebsetItems(items.slice(0, WEBSET_POLL_MAX), since, ctx.now().toISOString());
      const emails = mapped.filter((m) => m.email).length;
      const credits = mapped.length * WEBSET_CREDITS.item + emails * WEBSET_CREDITS.email;
      return { items: mapped, cost: { provider: NAME, capability: "webset_items", credits, usd: credits * options.creditUsd, units: mapped.length } };
    },
    async deleteWatch(handle) {
      await call<void>("webset deletion", websetPath(handle.id), { method: "DELETE" });
    },
    async findSimilar(args) {
      const body = await call<ExaResponse>("find-similar", "/findSimilar", { method: "POST", body: buildSimilarRequest(args) });
      const page = mapSearchResponse(body, { kind: "account", text: args.url, limit: args.limit }, ctx.now().toISOString(), 0);
      const reported = typeof body.costDollars?.total === "number" && Number.isFinite(body.costDollars.total) ? body.costDollars.total : undefined;
      return { items: page.items.slice(0, args.limit), cost: { provider: NAME, capability: "find_similar", usd: reported ?? requestPrice(PRICES.findSimilar, Math.min(MAX_RESULTS, args.limit)), units: 1 } };
    },
    async searchNews(args) {
      const body = await call<{ results?: unknown; costDollars?: { total?: unknown } }>("news search", "/search", { method: "POST", body: buildNewsRequest(args, options) });
      return mapNewsResponse(body, args.limit);
    },
    async startCompanyResearch(args) {
      const request = buildResearchRequest(args, options.researchEffort);
      const body = await call<{ id?: unknown }>("company research", "/agent/runs", { method: "POST", body: request });
      const runId = text(body.id);
      if (!runId || !RUN_ID.test(runId)) throw new AdapterError("Exa returned an agent run without an id", "unknown", false);
      // A run bills when it finishes, so the start reserves the effort's fixed price.
      return { runId, cost: startCost() };
    },
    startCost,
    async readCompanyResearch(runId) {
      const body = await call<Record<string, unknown>>("company research", runPath(runId), { method: "GET" });
      return mapResearchRun(body && typeof body === "object" ? body : {}, { effort: options.researchEffort, now: ctx.now() });
    },
  };
}
