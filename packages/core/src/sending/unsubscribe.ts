// GTM-agents: GET and POST /u/:token, the one-click unsubscribe link every message carries.
//
//   - GET verifies the token and shows a confirmation page with one button. It never acts and
//     never touches the database: mail security scanners and link previews fetch links on their
//     own, and a fetch must not unsubscribe anyone.
//   - POST verifies the token and opts the address out: suppression (opt_out), the contact's warmth
//     to opted_out, its sequences stopped, queued deferred sends cancelled, and one notice to the
//     operator. It is what a mail client's one-click unsubscribe calls (RFC 8058: a POST with the
//     body "List-Unsubscribe=One-Click", no cookies, no login), and what the page's button sends.
//     It is idempotent: a second POST changes nothing and sends no second notice.
// A forged, altered or malformed token answers 400. With UNSUBSCRIBE_SIGNING_KEY unset (or too
// short) both answer 503: no token can be checked, and the send function refuses to send while it
// is unset. If the opt-out cannot be recorded, POST answers 500 and asks the person to try again
// or reply "unsubscribe".
import type { Context } from "hono";
import type { GtmConfig } from "../config/schema.ts";
import type { Env } from "../env.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { notifyWithin } from "../runtime/job-runner.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { optOutAddress } from "./opt-out.ts";
import { isUsableSigningKey, verifyUnsubscribeToken } from "./unsubscribe-token.ts";

export const UNSUBSCRIBE_ROUTE = "/u/:token";

export interface UnsubscribeRouteOptions<E> {
  config: Pick<GtmConfig, "company" | "sending">;
  operator?: (env: E) => OperatorChannel | undefined;
  logger?: JobLogger;
  now?: () => Date;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#222}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style>",
    `</head><body>${body}</body></html>`,
  ].join("");
}

export interface UnsubscribeHandlers<E extends Env> {
  get(c: Context<{ Bindings: E }>): Promise<Response>;
  post(c: Context<{ Bindings: E }>): Promise<Response>;
}

export function createUnsubscribeHandlers<E extends Env>(options: UnsubscribeRouteOptions<E>): UnsubscribeHandlers<E> {
  const company = escapeHtml(options.config.company.name);
  const reply = escapeHtml(options.config.sending.replyTo);
  const respond = (status: number, title: string, body: string) => new Response(page(title, body), { status, headers: HEADERS });
  const notConfigured = () => respond(503, "Unsubscribe unavailable", `<h1>Unsubscribe is unavailable right now</h1><p>Reply to the email with the word "unsubscribe" and ${company} will stop writing to you.</p>`);
  const invalid = () => respond(400, "Link not valid", `<h1>This link is not valid</h1><p>To stop emails from ${company}, reply to the email with the word "unsubscribe".</p>`);

  return {
    async get(c) {
      const key = c.env.UNSUBSCRIBE_SIGNING_KEY;
      if (!isUsableSigningKey(key)) return notConfigured();
      const token = c.req.param("token") ?? "";
      const address = await verifyUnsubscribeToken(token, key);
      if (!address) return invalid();
      return respond(
        200,
        `Unsubscribe from ${options.config.company.name}`,
        `<h1>Unsubscribe from ${company}?</h1><p>${escapeHtml(address)} will get no more email from ${company}.</p>` +
          `<form method="post" action="/u/${escapeHtml(token)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
      );
    },

    async post(c) {
      const key = c.env.UNSUBSCRIBE_SIGNING_KEY;
      if (!isUsableSigningKey(key)) return notConfigured();
      const address = await verifyUnsubscribeToken(c.req.param("token") ?? "", key);
      if (!address) return invalid();
      const now = (options.now ?? (() => new Date()))();
      let result;
      try {
        result = await optOutAddress(c.env.DB, address, { reason: "opt_out", source: "unsubscribe_link", now });
      } catch (error) {
        options.logger?.error("an unsubscribe could not be recorded", { error: sanitizeErrorMessage(error) });
        return respond(500, "Please try again", `<h1>That did not go through</h1><p>Please try the link again in a minute, or reply to the email with the word "unsubscribe".</p>`);
      }
      if (result.failedWrites.length > 0) options.logger?.warn("an unsubscribe was recorded with some bookkeeping missing", { failedWrites: result.failedWrites });
      await notice(c.env, result.emailSha256, `Unsubscribed: ${address}. Suppressed, contact marked opted out, sequences stopped.`);
      return respond(200, "Unsubscribed", `<h1>You are unsubscribed</h1><p>${escapeHtml(address)} will get no more email from ${company}. If you meant to stay in touch, write to ${reply}.</p>`);
    },
  };

  async function notice(env: E, hash: string, text: string): Promise<void> {
    let operator: OperatorChannel | undefined;
    try {
      operator = options.operator?.(env);
    } catch {
      operator = undefined;
    }
    if (!operator) return;
    const eventId = `unsubscribe:${hash}`;
    try {
      if (!(await claimEffect(env.DB, eventId, "operator_notice"))) return;
      if (!(await notifyWithin(operator, text))) await releaseEffect(env.DB, eventId, "operator_notice");
    } catch {
      // Bookkeeping: the opt-out stands without the notice.
    }
  }
}
