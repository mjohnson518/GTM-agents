// GTM-agents: test doubles for the send path: a recording email provider with a signed webhook.
//
// Import them from "@gtm-agents/core/sending/testing" in tests only. The fake provider keeps every
// batch it was given and answers with whatever the test scripts (accept everything by default).
// Its webhook is signed like a real provider's: an HMAC-SHA256 over "{timestamp}.{body}" in a header,
// a 5-minute window, a constant-time compare, and an auth error for anything else, so tests can
// prove that core rejects a tampered or replayed webhook before touching the database.
import { constantTimeEqual } from "../http/auth.ts";
import type { EmailEvent, EmailProvider, OutboundMessage, SendOutcome } from "../ports/email.ts";
import { AdapterError, type AdapterErrorCode } from "../ports/types.ts";

export const FAKE_SIGNATURE_HEADER = "x-test-email-signature";
export const FAKE_TIMESTAMP_HEADER = "x-test-email-timestamp";
export const FAKE_WEBHOOK_TOLERANCE_SECONDS = 300;

export type FakeSendBehavior =
  | "accept"
  | "throw"
  | { code: AdapterErrorCode; retryable: boolean }
  | ((message: OutboundMessage, index: number) => SendOutcome | Promise<SendOutcome>);

export interface FakeEmailProvider extends EmailProvider {
  /** Every batch sendBatch was called with. */
  batches: OutboundMessage[][];
  /** Every message, across batches. */
  messages(): OutboundMessage[];
  /** How the next calls answer. */
  behavior: FakeSendBehavior;
  /** How many times parseWebhook read a request body (so tests can prove a rejection read nothing more). */
  webhookBodiesRead: number;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

export function fakeEmailProvider(options: { name?: string; batchLimit?: number; webhookSecret?: string; now?: () => Date; usdPerMessage?: number } = {}): FakeEmailProvider {
  let counter = 0;
  const now = options.now ?? (() => new Date());
  const provider: FakeEmailProvider = {
    name: options.name ?? "fake-esp",
    ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
    batches: [],
    behavior: "accept",
    webhookBodiesRead: 0,
    messages: () => provider.batches.flat(),
    async sendBatch(messages) {
      provider.batches.push(messages.map((m) => structuredClone(m)));
      const behavior = provider.behavior;
      if (behavior === "throw") throw new Error("fake provider: connection reset");
      const outcomes: SendOutcome[] = [];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i] as OutboundMessage;
        if (behavior === "accept") outcomes.push({ effectKey: m.effectKey, ok: true, providerMessageId: `fake-${(counter += 1)}` });
        else if (typeof behavior === "function") outcomes.push(await behavior(m, i));
        else outcomes.push({ effectKey: m.effectKey, ok: false, code: behavior.code, retryable: behavior.retryable, detail: "scripted failure" });
      }
      const accepted = outcomes.filter((o) => o.ok).length;
      return { outcomes, cost: { provider: provider.name, capability: "send", units: accepted, usd: accepted * (options.usdPerMessage ?? 0.0004) } };
    },
    async parseWebhook(request) {
      const secret = options.webhookSecret;
      if (!secret) throw new AdapterError("fake provider: the webhook secret is not configured", "unavailable", false);
      const signature = request.headers.get(FAKE_SIGNATURE_HEADER) ?? "";
      const timestamp = request.headers.get(FAKE_TIMESTAMP_HEADER) ?? "";
      if (!signature || !/^\d{1,12}$/.test(timestamp)) throw new AdapterError("fake provider: missing signature", "auth", false);
      if (Math.abs(now().getTime() / 1000 - Number(timestamp)) > FAKE_WEBHOOK_TOLERANCE_SECONDS) throw new AdapterError("fake provider: stale webhook", "auth", false);
      const body = await request.text();
      provider.webhookBodiesRead += 1;
      if (!(await constantTimeEqual(signature, await sign(secret, timestamp, body)))) throw new AdapterError("fake provider: bad signature", "auth", false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new AdapterError("fake provider: the body is not JSON", "invalid", false);
      }
      const events = (parsed as { events?: unknown }).events;
      if (!Array.isArray(events)) throw new AdapterError("fake provider: no events", "invalid", false);
      return events as EmailEvent[];
    },
  };
  return provider;
}

/** A webhook request carrying `events`, signed with `secret` at `at` (or tampered with after signing). */
export async function fakeEmailWebhook(
  events: readonly EmailEvent[],
  options: { secret: string; at?: Date; tamper?: boolean; unsigned?: boolean; url?: string },
): Promise<Request> {
  const body = JSON.stringify({ events });
  const timestamp = String(Math.floor((options.at ?? new Date()).getTime() / 1000));
  const signature = await sign(options.secret, timestamp, body);
  // Tampering changes the body after signing: a delivered event becomes a complaint, and a trailing
  // space guarantees the bytes differ whatever the events are.
  const sent = options.tamper ? `${body.replace('"type":"delivered"', '"type":"complained"')} ` : body;
  return new Request(options.url ?? "https://agent.acme.example/api/webhooks/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.unsigned ? {} : { [FAKE_SIGNATURE_HEADER]: signature, [FAKE_TIMESTAMP_HEADER]: timestamp }) },
    body: sent,
  });
}
