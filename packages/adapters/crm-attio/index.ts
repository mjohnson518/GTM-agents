// GTM-agents: the Attio adapter: a CrmSink backed by Attio's REST API (v2). See docs/CRM.md.
//
//   upsertAccount  PUT  /objects/companies/records?matching_attribute=domains
//   upsertContact  PUT  /objects/people/records?matching_attribute=email_addresses
//   logActivity    POST /notes  (a plain-text note on the person, dated when the activity happened)
//
// An upsert matches on the domain or the address. Attio keeps the values a record already holds in
// the attribute it matches on, so a teammate's extra addresses or domains on a record survive. Name,
// job title and company are written as core holds them. The adapter translates and decides nothing:
// what is mirrored, and when, is core's (packages/core/src/crm).
//
// A 429 is retried once after its Retry-After (at most RETRY_MAX_MS); anything else that fails throws
// an AdapterError, and the mirror keeps its cursor. Notes have no idempotency key in Attio: core
// claims each note in its effects ledger before writing it.
//
// Options (gtm.config.ts, adapters["crm-attio"].options), all optional:
//   baseUrl   default https://api.attio.com/v2
// Secret: ATTIO_API_KEY (wrangler secret put ATTIO_API_KEY), an access token with the scopes
// record_permission:read-write, object_configuration:read and note:read-write.
import { AdapterError, type AdapterContext, type AdapterErrorCode, type CrmSink } from "@gtm-agents/core/ports";

export const NAME = "crm-attio";
export const SECRET = "ATTIO_API_KEY";
export const DEFAULT_BASE_URL = "https://api.attio.com/v2";
/** The longest the adapter waits on a Retry-After before its one retry. */
export const RETRY_MAX_MS = 10_000;

const NOTE_TITLES: Readonly<Record<"email_sent" | "reply" | "meeting" | "note", string>> = Object.freeze({
  email_sent: "Email sent",
  reply: "Reply received",
  meeting: "Meeting",
  note: "Update",
});

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

function readOptions(raw: Record<string, unknown>): { baseUrl: string } {
  return { baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? raw.baseUrl.replace(/\/+$/, "") : DEFAULT_BASE_URL };
}

/** The AdapterError for a failed HTTP response. */
export function errorForStatus(status: number, endpoint: string): AdapterError {
  const table: Record<number, [AdapterErrorCode, boolean]> = {
    400: ["invalid", false],
    401: ["auth", false],
    403: ["auth", false],
    404: ["not_found", false],
    409: ["invalid", false],
    422: ["invalid", false],
    429: ["rate_limited", true],
  };
  const [code, retryable] = table[status] ?? (status >= 500 ? ["unavailable", true] : ["unknown", false]);
  return new AdapterError(`Attio ${endpoint} returned HTTP ${status}`, code, retryable, code === "rate_limited" ? { retryAfterMs: 1000 } : {});
}

/** Milliseconds to wait from a Retry-After header (seconds or an HTTP date), capped at RETRY_MAX_MS. */
export function retryAfterMs(header: string | null, now: Date): number {
  if (!header) return 1000;
  const trimmed = header.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now.getTime();
  if (!Number.isFinite(seconds)) return 1000;
  return Math.max(0, Math.min(RETRY_MAX_MS, seconds));
}

/** The person's values: the address it matches on, then name, job title and company when known. */
export function personValues(contact: Parameters<CrmSink["upsertContact"]>[0]): Record<string, unknown> {
  if (!contact.email) throw new AdapterError("Attio people are matched on their address; this contact has none", "invalid", false);
  const first = contact.firstName ?? "";
  const last = contact.lastName ?? "";
  const full = `${first} ${last}`.trim();
  return {
    email_addresses: [{ email_address: contact.email }],
    ...(full ? { name: [{ first_name: first, last_name: last, full_name: full }] } : {}),
    ...(contact.title ? { job_title: contact.title } : {}),
    ...(contact.accountExternalId ? { company: [{ target_object: "companies", target_record_id: contact.accountExternalId }] } : {}),
  };
}

export function companyValues(account: Parameters<CrmSink["upsertAccount"]>[0]): Record<string, unknown> {
  return { domains: [{ domain: account.domain }], name: account.name };
}

export function createAdapter(ctx: AdapterContext): CrmSink {
  const options = readOptions(ctx.options);

  async function send(method: "PUT" | "POST", path: string, body: unknown, endpoint: string): Promise<Response> {
    const key = ctx.secret(SECRET);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await ctx.fetch(`${options.baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AdapterError(timeout ? `Attio ${endpoint} timed out` : `Attio ${endpoint} could not be reached`, timeout ? "timeout" : "unavailable", true, { cause: error });
      }
      if (response.ok) return response;
      discard(response);
      if (response.status === 429 && attempt === 0) {
        const wait = retryAfterMs(response.headers.get("retry-after"), ctx.now());
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      throw errorForStatus(response.status, endpoint);
    }
  }

  async function recordId(response: Response, endpoint: string): Promise<string> {
    let body: { data?: { id?: { record_id?: unknown } } };
    try {
      body = await response.json();
    } catch (error) {
      throw new AdapterError(`Attio ${endpoint} returned a body that is not JSON`, "unknown", true, { cause: error });
    }
    const id = body.data?.id?.record_id;
    if (typeof id !== "string" || id.length === 0) throw new AdapterError(`Attio ${endpoint} returned no record id`, "unknown", false);
    return id;
  }

  return {
    name: NAME,
    async upsertAccount(account) {
      const endpoint = "companies upsert";
      const response = await send("PUT", "/objects/companies/records?matching_attribute=domains", { data: { values: companyValues(account) } }, endpoint);
      return { externalId: await recordId(response, endpoint) };
    },
    async upsertContact(contact) {
      const endpoint = "people upsert";
      const response = await send("PUT", "/objects/people/records?matching_attribute=email_addresses", { data: { values: personValues(contact) } }, endpoint);
      return { externalId: await recordId(response, endpoint) };
    },
    async logActivity(activity) {
      const response = await send(
        "POST",
        "/notes",
        {
          data: {
            parent_object: "people",
            parent_record_id: activity.contactId,
            title: NOTE_TITLES[activity.type],
            format: "plaintext",
            content: activity.summary,
            created_at: activity.at,
          },
        },
        "notes create",
      );
      discard(response);
    },
  };
}
