// GTM-agents: the operator-telegram adapter: the OperatorChannel port over the Telegram Bot API.
//
// It translates and decides nothing. Who may command the agent is core's decision (the allowlist in
// gtm.config.ts); this adapter only reports chat and user ids. Specifically:
//   - parseUpdate verifies the X-Telegram-Bot-Api-Secret-Token header against
//     TELEGRAM_WEBHOOK_SECRET in constant time before it reads the body, then maps a text message
//     to a "command" update and a button tap to a "callback" update. Everything else (edits,
//     channel posts, membership changes, messages from bots, forwarded messages) is "ignored";
//   - outgoing text is sent without a parse mode, so nothing in it is interpreted as markup, and
//     link previews are off. Long text is split at line breaks into messages Telegram accepts;
//   - approval buttons carry "<action>:<approvalId>.<digest prefix>" as callback data, the payload
//     format core defines, so a tap returns the digest of the content that was shown. An approval
//     that cannot be shown whole in one message is refused rather than truncated.
//
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET. Options (adapters.operator-telegram.options):
//   chatId      the chat that receives messages core sends without a chat id, such as job pages
//   apiBaseUrl  a self-hosted Bot API server; defaults to https://api.telegram.org
import { constantTimeEqual } from "@gtm-agents/core/http";
import { approvalPayload } from "@gtm-agents/core/operator";
import { AdapterError, type AdapterContext, type AdapterErrorCode, type ApprovalRequest, type OperatorChannel, type OperatorMessage, type OperatorUpdate } from "@gtm-agents/core/ports";

export const TELEGRAM_API = "https://api.telegram.org";
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const MESSAGE_MAX_CHARS = 4096;
export const CALLBACK_DATA_MAX_BYTES = 64;
export const CALLBACK_TEXT_MAX_CHARS = 200;

const ACTION = /^[a-z][a-z0-9_]{0,15}$/;
const CALLBACK_DATA = /^([a-z][a-z0-9_]{0,15}):(.+)$/;
const SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const LABELS: Record<ApprovalRequest["actions"][number], string> = { approve: "Approve", reject: "Reject", edit: "Edit", skip: "Skip", snooze: "Snooze" };
const encoder = new TextEncoder();

interface TelegramReply {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/.test(value)) return value;
  return null;
}

function classify(status: number): { code: AdapterErrorCode; retryable: boolean } {
  if (status === 401 || status === 403 || status === 404) return { code: "auth", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 400) return { code: "invalid", retryable: false };
  if (status >= 500) return { code: "unavailable", retryable: true };
  return { code: "unknown", retryable: false };
}

/** Split text into pieces Telegram accepts, preferring line breaks and never splitting a surrogate pair. */
export function splitText(text: string, max = MESSAGE_MAX_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.length ? text : "(empty)";
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}

function keyboard(buttons: OperatorMessage["buttons"]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => {
        if (!ACTION.test(b.action)) throw new AdapterError(`operator-telegram: button action "${b.action}" must be a short lowercase word`, "invalid", false);
        const data = `${b.action}:${b.payload}`;
        if (encoder.encode(data).length > CALLBACK_DATA_MAX_BYTES) throw new AdapterError("operator-telegram: a button payload is longer than Telegram allows", "invalid", false);
        return { text: b.label.slice(0, 64), callback_data: data };
      }),
    ),
  };
}

export function createAdapter(ctx: AdapterContext): OperatorChannel {
  const rawBase = ctx.options.apiBaseUrl;
  if (rawBase !== undefined && (typeof rawBase !== "string" || !URL.canParse(rawBase) || new URL(rawBase).protocol !== "https:")) {
    throw new AdapterError("operator-telegram: apiBaseUrl must be an https URL", "invalid", false);
  }
  const base = typeof rawBase === "string" ? rawBase.replace(/\/+$/, "") : TELEGRAM_API;
  const defaultChat = idString(ctx.options.chatId);

  const target = (chatId: string | undefined): string => {
    const chat = chatId !== undefined ? idString(chatId) : defaultChat;
    if (!chat) throw new AdapterError("operator-telegram: no chat to deliver to; pass a chat id or set adapters.operator-telegram.options.chatId", "invalid", false);
    return chat;
  };

  async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const token = ctx.optionalSecret("TELEGRAM_BOT_TOKEN");
    if (!token) throw new AdapterError("operator-telegram: TELEGRAM_BOT_TOKEN is not set; set it with wrangler secret put", "auth", false);
    let response: Response;
    try {
      response = await ctx.fetch(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch (error) {
      // The request URL holds the token, so the underlying error message is never repeated here.
      const timeout = error instanceof Error && error.name === "TimeoutError";
      throw new AdapterError(`telegram ${method} ${timeout ? "timed out" : "could not be reached"}`, timeout ? "timeout" : "unavailable", true);
    }
    let reply: TelegramReply = {};
    try {
      reply = await response.json<TelegramReply>();
    } catch {
      // Handled below by the status.
    }
    if (response.ok && reply.ok === true) return reply.result;
    const status = typeof reply.error_code === "number" ? reply.error_code : response.status;
    const { code, retryable } = classify(status);
    const after = reply.parameters?.retry_after;
    const description = typeof reply.description === "string" ? reply.description.slice(0, 160) : "";
    throw new AdapterError(`telegram ${method} failed with ${status}${description ? `: ${description}` : ""}`, code, retryable, typeof after === "number" ? { retryAfterMs: after * 1000 } : {});
  }

  async function send(chatId: string, text: string, markup: ReturnType<typeof keyboard>, silent: boolean): Promise<string> {
    const result = await call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(silent ? { disable_notification: true } : {}),
      ...(markup ? { reply_markup: markup } : {}),
    });
    const id = isObject(result) ? idString(result.message_id) : null;
    if (!id) throw new AdapterError("telegram sendMessage returned no message id", "unknown", false);
    return id;
  }

  return {
    name: "telegram",

    async notify(message) {
      const chat = target(message.chatId);
      const markup = keyboard(message.buttons);
      const parts = splitText(message.text);
      let last = "";
      for (const [i, part] of parts.entries()) last = await send(chat, part, i === parts.length - 1 ? markup : undefined, message.silent === true);
      return { messageId: last };
    },

    async requestApproval(req) {
      const text = `${req.summary}\n\n${req.preview}`;
      // An approval binds to the whole content, so the operator must see all of it in one message.
      if (text.length > MESSAGE_MAX_CHARS) throw new AdapterError("operator-telegram: the approval does not fit in one message, so it was not sent", "invalid", false);
      const payload = approvalPayload(req.approvalId, req.digest);
      const markup = keyboard([req.actions.map((action) => ({ label: LABELS[action], action, payload }))]);
      return { messageId: await send(target(req.chatId), text, markup, false) };
    },

    async editMessage(messageId, message) {
      const id = Number(messageId);
      if (!Number.isSafeInteger(id)) throw new AdapterError("operator-telegram: message ids are numbers", "invalid", false);
      const text = message.text.length > MESSAGE_MAX_CHARS ? `${message.text.slice(0, MESSAGE_MAX_CHARS - 3)}...` : message.text;
      try {
        await call("editMessageText", {
          chat_id: target(message.chatId),
          message_id: id,
          text: text || "(empty)",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(message.buttons) ?? { inline_keyboard: [] },
        });
      } catch (error) {
        // Editing a message to the text it already has is not a failure.
        if (error instanceof AdapterError && /message is not modified/i.test(error.message)) return;
        throw error;
      }
    },

    async acknowledgeCallback(callbackId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text: text.slice(0, CALLBACK_TEXT_MAX_CHARS) } : {}) });
    },

    async parseUpdate(request) {
      const expected = ctx.optionalSecret("TELEGRAM_WEBHOOK_SECRET");
      if (!expected) throw new AdapterError("operator-telegram: TELEGRAM_WEBHOOK_SECRET is not set, so updates cannot be verified", "unavailable", false);
      // Verified before the body is read.
      const provided = request.headers.get(SECRET_HEADER) ?? "";
      if (!(await constantTimeEqual(provided, expected))) throw new AdapterError("operator-telegram: the webhook secret token does not match", "auth", false);

      let update: unknown;
      try {
        update = await request.json();
      } catch {
        return { type: "ignored", reason: "the update is not JSON" };
      }
      if (!isObject(update)) return { type: "ignored", reason: "the update is not an object" };

      if (isObject(update.message)) {
        const m = update.message;
        const chat = isObject(m.chat) ? idString(m.chat.id) : null;
        const from = isObject(m.from) ? m.from : null;
        const user = from ? idString(from.id) : null;
        const messageId = idString(m.message_id);
        if (!chat || !user || !messageId) return { type: "ignored", reason: "the message has no chat, sender or id" };
        if (from?.is_bot === true) return { type: "ignored", reason: "the message is from a bot" };
        // A forwarded message, or one sent through an inline bot, is someone else's text, not an
        // operator instruction.
        if (m.forward_origin !== undefined || m.forward_from !== undefined || m.forward_date !== undefined || m.via_bot !== undefined) {
          return { type: "ignored", reason: "forwarded and inline-bot messages are not instructions" };
        }
        if (typeof m.text !== "string" || m.text.trim() === "") return { type: "ignored", reason: "the message has no text" };
        return { type: "command", chatId: chat, userId: user, text: m.text, messageId } satisfies OperatorUpdate;
      }

      if (isObject(update.callback_query)) {
        const q = update.callback_query;
        const message = isObject(q.message) ? q.message : null;
        const chat = message && isObject(message.chat) ? idString(message.chat.id) : null;
        const messageId = message ? idString(message.message_id) : null;
        const user = isObject(q.from) ? idString(q.from.id) : null;
        const callbackId = typeof q.id === "string" && q.id.length > 0 && q.id.length <= 128 ? q.id : null;
        if (!chat || !messageId || !user || !callbackId) return { type: "ignored", reason: "the button tap has no chat, message, sender or id" };
        const data = typeof q.data === "string" ? CALLBACK_DATA.exec(q.data) : null;
        if (!data) return { type: "ignored", reason: "the button carries no recognizable data" };
        return { type: "callback", chatId: chat, userId: user, action: data[1] ?? "", payload: data[2] ?? "", messageId, callbackId } satisfies OperatorUpdate;
      }

      return { type: "ignored", reason: "this kind of update is not handled" };
    },

    async registerWebhook(url) {
      if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new AdapterError("operator-telegram: the webhook URL must be https", "invalid", false);
      const secret = ctx.optionalSecret("TELEGRAM_WEBHOOK_SECRET");
      if (!secret || !SECRET_TOKEN.test(secret)) {
        throw new AdapterError("operator-telegram: TELEGRAM_WEBHOOK_SECRET must be set to 1 to 256 letters, digits, underscores or hyphens", "invalid", false);
      }
      await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"] });
    },
  };
}
