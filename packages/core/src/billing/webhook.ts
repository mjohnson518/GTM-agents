// GTM-agents: POST /api/webhooks/billing, the billing provider's events, through the
// BillingProvider port (docs/LIFECYCLE.md, docs/INTERFACES.md).
//
// In order, and nothing touches the database before step 2 passes:
//   1. a billing adapter must be configured, or the route answers 503;
//   2. the adapter verifies the signature (5-minute tolerance, constant time) and maps the payload:
//      a bad or stale signature answers 401, a payload it cannot map 400, an adapter that cannot
//      verify (its secret unset) 503;
//   3. with billing:enabled or lifecycle:enabled off, or unreadable, the route answers 503 and
//      records nothing. An event the adapter marks ignored answers 200 and records nothing;
//   4. the event is recorded on the spine, keyed by provider and the provider's event id, with the
//      customer's address replaced by its hashes. A duplicate answers 200 with duplicate: true;
//   5. it is dispatched to EVENTS_QUEUE, or routed inline after the response.
// Routing (route.ts) resolves existing contacts only, refuses erased people, and claims every
// effect under the event's id.
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { dispatchEvent, recordEvent, routeEvent, type EventRouters } from "../events/spine.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { LIFECYCLE_FLAGS } from "../lifecycle/flags.ts";
import type { BillingEvent, BillingProvider } from "../ports/business.ts";
import { AdapterError } from "../ports/types.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { kvFlags, readSwitch } from "../sending/flags.ts";
import { addressHash, mailboxOf, normalizeAddress } from "../sending/suppression.ts";
import { BILLING_SOURCE, type StoredBillingEvent } from "./route.ts";

export const BILLING_WEBHOOK_PATH = "/api/webhooks/billing";

export interface BillingWebhookOptions<E> {
  billing?: (env: E) => BillingProvider | undefined;
  routers?: (env: E) => EventRouters<E>;
  logger: JobLogger;
  now?: () => Date;
}

const errorCode = (error: unknown): string | undefined => (error instanceof AdapterError ? error.code : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined);

/** The event as the spine stores it: no address, only its hashes, and times in ISO 8601 UTC. */
export async function toStored(provider: string, event: Exclude<BillingEvent, { type: "ignored" }>, now: Date): Promise<StoredBillingEvent> {
  const address = "email" in event ? normalizeAddress(event.email) : null;
  const rest: Record<string, unknown> = { ...event };
  delete rest.email;
  // A time the adapter got wrong in the future would make every later event look stale.
  const at = Number.isNaN(Date.parse(event.at)) || Date.parse(event.at) > now.getTime() ? now.toISOString() : new Date(event.at).toISOString();
  return {
    provider,
    event: { ...rest, at } as StoredBillingEvent["event"],
    emailSha256: address ? await addressHash(address) : null,
    mailboxSha256: address ? await addressHash(mailboxOf(address)) : null,
  };
}

/** The handler for POST /api/webhooks/billing. */
export function createBillingWebhook<E extends Env>(options: BillingWebhookOptions<E>): (c: Context<{ Bindings: E }>) => Promise<Response> {
  return async (c) => {
    let provider: BillingProvider | undefined;
    try {
      provider = options.billing?.(c.env);
    } catch {
      provider = undefined;
    }
    if (!provider || !options.routers) return c.json({ error: "billing_not_configured" }, 503);
    let event: BillingEvent;
    try {
      event = await provider.parseWebhook(c.req.raw);
    } catch (error) {
      const code = errorCode(error);
      if (code === "auth") return c.json({ error: "unauthorized" }, 401);
      if (code === "invalid") return c.json({ error: "invalid_event" }, 400);
      options.logger.warn("a billing webhook could not be verified", { error: sanitizeErrorMessage(error) });
      return c.json({ error: "verification_unavailable" }, 503);
    }
    const flags = kvFlags(c.env.KV);
    if (!(await readSwitch(flags, LIFECYCLE_FLAGS.billing)) || !(await readSwitch(flags, LIFECYCLE_FLAGS.enabled))) return c.json({ error: "billing_disabled" }, 503);
    if (!event || typeof event !== "object" || typeof event.providerEventId !== "string" || event.providerEventId.length === 0 || event.providerEventId.length > 200) {
      return c.json({ error: "invalid_event" }, 400);
    }
    if (event.type === "ignored") return c.json({ ok: true, ignored: true });
    if (typeof event.customerId !== "string" || event.customerId.length === 0 || event.customerId.length > 200) return c.json({ error: "invalid_event" }, 400);

    const now = (options.now ?? (() => new Date()))();
    const stored = await toStored(provider.name, event, now);
    let recorded: { id: string; duplicate: boolean };
    try {
      recorded = await recordEvent(
        { db: c.env.DB, bucket: c.env.BUCKET },
        { source: BILLING_SOURCE, providerId: `${provider.name}:${event.providerEventId}`, type: event.type, occurredAt: stored.event.at, receivedAt: now, payload: JSON.stringify(stored), taint: "structured", subjectRef: stored.emailSha256 },
      );
    } catch (error) {
      options.logger.error("a billing event could not be recorded", { error: sanitizeErrorMessage(error) });
      return c.json({ error: "record_failed" }, 500);
    }
    if (recorded.duplicate) return c.json({ ok: true, duplicate: true });
    let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      waitUntil = (promise) => ctx.waitUntil(promise);
    } catch {
      waitUntil = undefined;
    }
    const routers = options.routers;
    await dispatchEvent({
      queue: c.env.EVENTS_QUEUE,
      id: recorded.id,
      log: options.logger,
      inline: () => routeEvent({ env: c.env, db: c.env.DB, bucket: c.env.BUCKET, now, flags, log: options.logger }, routers(c.env), recorded.id),
      ...(waitUntil ? { waitUntil } : {}),
    });
    return c.json({ ok: true, duplicate: false });
  };
}
