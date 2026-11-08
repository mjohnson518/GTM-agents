// GTM-agents: the email-resend adapter: the EmailProvider port over the Resend API.
//
// It translates and decides nothing. Suppression, windows, caps, the kill switch, retries and the
// circuit breaker all run in core before sendBatch is called. Specifically:
//   - sendBatch posts to the batch endpoint (up to 100 messages per request) through ctx.fetch, as
//     plain text only: there is no html field, so nothing can carry a tracking pixel, and nothing
//     asks the vendor to rewrite links. Headers (List-Unsubscribe, List-Unsubscribe-Post,
//     In-Reply-To, References) and tags pass through as core built them; a tag the vendor would
//     reject (outside A-Z a-z 0-9 _ -, or over 256 characters) is left out rather than altered;
//   - the batch endpoint takes one Idempotency-Key per request, so the key is a SHA-256 over the
//     batch's sorted effect keys: a byte-identical retry of the same batch inside the vendor's
//     24-hour window is not sent again. Core's effects ledger is the real exactly-once guard;
//   - a batch is accepted or refused whole, so every message in it gets the same outcome when the
//     vendor refuses. Codes say what core needs to know: invalid, auth and not_found (refused, not
//     sent), rate_limited, quota and unavailable (refused for now), and timeout or unknown when the
//     batch may have been accepted (a dropped connection, a 500, an idempotency conflict);
//   - parseWebhook verifies the Svix-style signature first: HMAC-SHA256 over
//     "{id}.{timestamp}.{body}" with the base64 key after "whsec_", a timestamp within 5 minutes of
//     now, and a constant-time compare against every "v1," signature in the header. Only then is
//     the body parsed. Delivered, bounced, complained and failed events map to the port's events;
//     a provider-side suppression is reported as a hard bounce; opens and clicks are passed on as
//     such and core ignores them. A bounce is soft only when the vendor says so (Temporary,
//     Transient or Soft); a missing or other type counts as hard;
//   - every send result carries its cost, from the manifest's price per email.
//
// Secrets: RESEND_API_KEY (sending), RESEND_WEBHOOK_SECRET (verifying webhooks).
// Options (adapters.email-resend.options):
//   apiBaseUrl   defaults to https://api.resend.com
//   usdPerEmail  defaults to 0.0004 (set it to your plan's price)
import { constantTimeEqual } from "@gtm-agents/core/http";
import { AdapterError, type AdapterContext, type AdapterErrorCode, type Cost, type EmailEvent, type EmailProvider, type OutboundMessage, type SendOutcome } from "@gtm-agents/core/ports";

export const NAME = "email-resend";
export const RESEND_API = "https://api.resend.com";
export const API_KEY_NAME = "RESEND_API_KEY";
export const WEBHOOK_SECRET_NAME = "RESEND_WEBHOOK_SECRET";
/** The batch endpoint's limit, as in manifest.json limits.batchSize. */
export const BATCH_LIMIT = 100;
/** The manifest's price per email. */
export const DEFAULT_USD_PER_EMAIL = 0.0004;
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_BYTES = 100 * 1024;

const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const SOFT_BOUNCES: ReadonlySet<string> = new Set(["temporary", "transient", "soft"]);
const encoder = new TextEncoder();

interface ResendOptions {
  baseUrl: string;
  usdPerEmail: number;
}

function readOptions(raw: Record<string, unknown>): ResendOptions {
  const base = typeof raw.apiBaseUrl === "string" && /^https:\/\/[^/\s]+/.test(raw.apiBaseUrl) ? raw.apiBaseUrl.replace(/\/+$/, "") : RESEND_API;
  const usd = typeof raw.usdPerEmail === "number" && Number.isFinite(raw.usdPerEmail) && raw.usdPerEmail >= 0 ? raw.usdPerEmail : DEFAULT_USD_PER_EMAIL;
  return { baseUrl: base, usdPerEmail: usd };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** `"Name" <address>`, or the bare address when there is no usable name. */
export function formatAddress(a: { email: string; name?: string }): string {
  const name = a.name ? oneLine(a.name).replace(/["\\<>]/g, "") : "";
  return name ? `"${name}" <${a.email}>` : a.email;
}

/** Tags as the vendor takes them, leaving out any it would reject. */
export function vendorTags(tags: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(tags)
    .filter(([name, value]) => TAG.test(name) && typeof value === "string" && TAG.test(value))
    .map(([name, value]) => ({ name, value }));
}

function vendorHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^[A-Za-z0-9-]{1,76}$/.test(name) && typeof value === "string" && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The request's Idempotency-Key: a hash over the batch's sorted effect keys. */
export async function batchIdempotencyKey(effectKeys: readonly string[]): Promise<string> {
  const canonical = [...effectKeys].sort().join("\n");
  return `batch-${hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))}`;
}

export function classifyStatus(status: number, errorName = ""): { code: AdapterErrorCode; retryable: boolean } {
  if (status === 400 || status === 422) return { code: "invalid", retryable: false };
  if (status === 401 || status === 403) return { code: "auth", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  // An idempotency conflict: another request with this key may be sending the batch right now.
  if (status === 409) return { code: "unknown", retryable: false };
  if (status === 429) return /quota/i.test(errorName) ? { code: "quota", retryable: true } : { code: "rate_limited", retryable: true };
  if (status === 503) return { code: "unavailable", retryable: true };
  if (status >= 500) return { code: "unknown", retryable: true };
  return { code: "unknown", retryable: false };
}

async function errorName(response: Response): Promise<string> {
  try {
    const body = await response.json<unknown>();
    return isRecord(body) && typeof body.name === "string" ? body.name.slice(0, 80) : "";
  } catch {
    return "";
  }
}

/** True unless the vendor says the bounce was temporary. A missing type counts as hard. */
export function isHardBounce(type: unknown): boolean {
  if (typeof type !== "string" || type.trim() === "") return true;
  return !SOFT_BOUNCES.has(type.trim().toLowerCase());
}

function tagsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const t of raw) if (isRecord(t) && typeof t.name === "string" && typeof t.value === "string") out[t.name] = t.value;
  } else if (isRecord(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

function decodeWebhookSecret(secret: string): Uint8Array | null {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    return bytes.length >= 16 ? bytes : null;
  } catch {
    return null;
  }
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Map one verified payload to port events. Unknown types map to none. */
export function mapWebhookEvent(payload: unknown, now: Date): EmailEvent[] {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  const data = payload.data;
  const providerMessageId = str(data.email_id);
  const to = Array.isArray(data.to) ? str(data.to[0]) : str(data.to);
  const at = str(payload.created_at) ?? str(data.created_at) ?? now.toISOString();
  if (!providerMessageId) return [];
  const type = payload.type;
  if (type === "email.opened") return [{ type: "opened", providerMessageId, at }];
  if (type === "email.clicked") return [{ type: "clicked", providerMessageId, at }];
  if (!to) return [];
  const tags = tagsOf(data.tags);
  const bounce = isRecord(data.bounce) ? data.bounce : {};
  switch (type) {
    case "email.delivered":
      return [{ type: "delivered", providerMessageId, tags, to, at }];
    case "email.bounced": {
      const reason = [str(bounce.type), str(bounce.subType)].filter(Boolean).join("/");
      return [{ type: "bounced", providerMessageId, tags, to, at, hard: isHardBounce(bounce.type), ...(reason ? { reason } : {}) }];
    }
    case "email.suppressed":
      return [{ type: "bounced", providerMessageId, tags, to, at, hard: true, reason: "suppressed by the provider" }];
    case "email.complained":
      return [{ type: "complained", providerMessageId, tags, to, at }];
    case "email.failed": {
      const failed = isRecord(data.failed) ? str(data.failed.reason) : undefined;
      return [{ type: "failed", providerMessageId, tags, to, at, ...(failed ? { reason: failed.slice(0, 200) } : {}) }];
    }
    default:
      return [];
  }
}

export function createAdapter(ctx: AdapterContext): EmailProvider {
  const options = readOptions(ctx.options);
  const costOf = (accepted: number): Cost => ({ provider: NAME, capability: "send", units: accepted, usd: Math.round(accepted * options.usdPerEmail * 1_000_000) / 1_000_000 });
  const refuse = (m: OutboundMessage, code: AdapterErrorCode, retryable: boolean, detail: string): SendOutcome => ({ effectKey: m.effectKey, ok: false, code, retryable, detail });

  async function sendChunk(chunk: OutboundMessage[], key: string): Promise<SendOutcome[]> {
    const payload = chunk.map((m) => ({
      from: formatAddress(m.from),
      to: [formatAddress(m.to)],
      subject: oneLine(m.subject),
      text: m.text,
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      headers: vendorHeaders(m.headers),
      tags: vendorTags(m.tags),
    }));
    let response: Response;
    try {
      response = await ctx.fetch(`${options.baseUrl}/emails/batch`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": await batchIdempotencyKey(chunk.map((m) => m.effectKey)) },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      return chunk.map((m) => refuse(m, "timeout", true, timeout ? "the request timed out" : "the request failed before an answer arrived"));
    }
    if (!response.ok) {
      const name = await errorName(response);
      const { code, retryable } = classifyStatus(response.status, name);
      return chunk.map((m) => refuse(m, code, retryable, `HTTP ${response.status}${name ? ` ${name}` : ""}`));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return chunk.map((m) => refuse(m, "unknown", false, "the response was not JSON"));
    }
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return chunk.map((m, i) => {
      const entry: unknown = data[i];
      const id = isRecord(entry) ? str(entry.id) : undefined;
      return id ? { effectKey: m.effectKey, ok: true, providerMessageId: id } : refuse(m, "unknown", false, "the response held no id for this message");
    });
  }

  return {
    name: NAME,
    batchLimit: BATCH_LIMIT,

    async sendBatch(messages) {
      if (messages.length === 0) return { outcomes: [], cost: costOf(0) };
      const key = ctx.optionalSecret(API_KEY_NAME);
      if (!key) return { outcomes: messages.map((m) => refuse(m, "auth", false, `${API_KEY_NAME} is not set`)), cost: costOf(0) };
      const outcomes: SendOutcome[] = [];
      for (let i = 0; i < messages.length; i += BATCH_LIMIT) outcomes.push(...(await sendChunk(messages.slice(i, i + BATCH_LIMIT), key)));
      return { outcomes, cost: costOf(outcomes.filter((o) => o.ok).length) };
    },

    async parseWebhook(request) {
      const secret = ctx.optionalSecret(WEBHOOK_SECRET_NAME);
      if (!secret) throw new AdapterError(`${WEBHOOK_SECRET_NAME} is not set, so webhooks cannot be verified`, "unavailable", false);
      const keyBytes = decodeWebhookSecret(secret);
      if (!keyBytes) throw new AdapterError(`${WEBHOOK_SECRET_NAME} is not a valid signing secret`, "unavailable", false);
      const header = (name: string) => request.headers.get(`svix-${name}`) ?? request.headers.get(`webhook-${name}`) ?? "";
      const id = header("id");
      const timestamp = header("timestamp");
      const signatures = header("signature");
      if (!id || !signatures || !/^\d{1,12}$/.test(timestamp)) throw new AdapterError("the webhook is not signed", "auth", false);
      if (Math.abs(ctx.now().getTime() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) throw new AdapterError("the webhook timestamp is outside the 5-minute window", "auth", false);
      const body = await request.text();
      if (body.length > WEBHOOK_MAX_BYTES) throw new AdapterError("the webhook body is too large", "invalid", false);
      const hmac = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const expected = base64(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`${id}.${timestamp}.${body}`)));
      let valid = false;
      for (const part of signatures.split(" ")) {
        if (!part.startsWith("v1,")) continue;
        // Every candidate is compared, so the time taken does not depend on which one matched.
        if (await constantTimeEqual(part.slice(3), expected)) valid = true;
      }
      if (!valid) throw new AdapterError("the webhook signature does not match", "auth", false);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new AdapterError("the webhook body is not JSON", "invalid", false);
      }
      return mapWebhookEvent(payload, ctx.now());
    },

    async getDelivery(providerMessageId) {
      const key = ctx.secret(API_KEY_NAME);
      const response = await ctx.fetch(`${options.baseUrl}/emails/${encodeURIComponent(providerMessageId)}`, { headers: { authorization: `Bearer ${key}` } });
      if (!response.ok) {
        const { code, retryable } = classifyStatus(response.status, await errorName(response));
        throw new AdapterError(`email lookup failed with HTTP ${response.status}`, code, retryable);
      }
      const body = await response.json<unknown>().catch(() => null);
      const last = isRecord(body) ? str(body.last_event) : undefined;
      const at = isRecord(body) ? str(body.created_at) : undefined;
      const state = last === "delivered" ? "delivered" : last === "bounced" ? "bounced" : last === "complained" ? "complained" : last === "sent" || last === "queued" || last === "scheduled" ? "queued" : "unknown";
      return { state, ...(at ? { at } : {}) };
    },
  };
}
