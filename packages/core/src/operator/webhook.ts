// GTM-agents: POST /api/webhooks/operator, where the operator channel delivers updates.
//
// In order, and nothing touches the database before step 2 passes:
//   1. the operator channel must be configured, or the route answers 503;
//   2. the channel adapter verifies the update (for Telegram, the secret-token header, compared in
//      constant time) and normalizes it. A bad signature answers 401; a channel that cannot verify
//      (its secret is unset) answers 503;
//   3. the sender must be allowlisted: chat id in operator.allowedChatIds and user id in
//      operator.allowedUserIds. Anyone else gets 200 and no reply at all, so the bot does not
//      reveal itself and the channel does not retry;
//   4. the update is claimed in the effects ledger, so a redelivered update is handled once;
//   5. with the operator:agent_enabled flag off, the operator is told the agent is disabled;
//   6. a message is rate limited per chat and queued on CHAT_QUEUE, and the route answers at once.
//      An approval tap is handled inline, because it is quick and the channel expects an answer.
import type { Context } from "hono";
import { sessionKeyFor } from "../agents/sessions.ts";
import type { ChatMessage, Env } from "../env.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { OperatorUpdate } from "../ports/operator.ts";
import { checkRateLimit } from "../security/rate-limiter.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { AGENT_DISABLED_TEXT, isAgentEnabled, isAllowedOperator } from "./access.ts";
import { handleApprovalCallback } from "./approvals.ts";
import { flagsFromKv, processChatMessage, resolveChannel, type OperatorAgentOptions } from "./chat.ts";

export const OPERATOR_WEBHOOK_PATH = "/api/webhooks/operator";
export const OPERATOR_UPDATE_EFFECT = "operator_update";

/** The effects-ledger key for an update: unique per chat message or per button tap. */
export function updateKey(update: Exclude<OperatorUpdate, { type: "ignored" }>): string {
  return update.type === "command" ? `operator:${update.chatId}:${update.messageId}` : `operator:callback:${update.callbackId}`;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

export function createOperatorWebhook<E extends Env>(options: OperatorAgentOptions<E>): (c: Context<{ Bindings: E }>) => Promise<Response> {
  const log = options.logger;
  return async (c) => {
    const env = c.env;
    const channel = resolveChannel(options.operator, env);
    if (!channel) return c.json({ error: "operator_channel_not_configured" }, 503);

    let update: OperatorUpdate;
    try {
      update = await channel.parseUpdate(c.req.raw);
    } catch (error) {
      const code = errorCode(error);
      if (code === "auth") return c.json({ error: "unauthorized" }, 401);
      if (code === "invalid") return c.json({ error: "invalid_update" }, 400);
      log?.warn("operator update could not be verified", { error: sanitizeErrorMessage(error) });
      return c.json({ error: "verification_unavailable" }, 503);
    }
    if (update.type === "ignored") return c.json({ ok: true });

    if (!isAllowedOperator(options.config.operator, update.chatId, update.userId)) {
      log?.warn("operator update from a chat that is not allowlisted was ignored", { chatId: update.chatId, userId: update.userId });
      return c.json({ ok: true });
    }

    const key = updateKey(update);
    let first: boolean;
    try {
      first = await claimEffect(env.DB, key, OPERATOR_UPDATE_EFFECT);
    } catch (error) {
      // The ledger is a gate: if it cannot be written, the update is not handled now, and the
      // channel delivers it again later.
      log?.error("operator update could not be claimed", { error: sanitizeErrorMessage(error) });
      return c.json({ error: "unavailable" }, 503);
    }
    if (!first) return c.json({ ok: true, duplicate: true });

    if (!(await isAgentEnabled(flagsFromKv(env.KV)))) {
      try {
        if (update.type === "callback") await channel.acknowledgeCallback(update.callbackId, "The operator agent is turned off.");
        else await channel.notify({ text: AGENT_DISABLED_TEXT, chatId: update.chatId });
      } catch (error) {
        log?.warn("disabled notice could not be sent", { error: sanitizeErrorMessage(error) });
      }
      return c.json({ ok: true, disabled: true });
    }

    if (update.type === "callback") {
      try {
        await handleApprovalCallback({ db: env.DB, shown: env.KV, operator: channel, ...(options.now ? { now: options.now } : {}), ...(log ? { logger: log } : {}) }, update);
      } catch (error) {
        log?.error("approval callback failed", { error: sanitizeErrorMessage(error) });
        try {
          await channel.acknowledgeCallback(update.callbackId, "That could not be completed. Nothing was approved.");
        } catch {
          // The operator sees no answer; the tap changed nothing.
        }
      }
      return c.json({ ok: true });
    }

    // Rate limits are bookkeeping and fail open; they stop a runaway loop, not a determined sender.
    const limit = await checkRateLimit(env.KV, "chat", update.chatId);
    if (!limit.allowed) {
      try {
        await channel.notify({ text: `Too many messages. Try again in ${limit.retryAfterSeconds ?? 60} seconds.`, chatId: update.chatId });
      } catch {
        // Nothing else to do.
      }
      return c.json({ ok: true, rateLimited: true });
    }

    const message: ChatMessage = { updateId: key, chatId: update.chatId, userId: update.userId, messageId: update.messageId, sessionKey: sessionKeyFor(update.chatId), text: update.text };
    if (env.CHAT_QUEUE) {
      try {
        await env.CHAT_QUEUE.send(message);
      } catch (error) {
        // Not queued, so not handled: release the claim and let the channel deliver it again.
        await releaseEffect(env.DB, key, OPERATOR_UPDATE_EFFECT);
        log?.error("operator message could not be queued", { error: sanitizeErrorMessage(error) });
        return c.json({ error: "unavailable" }, 503);
      }
      return c.json({ ok: true, queued: true });
    }
    // No queue bound (local development): handle it after answering, within the request's lifetime.
    const work = processChatMessage(options, env, message);
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work;
    }
    return c.json({ ok: true, queued: false });
  };
}
