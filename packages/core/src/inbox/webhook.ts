// GTM-agents: POST /api/webhooks/mail, where the mailbox's push notifications arrive (for Gmail, a
// Cloud Pub/Sub push subscription).
//
// In order, and nothing touches the database before step 2 passes:
//   1. MAIL_PUSH_SECRET must be set, or the route answers 503;
//   2. the request must carry it, as the `token` query parameter (what a Pub/Sub push endpoint URL
//      can hold) or an `x-push-token` header, compared in constant time. Anything else answers 401;
//   3. with inbox:enabled off (or unreadable) the push is acknowledged and nothing else happens;
//   4. with no mailbox configured the route answers 503; with the system halted (or the halt flag
//      unreadable) the push is acknowledged and no poll runs;
//   5. the push is only a wake-up. Its body, including any history id, is never read: that id is
//      the mailbox state after the new message, so listing from it would skip the message. Instead
//      one bounded poll runs from the stored cursor after the response is sent (waitUntil). Pushes
//      that arrive within PUSH_COALESCE_MS of a poll starting are acknowledged without another one;
//      the minute poll is the backstop either way.
// The answer is 200 for anything acknowledged, so the push service does not redeliver.
import type { Context } from "hono";
import type { GtmConfig } from "../config/schema.ts";
import type { Env } from "../env.ts";
import { constantTimeEqual } from "../http/auth.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { readHalt } from "../security/halt.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { kvFlags } from "../sending/flags.ts";
import { inboxEnabled, PUSH_LAST_KEY } from "./flags.ts";
import { DEFAULT_INBOX_JOB_OPTIONS } from "./jobs.ts";
import { pollInbox } from "./poll.ts";

export const MAIL_WEBHOOK_PATH = "/api/webhooks/mail";
/** The secret the push subscription carries. */
export const MAIL_PUSH_SECRET_NAME = "MAIL_PUSH_SECRET";
/** Pushes within this long of a push-triggered poll starting do not start another. */
export const PUSH_COALESCE_MS = 15_000;

export interface InboxPushWebhookOptions<E> {
  config: GtmConfig;
  inbox?: (env: E) => InboxProvider | undefined;
  operator?: (env: E) => OperatorChannel | undefined;
  logger?: JobLogger;
  now?: () => Date;
}

const resolve = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

/** The token a push carries: the `token` query parameter, else the x-push-token header. */
function presentedToken(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("token") ?? request.headers.get("x-push-token") ?? "";
}

/** The handler for POST /api/webhooks/mail. */
export function createInboxPushWebhook<E extends Env>(options: InboxPushWebhookOptions<E>): (c: Context<{ Bindings: E }>) => Promise<Response> {
  const log = options.logger;
  return async (c) => {
    const env = c.env;
    const secret = typeof env.MAIL_PUSH_SECRET === "string" ? env.MAIL_PUSH_SECRET : "";
    if (!secret) return c.json({ error: "push_not_configured", detail: `set ${MAIL_PUSH_SECRET_NAME} with wrangler secret put` }, 503);
    if (!(await constantTimeEqual(presentedToken(c.req.raw), secret))) return c.json({ error: "unauthorized" }, 401);

    if (!(await inboxEnabled(kvFlags(env.KV)))) return c.json({ ok: true, disabled: true });
    const inbox = resolve(options.inbox, env);
    if (!inbox) return c.json({ error: "inbox_not_configured" }, 503);
    if ((await readHalt(env.KV)).halted) return c.json({ ok: true, halted: true });

    const now = (options.now ?? (() => new Date()))();
    // Coalescing is bookkeeping: an unreadable marker means one more poll, never a lost one.
    try {
      const last = await env.KV?.get(PUSH_LAST_KEY);
      if (last && now.getTime() - Date.parse(last) < PUSH_COALESCE_MS) return c.json({ ok: true, coalesced: true });
      await env.KV?.put(PUSH_LAST_KEY, now.toISOString(), { expirationTtl: 60 });
    } catch {
      // Poll anyway.
    }

    const work = pollInbox({
      db: env.DB,
      bucket: env.BUCKET ?? null,
      kv: env.KV ?? null,
      config: options.config,
      provider: inbox.name,
      operator: resolve(options.operator, env),
      now,
      ...(log ? { log } : {}),
      inbox,
      limit: DEFAULT_INBOX_JOB_OPTIONS.pollLimit,
      maxPages: 1,
      pendingLimit: 0,
    })
      .then(() => undefined)
      .catch((error: unknown) => log?.warn("a push-triggered poll failed; the minute poll will catch up", { error: sanitizeErrorMessage(error) }));
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // No execution context (a direct call in a test): finish the poll before answering.
      await work;
    }
    return c.json({ ok: true, polling: true });
  };
}
