// GTM-agents: the LeadMagic adapter: a ContactFinder, an EmailVerifier and an EmploymentChecker
// backed by LeadMagic's API (v1).
//
//   findWorkEmail         POST /v1/people/email-finder         (first_name, last_name, domain, profile_url)
//   verify                POST /v1/people/email-validation     (email)
//   checkEmployment       POST /v1/people/job-change-detector  (profile_url, company_domain, company_name)
//   findCurrentWorkEmail  POST /v1/people/email-finder         (profile_url and names, no domain)
//
// The adapter translates and decides nothing. LeadMagic's finder charges only for a valid address
// and returns a free not-found for an address on an unrelated domain, so it suits a second waterfall
// step. Its validation has three statuses: valid, invalid and unknown. Accept-all domains come back
// unknown, so this verifier never returns risky and the allow_risky promotion policy has no effect
// with it. The job change detector costs 3 credits a check, and nothing when the profile is not
// found. Every result carries its cost: the credits LeadMagic reports, at the configured price per
// credit. Request building and response mapping are small separate functions, so a change in the
// vendor's API is corrected in one place.
//
// Options (gtm.config.ts, adapters["data-leadmagic"].options), all optional:
//   baseUrl        default https://api.leadmagic.io
//   usdPerCredit   default 0.0198 (set it to your plan's price per credit)
// Secret: LEADMAGIC_API_KEY (wrangler secret put LEADMAGIC_API_KEY), sent in the X-API-Key header.
import {
  AdapterError,
  type AdapterContext,
  type AdapterErrorCode,
  type ContactFinder,
  type Cost,
  type EmailVerifier,
  type EmploymentChecker,
  type EmploymentStatus,
  type VerificationStatus,
} from "@gtm-agents/core/ports";

export const NAME = "data-leadmagic";
export const SECRET_NAME = "LEADMAGIC_API_KEY";
export const DEFAULT_BASE_URL = "https://api.leadmagic.io";
/** The Essential plan's price per credit, the highest of the published plans. */
export const DEFAULT_USD_PER_CREDIT = 0.0198;
/** Credits per call when the vendor does not say, from manifest.json. */
export const CREDITS = Object.freeze({ find: 1, verify: 0.25, jobChange: 3 });
/** The confidence given to a found address: LeadMagic returns one only after its own live validation. */
export const FOUND_CONFIDENCE = 90;

/** Every validation status, and the one port status it maps to. Anything else is unknown. */
export const VENDOR_STATUS_MAP: Readonly<Record<string, VerificationStatus>> = Object.freeze({
  valid: "deliverable",
  invalid: "undeliverable",
  unknown: "unknown",
});

/** Every job change status, and the port status it maps to. Anything else is unknown. */
export const JOB_STATUS_MAP: Readonly<Record<string, EmploymentStatus>> = Object.freeze({
  NO_CHANGE: "current",
  JOB_CHANGE_DETECTED: "moved",
  NEVER_WORKED_THERE: "never_worked_there",
  AMBIGUOUS_CURRENT_EMPLOYMENT: "ambiguous",
  CURRENT_EMPLOYMENT_UNKNOWN: "unknown",
  PROFILE_NOT_FOUND: "profile_not_found",
});

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

interface LeadMagicOptions {
  baseUrl: string;
  usdPerCredit: number;
}

function readOptions(raw: Record<string, unknown>): LeadMagicOptions {
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? raw.baseUrl.replace(/\/+$/, "") : DEFAULT_BASE_URL;
  const usd = typeof raw.usdPerCredit === "number" && Number.isFinite(raw.usdPerCredit) && raw.usdPerCredit >= 0 ? raw.usdPerCredit : DEFAULT_USD_PER_CREDIT;
  return { baseUrl, usdPerCredit: usd };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

/** The credits a response reports, or `fallback` when it reports none. */
function creditsOf(body: { credits_consumed?: unknown }, fallback: number): number {
  return typeof body.credits_consumed === "number" && Number.isFinite(body.credits_consumed) && body.credits_consumed >= 0 ? body.credits_consumed : fallback;
}

export function costOf(capability: "email_find" | "email_verify" | "job_change", credits: number, options: LeadMagicOptions): Cost {
  return { provider: NAME, capability, credits, usd: Math.round(credits * options.usdPerCredit * 1_000_000) / 1_000_000, units: credits > 0 ? 1 : 0 };
}

/** Map a validation status to a port status. */
export function mapVendorStatus(status: unknown): VerificationStatus {
  return typeof status === "string" && Object.hasOwn(VENDOR_STATUS_MAP, status) ? (VENDOR_STATUS_MAP[status] as VerificationStatus) : "unknown";
}

/** Map a job change status to a port status. */
export function mapJobStatus(status: unknown): EmploymentStatus {
  return typeof status === "string" && Object.hasOwn(JOB_STATUS_MAP, status) ? (JOB_STATUS_MAP[status] as EmploymentStatus) : "unknown";
}

/** The AdapterError for a failed HTTP response. 402 means the account is out of credits. */
export function errorForStatus(status: number, endpoint: string, retryAfter: string | null = null): AdapterError {
  const table: Record<number, [AdapterErrorCode, boolean]> = {
    400: ["invalid", false],
    401: ["auth", false],
    402: ["quota", false],
    403: ["auth", false],
    404: ["not_found", false],
    422: ["invalid", false],
    429: ["rate_limited", true],
  };
  const [code, retryable] = table[status] ?? (status >= 500 ? ["unavailable", true] : ["unknown", false]);
  const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : 1000;
  return new AdapterError(`LeadMagic ${endpoint} returned HTTP ${status}`, code, retryable, code === "rate_limited" ? { retryAfterMs: seconds } : {});
}

/** The domain of an address, lowercased, or undefined. */
function domainOf(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : undefined;
}

/** A start date as ISO 8601, when it parses. LeadMagic gives a date such as 2026-09-01. */
function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function createAdapter(ctx: AdapterContext): ContactFinder & EmailVerifier & EmploymentChecker {
  const options = readOptions(ctx.options);

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    const key = ctx.secret(SECRET_NAME);
    try {
      return await ctx.fetch(`${options.baseUrl}${path}`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AdapterError(timeout ? `LeadMagic ${path} timed out` : `LeadMagic ${path} could not be reached`, timeout ? "timeout" : "unavailable", true, { cause: error });
    }
  }

  async function json<T>(response: Response, path: string): Promise<T> {
    try {
      return await response.json<T>();
    } catch (error) {
      throw new AdapterError(`LeadMagic ${path} returned a body that is not JSON`, "unknown", true, { cause: error });
    }
  }

  function fail(response: Response, path: string): never {
    discard(response);
    throw errorForStatus(response.status, path, response.headers.get("retry-after"));
  }

  type FinderBody = { status?: unknown; email?: unknown; domain?: unknown; company_name?: unknown; domain_mismatch?: unknown; credits_consumed?: unknown };

  /** The finder's answer: an address it validated, or null. */
  async function finder(body: Record<string, unknown>): Promise<{ found: FinderBody & { email: string }; credits: number } | { found: null; credits: number }> {
    const path = "/v1/people/email-finder";
    const response = await post(path, body);
    if (!response.ok) return fail(response, path);
    const data = await json<FinderBody>(response, path);
    const email = text(data.email);
    const credits = creditsOf(data, email && data.status === "valid" && data.domain_mismatch !== true ? CREDITS.find : 0);
    if (!email || data.status !== "valid" || data.domain_mismatch === true) return { found: null, credits };
    return { found: { ...data, email }, credits };
  }

  return {
    name: NAME,

    async findWorkEmail(args) {
      const { found, credits } = await finder({
        first_name: args.firstName,
        last_name: args.lastName,
        domain: args.domain,
        ...(args.profileUrl ? { profile_url: args.profileUrl } : {}),
      });
      if (!found) return { email: null, cost: costOf("email_find", credits, options) };
      return { email: found.email, confidence: FOUND_CONFIDENCE, sources: [], cost: costOf("email_find", credits, options) };
    },

    async verify(email) {
      const path = "/v1/people/email-validation";
      const response = await post(path, { email });
      if (!response.ok) return fail(response, path);
      const data = await json<{ email_status?: unknown; credits_consumed?: unknown }>(response, path);
      const status = mapVendorStatus(data.email_status);
      return {
        status,
        reason: text(data.email_status) ?? "unknown",
        cost: costOf("email_verify", creditsOf(data, status === "unknown" ? 0 : CREDITS.verify), options),
      };
    },

    async checkEmployment(args) {
      const path = "/v1/people/job-change-detector";
      const response = await post(path, {
        profile_url: args.profileUrl,
        company_domain: args.companyDomain,
        ...(args.companyName ? { company_name: args.companyName } : {}),
      });
      // A 404 is a missing profile only when the body says so; any other 404 (a wrong baseUrl or
      // path) is an error, not a free "unknown" for every contact.
      if (response.status === 404) {
        const body = await response.json<{ errors?: Array<{ code?: unknown }> }>().catch(() => null);
        if (body?.errors?.some((e) => e.code === "profile_not_found")) return { status: "profile_not_found", cost: costOf("job_change", 0, options) };
        throw errorForStatus(404, path);
      }
      if (!response.ok) return fail(response, path);
      const data = await json<{ status?: unknown; credits_consumed?: unknown; current_position?: { title?: unknown; start_date?: unknown } | null }>(response, path);
      const status = mapJobStatus(data.status);
      const startedAt = status === "current" ? isoDate(data.current_position?.start_date) : undefined;
      const title = text(data.current_position?.title);
      return {
        status,
        ...(startedAt ? { roleStartedAt: startedAt } : {}),
        ...(title ? { title } : {}),
        cost: costOf("job_change", creditsOf(data, status === "profile_not_found" ? 0 : CREDITS.jobChange), options),
      };
    },

    async findCurrentWorkEmail(args) {
      const { found, credits } = await finder({
        profile_url: args.profileUrl,
        ...(args.firstName ? { first_name: args.firstName } : {}),
        ...(args.lastName ? { last_name: args.lastName } : {}),
      });
      const domain = found ? (text(found.domain)?.toLowerCase() ?? domainOf(found.email)) : undefined;
      if (!found || !domain) return { email: null, cost: costOf("email_find", credits, options) };
      const companyName = text(found.company_name);
      return {
        email: found.email,
        domain,
        ...(companyName ? { companyName } : {}),
        sources: [{ url: args.profileUrl, provider: NAME, retrievedAt: ctx.now().toISOString() }],
        cost: costOf("email_find", credits, options),
      };
    },
  };
}
