// GTM-agents: the Hunter adapter: a ContactFinder, an EmailVerifier and a PeopleProvider backed by
// Hunter's API (v2).
//
//   findWorkEmail  GET /email-finder   (domain, first_name, last_name)
//   verify         GET /email-verifier (email)
//   searchPeople   GET /domain-search  (domain, limit, offset, type=personal, seniority)
//   matchPerson    GET /email-finder   (domain, full_name)
//
// The adapter translates and decides nothing. Verification maps every vendor status onto exactly
// one of the four port statuses (VENDOR_STATUS_MAP); verification semantics, caching and the
// promotion policy are core's. Request building and response mapping are small separate functions,
// so a change in the vendor's API is corrected in one place. Every result carries its cost, in
// credits and in dollars at the configured price per credit.
//
// Options (gtm.config.ts, adapters["data-hunter"].options), all optional:
//   baseUrl        default https://api.hunter.io/v2
//   usdPerCredit   default 0.025 (set it to your plan's price per credit)
// Secret: HUNTER_API_KEY (wrangler secret put HUNTER_API_KEY), sent in the X-API-KEY header.
import {
  AdapterError,
  type AdapterContext,
  type AdapterErrorCode,
  type ContactFinder,
  type Cost,
  type EmailVerifier,
  type Evidence,
  type PeopleProvider,
  type PersonRecord,
  type VerificationStatus,
} from "@gtm-agents/core/ports";

/** Release a response body we will not read. Not awaited: a cancelled stream need not settle first. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

export const NAME = "data-hunter";
export const SECRET = "HUNTER_API_KEY";
/** Credits per call, from manifest.json. */
export const CREDITS = Object.freeze({ find: 1, verify: 0.5, peopleSearchPerTen: 1 });
export const DEFAULT_USD_PER_CREDIT = 0.025;

/**
 * Every status the verifier can return, and the one port status it maps to. `accept_all` and
 * `webmail` servers cannot confirm a mailbox, so they are risky; `disposable` addresses are
 * undeliverable for our purposes.
 */
export const VENDOR_STATUS_MAP: Readonly<Record<string, VerificationStatus>> = Object.freeze({
  valid: "deliverable",
  invalid: "undeliverable",
  disposable: "undeliverable",
  accept_all: "risky",
  webmail: "risky",
  unknown: "unknown",
});

/** The older `result` field, used only when `status` is missing. */
const LEGACY_RESULT_MAP: Readonly<Record<string, VerificationStatus>> = Object.freeze({
  deliverable: "deliverable",
  undeliverable: "undeliverable",
  risky: "risky",
});

/** Map a vendor status (or legacy result) to a port status. Anything unrecognized is unknown. */
export function mapVendorStatus(status: unknown, result?: unknown): VerificationStatus {
  if (typeof status === "string" && Object.hasOwn(VENDOR_STATUS_MAP, status)) return VENDOR_STATUS_MAP[status] as VerificationStatus;
  if (typeof result === "string" && Object.hasOwn(LEGACY_RESULT_MAP, result)) return LEGACY_RESULT_MAP[result] as VerificationStatus;
  return "unknown";
}

interface HunterOptions {
  baseUrl: string;
  usdPerCredit: number;
}

function readOptions(raw: Record<string, unknown>): HunterOptions {
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? raw.baseUrl.replace(/\/+$/, "") : "https://api.hunter.io/v2";
  const usd = typeof raw.usdPerCredit === "number" && Number.isFinite(raw.usdPerCredit) && raw.usdPerCredit >= 0 ? raw.usdPerCredit : DEFAULT_USD_PER_CREDIT;
  return { baseUrl, usdPerCredit: usd };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
const score = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined);

export function costOf(capability: "email_find" | "email_verify" | "people_search", credits: number, options: HunterOptions): Cost {
  return { provider: NAME, capability, credits, usd: Math.round(credits * options.usdPerCredit * 1_000_000) / 1_000_000, units: credits > 0 ? 1 : 0 };
}

/** The AdapterError for a failed HTTP response. Hunter uses 403 for its rate limit and 429 for the plan quota. */
export function errorForStatus(status: number, endpoint: string): AdapterError {
  const table: Record<number, [AdapterErrorCode, boolean]> = {
    400: ["invalid", false],
    401: ["auth", false],
    403: ["rate_limited", true],
    404: ["not_found", false],
    422: ["invalid", false],
    429: ["quota", false],
  };
  const [code, retryable] = table[status] ?? (status >= 500 ? ["unavailable", true] : ["unknown", false]);
  return new AdapterError(`Hunter ${endpoint} returned HTTP ${status}`, code, retryable, code === "rate_limited" ? { retryAfterMs: 1000 } : {});
}

function sourcesOf(raw: unknown, retrievedAt: string): Evidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).flatMap((s: { uri?: unknown; domain?: unknown }) => {
    const uri = text(s?.uri);
    return uri ? [{ url: uri, provider: NAME, retrievedAt }] : [];
  });
}

async function refFor(domain: string, email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${domain.toLowerCase()}:${email.toLowerCase()}`));
  return `hunter:${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const SENIORITY: Readonly<Record<string, string>> = Object.freeze({
  c_level: "executive",
  vp: "executive",
  head: "executive",
  director: "executive",
  manager: "senior",
  lead: "senior",
  senior: "senior",
  individual: "junior",
});

/** Query parameters for GET /domain-search. */
export function buildPeopleSearchParams(domain: string, limit: number, offset: number, seniority: readonly string[] | undefined): Record<string, string> {
  const params: Record<string, string> = { domain, limit: String(Math.max(1, Math.min(100, Math.floor(limit)))), offset: String(Math.max(0, offset)), type: "personal" };
  const levels = [...new Set((seniority ?? []).map((s) => SENIORITY[s]).filter((s): s is string => s !== undefined))];
  if (levels.length > 0) params.seniority = levels.join(",");
  return params;
}

interface DomainSearchEmail {
  value?: unknown;
  type?: unknown;
  confidence?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  position?: unknown;
  seniority?: unknown;
  department?: unknown;
  linkedin?: unknown;
  sources?: unknown;
}

/** Map a /domain-search body to person records. Only personal (not generic) addresses with a name are kept. */
export async function mapPeopleSearch(body: { data?: { domain?: unknown; organization?: unknown; emails?: unknown }; meta?: { results?: unknown } }, domain: string, offset: number, limit: number, retrievedAt: string) {
  const emails = Array.isArray(body.data?.emails) ? (body.data.emails as DomainSearchEmail[]) : [];
  const organization = text(body.data?.organization);
  const accountDomain = text(body.data?.domain) ?? domain;
  const items: PersonRecord[] = [];
  for (const e of emails) {
    const email = text(e.value);
    if (!email || e.type !== "personal") continue;
    const firstName = text(e.first_name);
    const lastName = text(e.last_name);
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (!fullName) continue;
    const confidence = score(e.confidence);
    const linkedin = text(e.linkedin);
    items.push({
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      fullName,
      ...(text(e.position) ? { title: text(e.position) } : {}),
      ...(text(e.seniority) ? { seniority: text(e.seniority) } : {}),
      ...(organization ? { accountName: organization } : {}),
      accountDomain,
      ...(linkedin && /^https:\/\//.test(linkedin) ? { profileUrl: linkedin } : {}),
      email,
      attributes: { ...(confidence !== undefined ? { confidence } : {}), ...(text(e.department) ? { department: text(e.department) } : {}) },
      evidence: sourcesOf(e.sources, retrievedAt),
      providerRef: await refFor(accountDomain, email),
    });
  }
  const total = typeof body.meta?.results === "number" ? body.meta.results : undefined;
  const next = total !== undefined && offset + limit < total ? String(offset + limit) : undefined;
  return { items, returned: emails.length, ...(next ? { cursor: next } : {}) };
}

export function createAdapter(ctx: AdapterContext): ContactFinder & EmailVerifier & PeopleProvider {
  const options = readOptions(ctx.options);

  async function get(endpoint: string, params: Record<string, string>): Promise<Response> {
    const key = ctx.secret(SECRET);
    const url = new URL(`${options.baseUrl}${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      return await ctx.fetch(url.toString(), { method: "GET", headers: { "x-api-key": key, accept: "application/json" } });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AdapterError(timeout ? `Hunter ${endpoint} timed out` : `Hunter ${endpoint} could not be reached`, timeout ? "timeout" : "unavailable", true, { cause: error });
    }
  }

  async function json<T>(response: Response, endpoint: string): Promise<T> {
    try {
      return await response.json<T>();
    } catch (error) {
      throw new AdapterError(`Hunter ${endpoint} returned a body that is not JSON`, "unknown", true, { cause: error });
    }
  }

  function drainAndFail(response: Response, endpoint: string): never {
    discard(response);
    throw errorForStatus(response.status, endpoint);
  }

  async function finder(params: Record<string, string>) {
    const response = await get("/email-finder", params);
    // 404: nothing known for this person; 451: the person asked Hunter not to process their data.
    if (response.status === 404 || response.status === 451) {
      discard(response);
      return null;
    }
    if (!response.ok) return drainAndFail(response, "/email-finder");
    const body = await json<{ data?: Record<string, unknown> }>(response, "/email-finder");
    return body.data ?? null;
  }

  return {
    name: NAME,

    async findWorkEmail(args) {
      const data = await finder({ domain: args.domain, first_name: args.firstName, last_name: args.lastName });
      const email = text(data?.email);
      if (!data || !email) return { email: null, cost: costOf("email_find", 0, options) };
      return {
        email,
        confidence: score(data.score) ?? 0,
        sources: sourcesOf(data.sources, ctx.now().toISOString()),
        cost: costOf("email_find", CREDITS.find, options),
      };
    },

    async verify(email) {
      const response = await get("/email-verifier", { email });
      if (response.status === 202) {
        discard(response);
        throw new AdapterError("Hunter is still verifying this address; call again later", "unavailable", true, { retryAfterMs: 30_000 });
      }
      if (response.status === 222) {
        // The remote mail server answered unexpectedly. The verification is complete but inconclusive.
        discard(response);
        return { status: "unknown", reason: "smtp_unexpected_response", cost: costOf("email_verify", CREDITS.verify, options) };
      }
      if (response.status === 451) {
        discard(response);
        return { status: "unknown", reason: "processing_refused", cost: costOf("email_verify", 0, options) };
      }
      if (!response.ok) return drainAndFail(response, "/email-verifier");
      const body = await json<{ data?: Record<string, unknown> }>(response, "/email-verifier");
      const data = body.data ?? {};
      const vendor = text(data.status) ?? text(data.result) ?? "unknown";
      const s = score(data.score);
      return {
        status: mapVendorStatus(data.status, data.result),
        ...(s !== undefined ? { score: s } : {}),
        reason: vendor,
        ...(typeof data.accept_all === "boolean" ? { acceptAll: data.accept_all } : {}),
        ...(typeof data.disposable === "boolean" ? { disposable: data.disposable } : {}),
        cost: costOf("email_verify", CREDITS.verify, options),
      };
    },

    async searchPeople(filters, cursor) {
      // One domain per request; further domains are ignored.
      const domain = text(filters.accountDomains?.[0]);
      if (!domain) return { items: [], cost: costOf("people_search", 0, options) };
      const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
      const params = buildPeopleSearchParams(domain, filters.limit, offset, filters.seniority);
      const response = await get("/domain-search", params);
      if (!response.ok) return drainAndFail(response, "/domain-search");
      const body = await json<Parameters<typeof mapPeopleSearch>[0]>(response, "/domain-search");
      const mapped = await mapPeopleSearch(body, domain, offset, Number(params.limit), ctx.now().toISOString());
      const credits = Math.ceil(mapped.returned / 10) * CREDITS.peopleSearchPerTen;
      return { items: mapped.items, ...(mapped.cursor ? { cursor: mapped.cursor } : {}), cost: costOf("people_search", credits, options) };
    },

    async matchPerson(identity) {
      const fullName = text(identity.fullName);
      const domain = text(identity.accountDomain);
      if (!fullName || !domain) return { record: null };
      const data = await finder({ domain, full_name: fullName });
      const email = text(data?.email);
      if (!data || !email) return { record: null, cost: costOf("email_find", 0, options) };
      const firstName = text(data.first_name);
      const lastName = text(data.last_name);
      const confidence = score(data.score);
      const linkedin = text(data.linkedin_url);
      const record: PersonRecord = {
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        fullName: [firstName, lastName].filter(Boolean).join(" ") || fullName,
        ...(text(data.position) ? { title: text(data.position) } : {}),
        ...(text(data.company) ? { accountName: text(data.company) } : {}),
        accountDomain: text(data.domain) ?? domain,
        ...(linkedin && /^https:\/\//.test(linkedin) ? { profileUrl: linkedin } : {}),
        email,
        attributes: confidence !== undefined ? { confidence } : {},
        evidence: sourcesOf(data.sources, ctx.now().toISOString()),
        providerRef: await refFor(domain, email),
      };
      return { record, cost: costOf("email_find", CREDITS.find, options) };
    },
  };
}
