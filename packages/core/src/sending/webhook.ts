// GTM-agents: POST /api/webhooks/email, where the email provider reports what happened to each
// message.
//
// In order, and nothing touches the database before step 2 passes:
//   1. the email provider must be configured, or the route answers 503;
//   2. the adapter verifies the signature (for Svix-style providers, an HMAC over
//      "{id}.{timestamp}.{body}" inside a 5-minute window, compared in constant time) and maps the
//      payload to typed events. A bad or stale signature answers 401, a malformed payload 400, and
//      a provider that cannot verify (its webhook secret is unset) 503;
//   3. each event is claimed once in the effects ledger (by provider message id and event type),
//      so a redelivered webhook changes nothing;
//   4. each event is matched to its send: by the send id tag, else by the provider message id,
//      else by the recipient address. Ids in tags are never trusted on their own: a tagged send
//      must also carry the event's provider message id, and a tagged contact must hold the event's
//      address.
// Then, per event type:
//   - delivered: the ledger's delivered_at, the recipient domain's delivered count, the campaign
//     row;
//   - bounced, hard (or with no bounce type): the address is suppressed (bounce) and the contact
//     opted out with its sequences stopped; then the ledger's bounced_at, the domain's hard bounce
//     count, the outreach log and a page (at most five a day; the bounce monitor watches the rate).
//     Every bounce, hard or soft, records a funnel event;
//   - complained: the address is suppressed (complaint) whether or not a send matches, the contact
//     opted out; then the ledger's complained_at, the domain's complaint count and a page;
//   - unsubscribed: the same opt-out as the unsubscribe link, and a notice;
//   - failed: logged; opened and clicked: ignored (mail is plain text with no tracking).
// Suppression is a gate and runs before the event is claimed: if it cannot be written, nothing is
// claimed and the route answers 500 so the provider retries. Everything else is bookkeeping: caught, logged, dropped.
import type { Context } from "hono";
import type { Env } from "../env.ts";
import { claimEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { EmailEvent, EmailProvider } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { sha256Hex } from "../shared/hash.ts";
import type { KvStore } from "../shared/kv.ts";
import { optOutAddress, type OptOutReason } from "./opt-out.ts";
import { pageOnce, utcDay } from "./pages.ts";
import { addressHash, mailboxOf, normalizeAddress } from "./suppression.ts";

export const EMAIL_WEBHOOK_PATH = "/api/webhooks/email";
export const EMAIL_EVENT_EFFECT = "email_event";
/** Individual hard-bounce pages per UTC day; the bounce monitor reports the rate. */
export const BOUNCE_PAGES_PER_DAY = 5;

export interface EmailEventDeps {
  db: D1Database;
  kv: KvStore | undefined | null;
  /** The provider's name, as the send ledger records it. */
  provider: string;
  operator?: OperatorChannel;
  now: Date;
  log?: JobLogger;
}

export interface EmailEventsResult {
  processed: number;
  duplicates: number;
  ignored: number;
  /** True when an event must be delivered again (its suppression could not be written). */
  retry: boolean;
}

interface SendRow {
  id: string;
  contact_id: string | null;
  campaign_id: string | null;
  provider_message_id: string | null;
  recipient_domain: string | null;
}

interface Match {
  send: SendRow | null;
  contactId: string | null;
  contactEmail: string | null;
  campaignId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 512 ? v : null);

/** The effects-ledger key for an event: one per provider message and event type. */
export async function emailEventKey(event: EmailEvent, provider: string): Promise<string | null> {
  if (event.type === "unsubscribed") {
    const address = normalizeAddress(event.to);
    return address ? `email:${provider}:unsubscribed:${await sha256Hex(address)}` : null;
  }
  const id = str((event as { providerMessageId?: unknown }).providerMessageId);
  return id ? `email:${provider}:${id}:${event.type}` : null;
}

async function matchEvent(db: D1Database, provider: string, event: Exclude<EmailEvent, { type: "opened" | "clicked" }>): Promise<Match> {
  const tags = isRecord((event as { tags?: unknown }).tags) ? ((event as { tags: Record<string, unknown> }).tags) : {};
  const messageId = "providerMessageId" in event ? str(event.providerMessageId) : null;
  const columns = "id, contact_id, campaign_id, provider_message_id, recipient_domain";
  let send: SendRow | null = null;
  const tagged = str(tags.send_id);
  if (tagged) {
    const row = await db.prepare(`SELECT ${columns} FROM outreach_sends WHERE id = ?1 AND provider = ?2`).bind(tagged, provider).first<SendRow>();
    if (row && (row.provider_message_id === null || row.provider_message_id === messageId)) send = row;
  }
  if (!send && messageId) {
    send = await db.prepare(`SELECT ${columns} FROM outreach_sends WHERE provider = ?1 AND provider_message_id = ?2`).bind(provider, messageId).first<SendRow>();
  }
  const address = normalizeAddress(event.to);
  let contactId = send?.contact_id ?? null;
  let contactEmail: string | null = null;
  if (contactId) {
    contactEmail = (await db.prepare("SELECT email FROM contacts WHERE id = ?1").bind(contactId).first<{ email: string }>())?.email ?? null;
  } else if (address) {
    const exact = await addressHash(address);
    const mailbox = await addressHash(mailboxOf(address));
    const { results } = await db.prepare("SELECT id, email FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 ORDER BY email_sha256 = ?1 DESC").bind(exact, mailbox).all<{ id: string; email: string }>();
    const taggedContact = str(tags.contact_id);
    const chosen = results.find((r) => r.id === taggedContact) ?? results[0];
    contactId = chosen?.id ?? null;
    contactEmail = chosen?.email ?? null;
  }
  // A campaign id is taken only from a matched send, never from a tag alone.
  const campaignId = send?.campaign_id ?? null;
  return { send, contactId, contactEmail, campaignId };
}

type TrackingEvent = Extract<EmailEvent, { type: "opened" | "clicked" }>;

/** Opens and clicks: mail is plain text with no tracking, so core ignores them. */
const isTrackingEvent = (event: EmailEvent): event is TrackingEvent => event.type === "opened" || event.type === "clicked";

const domainOf = (address: string | null): string | null => (address ? address.slice(address.lastIndexOf("@") + 1) : null);

/** Process verified events. Never throws; `retry` asks the provider to deliver again. */
export async function processEmailEvents(deps: EmailEventDeps, events: readonly EmailEvent[]): Promise<EmailEventsResult> {
  const result: EmailEventsResult = { processed: 0, duplicates: 0, ignored: 0, retry: false };
  const { db, now } = deps;
  const at = now.toISOString();
  const log = deps.log;
  const write = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      log?.warn("a delivery event write failed; it is dropped", { write: name, error: sanitizeErrorMessage(error) });
    }
  };
  const bumpDomain = (domain: string | null, column: "delivered" | "hard_bounces" | "complaints") =>
    domain
      ? write(`domain_delivery.${column}`, () =>
          db
            .prepare(`INSERT INTO domain_delivery (domain, ${column}, created_at, updated_at) VALUES (?1, 1, ?2, ?2) ON CONFLICT (domain) DO UPDATE SET ${column} = ${column} + 1, updated_at = excluded.updated_at`)
            .bind(domain, at)
            .run(),
        )
      : Promise.resolve();

  for (const raw of events) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      result.ignored += 1;
      continue;
    }
    const candidate: EmailEvent = raw;
    if (isTrackingEvent(candidate)) {
      result.ignored += 1;
      continue;
    }
    const event = candidate;
    const key = await emailEventKey(event, deps.provider);
    if (!key) {
      result.ignored += 1;
      continue;
    }
    let match: Match;
    try {
      match = await matchEvent(db, deps.provider, event);
    } catch {
      match = { send: null, contactId: null, contactEmail: null, campaignId: null };
    }
    const address = normalizeAddress(event.to) ?? match.contactEmail;
    const domain = match.send?.recipient_domain ?? domainOf(address);

    // Suppression runs before the claim: it is idempotent, and a claim taken first could be left
    // behind by a failure, so the provider's retry would look like a duplicate and never suppress.
    const optOutReason: OptOutReason | null =
      event.type === "complained" ? "complaint" : event.type === "unsubscribed" ? "opt_out" : event.type === "bounced" && event.hard !== false ? "bounce" : null;
    if (optOutReason) {
      if (!address) log?.warn("a delivery event names no usable address, so it cannot be suppressed", { type: event.type });
      else {
        try {
          await optOutAddress(db, address, { reason: optOutReason, source: "provider_webhook", notes: `${deps.provider} ${event.type}`, now });
        } catch {
          result.retry = true;
          continue;
        }
      }
    }

    try {
      if (!(await claimEffect(db, key, EMAIL_EVENT_EFFECT))) {
        result.duplicates += 1;
        continue;
      }
    } catch {
      result.retry = true;
      continue;
    }

    switch (event.type) {
      case "delivered": {
        if (match.send) await write("outreach_sends.delivered_at", () => db.prepare("UPDATE outreach_sends SET delivered_at = COALESCE(delivered_at, ?2) WHERE id = ?1").bind(match.send?.id, at).run());
        await bumpDomain(domain, "delivered");
        if (match.contactId && match.campaignId) {
          await write("campaign_contacts", () =>
            db
              .prepare("UPDATE campaign_contacts SET status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END, updated_at = ?3 WHERE campaign_id = ?1 AND contact_id = ?2")
              .bind(match.campaignId, match.contactId, at)
              .run(),
          );
        }
        break;
      }
      case "bounced": {
        const hard = event.hard !== false;
        await write("funnel_event", () =>
          db
            .prepare("INSERT INTO funnel_events (id, event_type, contact_id, source, campaign_id, metadata, occurred_at, created_at) VALUES (?1, 'outreach_bounced', ?2, 'webhook', ?3, ?4, ?5, ?5)")
            .bind(crypto.randomUUID(), match.contactId, match.campaignId, JSON.stringify({ hard, provider: deps.provider, provider_message_id: event.providerMessageId, send_id: match.send?.id ?? null }), at)
            .run(),
        );
        if (!hard) break;
        if (match.send) await write("outreach_sends.bounced_at", () => db.prepare("UPDATE outreach_sends SET bounced_at = COALESCE(bounced_at, ?2) WHERE id = ?1").bind(match.send?.id, at).run());
        await bumpDomain(domain, "hard_bounces");
        if (match.contactId) {
          await write("outreach_log", () =>
            db
              .prepare("INSERT INTO outreach_log (id, contact_id, channel, direction, subject, summary, outcome, provider, provider_message_id, created_at) VALUES (?1, ?2, 'email', 'inbound', NULL, 'hard bounce', 'bounced', ?3, ?4, ?5)")
              .bind(crypto.randomUUID(), match.contactId, deps.provider, event.providerMessageId, at)
              .run(),
          );
        }
        await pageBounce(deps, address, match.send?.id ?? event.providerMessageId);
        break;
      }
      case "complained": {
        if (match.send) await write("outreach_sends.complained_at", () => db.prepare("UPDATE outreach_sends SET complained_at = COALESCE(complained_at, ?2) WHERE id = ?1").bind(match.send?.id, at).run());
        await bumpDomain(domain, "complaints");
        await pageOnce({
          db,
          kv: deps.kv,
          operator: deps.operator,
          eventId: key,
          effect: "page",
          text: `Spam complaint from ${address ?? "an unknown address"}. The address is suppressed and the contact opted out. Complaints over 0.3% step the warm-up ramp down.`,
        });
        break;
      }
      case "unsubscribed": {
        await pageOnce({ db, kv: deps.kv, operator: deps.operator, eventId: key, effect: "notice", text: `Unsubscribed through the email provider: ${address ?? "an unknown address"}. Suppressed, opted out, sequences stopped.` });
        break;
      }
      case "failed":
        log?.warn("the email provider reports a message it could not send", { providerMessageId: event.providerMessageId, sendId: match.send?.id ?? null });
        break;
      default:
        result.ignored += 1;
        continue;
    }
    result.processed += 1;
  }
  return result;
}

async function pageBounce(deps: EmailEventDeps, address: string | null, ref: string): Promise<void> {
  const day = utcDay(deps.now);
  try {
    const row = await deps.db
      .prepare("SELECT COUNT(*) AS n FROM event_effects WHERE effect = 'bounce_page' AND event_id LIKE ?1")
      .bind(`delivery:bounce-page:${day}:%`)
      .first<{ n: number }>();
    const sent = Number(row?.n ?? 0);
    if (sent >= BOUNCE_PAGES_PER_DAY) return;
    const last = sent === BOUNCE_PAGES_PER_DAY - 1 ? " Further hard bounces today are suppressed without a page each; the bounce monitor reports the rate." : "";
    await pageOnce({
      db: deps.db,
      kv: deps.kv,
      operator: deps.operator,
      eventId: `delivery:bounce-page:${day}:${ref}`,
      effect: "bounce_page",
      text: `Hard bounce from ${address ?? "an unknown address"}. The address is suppressed and the contact opted out.${last}`,
    });
  } catch {
    // Bookkeeping.
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

export interface EmailWebhookOptions<E> {
  email?: (env: E) => EmailProvider | undefined;
  operator?: (env: E) => OperatorChannel | undefined;
  logger?: JobLogger;
  now?: () => Date;
}

/** The handler for POST /api/webhooks/email. */
export function createEmailWebhook<E extends Env>(options: EmailWebhookOptions<E>): (c: Context<{ Bindings: E }>) => Promise<Response> {
  const resolve = <T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
    try {
      return factory?.(env);
    } catch {
      return undefined;
    }
  };
  return async (c) => {
    const provider = resolve(options.email, c.env);
    if (!provider) return c.json({ error: "email_provider_not_configured" }, 503);
    let events: EmailEvent[];
    try {
      events = await provider.parseWebhook(c.req.raw);
    } catch (error) {
      const code = errorCode(error);
      if (code === "auth") return c.json({ error: "unauthorized" }, 401);
      if (code === "invalid") return c.json({ error: "invalid_event" }, 400);
      options.logger?.warn("an email provider webhook could not be verified", { error: sanitizeErrorMessage(error) });
      return c.json({ error: "verification_unavailable" }, 503);
    }
    const result = await processEmailEvents(
      { db: c.env.DB, kv: c.env.KV, provider: provider.name, operator: resolve(options.operator, c.env), now: (options.now ?? (() => new Date()))(), ...(options.logger ? { log: options.logger } : {}) },
      Array.isArray(events) ? events : [],
    );
    if (result.retry) return c.json({ error: "retry" }, 500);
    return c.json({ ok: true, processed: result.processed, duplicates: result.duplicates, ignored: result.ignored });
  };
}
