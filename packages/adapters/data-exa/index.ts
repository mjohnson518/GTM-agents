// GTM-agents: the Exa adapter: a DiscoverySource backed by Exa's search API.
//
// It implements `search` only; the optional `research` and `watch` capabilities are not offered,
// and the manifest declares no capabilities. Requests and responses are translated in two small,
// separate functions (buildSearchRequest, mapSearchResponse), so a change in the vendor's API is
// corrected in one place. The adapter makes no decisions: it does not sanitize, deduplicate or
// filter results, and it does not judge which domain is a company. Core does all of that.
//
// Options (gtm.config.ts, adapters["data-exa"].options), all optional:
//   baseUrl          default https://api.exa.ai
//   searchType       default "auto"
//   accountCategory  default "company"   (the category used for account searches)
//   personCategory   default "people"    (the category used for person searches)
//   highlightChars   default 400         (characters of highlights per result; 0 requests none)
// Secret: EXA_API_KEY (wrangler secret put EXA_API_KEY).
import { AdapterError, type AdapterContext, type AdapterErrorCode, type Candidate, type Cost, type DiscoveryQuery, type DiscoverySource, type Page } from "@gtm-agents/core/ports";

/** Release a response body we will not read. Not awaited: a cancelled stream need not settle first. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

export const NAME = "data-exa";
export const SECRET = "EXA_API_KEY";
/** Prices from manifest.json, used when a response does not report its own cost. */
export const PRICES = Object.freeze({ search: 0.005, searchLarge: 0.025, highlightsPerResult: 0.001 });
const MAX_RESULTS = 100;

interface ExaOptions {
  baseUrl: string;
  searchType: string;
  accountCategory: string;
  personCategory: string;
  highlightChars: number;
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

export function createAdapter(ctx: AdapterContext): DiscoverySource {
  const options = readOptions(ctx.options);
  return {
    name: NAME,
    async search(q) {
      const key = ctx.secret(SECRET);
      let response: Response;
      try {
        response = await ctx.fetch(`${options.baseUrl}/search`, {
          method: "POST",
          headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(buildSearchRequest(q, options)),
        });
      } catch (error) {
        const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AdapterError(timeout ? "Exa search timed out" : "Exa search could not be reached", timeout ? "timeout" : "unavailable", true, { cause: error });
      }
      if (!response.ok) {
        discard(response);
        throw errorForStatus(response.status, response.headers.get("retry-after"));
      }
      let body: ExaResponse;
      try {
        body = await response.json<ExaResponse>();
      } catch (error) {
        throw new AdapterError("Exa search returned a body that is not JSON", "unknown", true, { cause: error });
      }
      return mapSearchResponse(body, q, ctx.now().toISOString(), options.highlightChars);
    },
  };
}
