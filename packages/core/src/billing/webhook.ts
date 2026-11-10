// GTM-agents: POST /api/webhooks/billing, the billing provider's events, through the
// BillingProvider port (docs/LIFECYCLE.md, docs/INTERFACES.md).
//
// In order, and nothing touches the database before step 2 passes:
//   1. a billing adapter must be configured, or the route answers 503;
//   2. the adapter verifies the signature (5-minute tolerance, constant time) and maps the payload:
//      a bad or stale signature answers 401, a payload it cannot map 400, an adapter that cannot
//      verify (its secret unset) 503;
//   3. an event from the provider's test mode (livemode false) while billing:accept_test_events is
//      off, or unreadable, answers 200 and changes nothing: it is not recorded or routed, so no
//      lifecycle move, deal or MRR change follows. An audit row and a log line say it was ignored;
//   4. with billing:enabled or lifecycle:enabled off, or unreadable, the route answers 503 and
//      records nothing. An event the adapter marks ignored answers 200 and records nothing;
//   5. the event is recorded on the spine, keyed by provider and the provider's event id, with the
//      customer's address replaced by its hashes. A duplicate answers 200 with duplicate: true;
//   6. it is dispatched to EVENTS_QUEUE, or routed inline after the response.
// Routing (route.ts) resolves existing contacts only, refuses erased people, and claims every
// effect under the event's id.
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { writeAudit } from "../events/audit.ts";
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

/** The action of the audit row a dropped test-mode event leaves. */
export const TEST_MODE_AUDIT_ACTION = "billing_event_ignored_test_mode";

/**
 * True for a mapped event that is not marked live: from the vendor's test mode, or from an adapter
 * that did not say. Only `livemode: true` is live, so a missing field fails closed. Pure.
 */
export const isTestModeEvent = (event: unknown): boolean =>
  Boolean(event) && typeof event === "object" && (event as { type?: unknown }).type !== "ignored" && (event as { livemode?: unknown }).livemode !== true;

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
    // A test-mode event changes nothing unless the operator chose to accept them. An unreadable
    // flag counts as off.
    if (isTestModeEvent(event) && !(await readSwitch(flags, LIFECYCLE_FLAGS.acceptTestEvents))) {
      const id = typeof event.providerEventId === "string" ? event.providerEventId.replace(/[^\w.:-]/g, "").slice(0, 200) : "";
      const type = String((event as { type?: unknown }).type).replace(/[^a-z_]/g, "").slice(0, 40);
      options.logger.info("a billing event from the provider's test mode was ignored", { provider: provider.name, type, event: id });
      await writeAudit(c.env.DB, { agentId: "billing", action: TEST_MODE_AUDIT_ACTION, details: { provider: provider.name, type, event: id }, now: (options.now ?? (() => new Date()))() });
      return c.json({ ok: true, ignored: true, reason: "test_mode" });
    }
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
