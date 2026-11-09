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
//                 HMAC-SHA256 of "<t>.<raw body>" with the monitor's secret).
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
// Secret: EXA_API_KEY (wrangler secret put EXA_API_KEY). Each monitor's signing secret is its own
// Worker secret, named in the deployment's monitor config.
import { AdapterError, type AdapterContext, type AdapterErrorCode, type Candidate, type Cost, type DiscoveryQuery, type DiscoverySource, type Page, type WatchHandle } from "@gtm-agents/core/ports";
import type { MonitorHit, NewsHit, NewsSource, SimilarSource, WebsetCandidate } from "@gtm-agents/core/signals";

/** Release a response body we will not read. Not awaited: a cancelled stream need not settle first. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

export const NAME = "data-exa";
export const SECRET = "EXA_API_KEY";
/** Prices from manifest.json, used when a response does not report its own cost. */
export const PRICES = Object.freeze({ search: 0.005, searchLarge: 0.025, highlightsPerResult: 0.001, findSimilar: 0.005, news: 0.005 });
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
  const estimate = (q.limit > 25 ? PRICES.searchLarge : PRICES.search) + (highlightChars > 0 ? results.length * PRICES.highlightsPerResult : 0);
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
  return { items, cost: { provider: NAME, capability: "news", usd: reported ?? PRICES.news, units: 1 } };
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

export type ExaAdapter = DiscoverySource & SimilarSource & NewsSource & {
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
      return { items: page.items.slice(0, args.limit), cost: { provider: NAME, capability: "find_similar", usd: reported ?? PRICES.findSimilar, units: 1 } };
    },
    async searchNews(args) {
      const body = await call<{ results?: unknown; costDollars?: { total?: unknown } }>("news search", "/search", { method: "POST", body: buildNewsRequest(args, options) });
      return mapNewsResponse(body, args.limit);
    },
  };
}
