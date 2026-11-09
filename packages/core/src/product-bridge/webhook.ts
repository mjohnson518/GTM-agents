// GTM-agents: POST /api/webhooks/product, where the host application pushes its events
// (docs/EVENT-CONTRACT.md, section 1).
//
// In order, and nothing touches the database before step 3 passes:
//   1. PRODUCT_WEBHOOK_SECRET must be set, or the route answers 503;
//   2. the raw body is read once (the Worker caps it at 100 KB);
//   3. X-Signature must be sha256=<hex HMAC-SHA256(secret, raw body)>, compared in constant time,
//      or 401;
//   4. the body must be JSON (else 400), and X-Event-Id must equal body.id, compared in constant
//      time (else 401);
//   5. the envelope must have the contract's shape, or 400;
//   6. with lifecycle:enabled off, or unreadable, the route answers 503 and records nothing, except
//      for user.deleted: an erasure is a compliance action, so whatever the flags its tombstone and
//      suppression are written at once, and the event is recorded (only its id, time, user id and
//      hash) and routed to the full erasure like any other;
//   7. the event is recorded on the spine (payload to blob storage first, then the row keyed by
//      id); an event already recorded answers 200 with duplicate: true and is not dispatched again.
//      An event more than 7 days old by occurred_at is recorded, flagged late and still routed;
//   8. it is dispatched to EVENTS_QUEUE, or routed inline after the response when no queue is bound.
// A 200 means accepted, not acted on. The host never retries; the nightly pull repairs a lost push.
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { writeAudit } from "../events/audit.ts";
import { dispatchEvent, recordEvent, routeEvent, type EventRouters } from "../events/spine.ts";
import { constantTimeEqual } from "../http/auth.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { LIFECYCLE_FLAGS } from "../lifecycle/flags.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { kvFlags, readSwitch } from "../sending/flags.ts";
import { envelopeId, envelopeTaint, isLate, parseEnvelope } from "./envelope.ts";
import { PRODUCT_SOURCE } from "./route.ts";
import { pushSignatureValid } from "./signature.ts";
import { writeTombstone } from "./erasure.ts";
import { addSuppression } from "../sending/suppression.ts";

export const PRODUCT_WEBHOOK_PATH = "/api/webhooks/product";

export interface ProductWebhookOptions<E> {
  /** The spine's routers, for inline routing when no queue is bound. Without them the route answers 503. */
  routers?: (env: E) => EventRouters<E>;
  logger: JobLogger;
  now?: () => Date;
}

function waitUntilOf(c: Context): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

/** The handler for POST /api/webhooks/product. */
export function createProductWebhook<E extends Env>(options: ProductWebhookOptions<E>): (c: Context<{ Bindings: E }>) => Promise<Response> {
  return async (c) => {
    const secret = c.env.PRODUCT_WEBHOOK_SECRET;
    if (typeof secret !== "string" || secret.length === 0 || !options.routers) return c.json({ error: "product_bridge_not_configured" }, 503);
    const body = await c.req.text();
    if (!(await pushSignatureValid(body, c.req.header("x-signature"), secret))) return c.json({ error: "unauthorized" }, 401);
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return c.json({ error: "bad_shape", detail: "the body is not JSON" }, 400);
    }
    const id = envelopeId(raw);
    if (id === null || !(await constantTimeEqual(c.req.header("x-event-id") ?? "", id))) return c.json({ error: "unauthorized" }, 401);
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return c.json({ error: "bad_shape", detail: parsed.error }, 400);
    const flags = kvFlags(c.env.KV);
    const envelope = parsed.envelope;
    const now = (options.now ?? (() => new Date()))();
    const enabled = await readSwitch(flags, LIFECYCLE_FLAGS.enabled);
    const erasure = envelope.type === "user.deleted" && envelope.user?.email_sha256 ? { userId: envelope.user.id, emailSha256: envelope.user.email_sha256 } : null;
    if (!enabled && !erasure) return c.json({ error: "product_bridge_disabled" }, 503);
    if (erasure) {
      // An erasure is honored whatever the flags say, and before anything else: the host never
      // retries, so the tombstone and the suppression are written now, and the full erasure runs
      // when the event routes, at once, whatever lifecycle:enabled says.
      try {
        await writeTombstone(c.env.DB, { emailSha256: erasure.emailSha256, userId: erasure.userId, source: "product", erasedAt: now.toISOString() });
        await addSuppression(c.env.DB, { emailSha256: erasure.emailSha256, reason: "erasure", source: "lifecycle:product" });
      } catch (error) {
        options.logger.error("an erasure could not be recorded", { error: sanitizeErrorMessage(error) });
        return c.json({ error: "record_failed" }, 500);
      }
    }
    const late = isLate(envelope.occurred_at, now);
    let recorded: { id: string; duplicate: boolean };
    try {
      recorded = await recordEvent(
        { db: c.env.DB, bucket: c.env.BUCKET },
        {
          source: PRODUCT_SOURCE,
          providerId: envelope.id,
          type: envelope.type,
          occurredAt: envelope.occurred_at,
          receivedAt: now,
          // An erasure is stored as its id, time, user id and hash only: whatever else the host sent
          // with it (an address, a name) is never kept.
          payload: erasure ? JSON.stringify({ id: envelope.id, version: envelope.version, type: envelope.type, occurred_at: envelope.occurred_at, user: { id: erasure.userId, email_sha256: erasure.emailSha256 }, org: null, ref: null, data: {} }) : body,
          taint: envelopeTaint(envelope.type),
          // An erasure holds no personal data beyond what its tombstone keeps, and must survive the
          // payload scrub it triggers.
          subjectRef: envelope.type === "user.deleted" ? null : (envelope.user?.id ?? null),
          ...(late ? { metadata: { late: "true" } } : {}),
        },
      );
    } catch (error) {
      options.logger.error("a product event could not be recorded", { error: sanitizeErrorMessage(error) });
      return c.json({ error: "record_failed" }, 500);
    }
    if (recorded.duplicate) return c.json({ ok: true, duplicate: true });
    if (late) void writeAudit(c.env.DB, { agentId: "event_spine", action: "product_event_late", details: { id: recorded.id, type: envelope.type }, now });
    const routers = options.routers;
    const waitUntil = waitUntilOf(c);
    await dispatchEvent({
      queue: c.env.EVENTS_QUEUE,
      id: recorded.id,
      log: options.logger,
      inline: () => routeEvent({ env: c.env, db: c.env.DB, bucket: c.env.BUCKET, now, flags, log: options.logger }, routers(c.env), recorded.id),
      ...(waitUntil ? { waitUntil } : {}),
    });
    return c.json({ ok: true, duplicate: false, ...(late ? { late: true } : {}) });
  };
}
