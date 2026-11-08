// GTM-agents: contract and behavior tests for the operator-telegram adapter, against recorded,
// synthetic Bot API responses. The chat ids, people and tokens are invented; nothing reaches the network.
import { AdapterError } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { runOperatorChannelContract, type ContractCallback, type ContractMessage } from "../_contract/operator-channel.ts";
import { CALLBACK_DATA_MAX_BYTES, SECRET_HEADER, createAdapter, splitText } from "./index.ts";
import manifest from "./manifest.json";

const TOKEN = "test-bot-token";
const SECRET = "test-webhook-secret";
const SECRETS = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET };
const API = `https://api.telegram.org/bot${TOKEN}`;
const WEBHOOK = "https://agent.acme.example/api/webhooks/operator";

let nextMessageId = 500;
function botRoutes(): RecordedRoute[] {
  return [
    { method: "POST", url: `${API}/sendMessage`, respond: () => json({ ok: true, result: { message_id: (nextMessageId += 1), chat: { id: 100200300 } } }) },
    { method: "POST", url: `${API}/editMessageText`, respond: () => json({ ok: true, result: true }) },
    { method: "POST", url: `${API}/answerCallbackQuery`, respond: () => json({ ok: true, result: true }) },
    { method: "POST", url: `${API}/setWebhook`, respond: () => json({ ok: true, result: true }) },
  ];
}

function context(options: Record<string, unknown> = {}, secrets: Record<string, string> = SECRETS, routes: RecordedRoute[] = botRoutes()) {
  const recorded = recordedFetch(routes);
  return { ctx: testContext({ secrets, fetch: recorded.fetch, options }), calls: recorded.calls };
}

function webhook(update: unknown, secret?: string): Request {
  return new Request(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret !== undefined ? { [SECRET_HEADER]: secret } : {}) },
    body: JSON.stringify(update),
  });
}

function messageUpdate(m: ContractMessage, extra: Record<string, unknown> = {}): unknown {
  return {
    update_id: 9001,
    message: { message_id: Number(m.messageId), from: { id: Number(m.userId), is_bot: false, first_name: "Riley" }, chat: { id: Number(m.chatId), type: "private" }, date: 1793000000, text: m.text, ...extra },
  };
}

function callbackUpdate(c: ContractCallback): unknown {
  return { update_id: 9002, callback_query: { id: c.callbackId, from: { id: Number(c.userId), is_bot: false }, message: { message_id: Number(c.messageId), chat: { id: Number(c.chatId) } }, data: c.data } };
}

async function sentBody(request: Request): Promise<Record<string, unknown>> {
  return await request.clone().json<Record<string, unknown>>();
}

runOperatorChannelContract((ctx) => createAdapter(ctx), {
  chatId: "100200300",
  context: () => context(),
  signedMessage: (m) => webhook(messageUpdate(m), SECRET),
  tamperedMessage: (m) => webhook(messageUpdate(m), "not-the-webhook-secret"),
  unsignedMessage: (m) => webhook(messageUpdate(m)),
  signedUnsupported: () => webhook({ update_id: 9003, edited_message: { message_id: 41, chat: { id: 100200300 }, from: { id: 100200300 }, text: "edited" } }, SECRET),
  signedCallback: (c) => webhook(callbackUpdate(c), SECRET),
  async buttonsSent(request) {
    const markup = (await sentBody(request)).reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((b) => ({ label: b.text, data: b.callback_data }));
  },
  async textSent(request) {
    const body = await sentBody(request);
    return typeof body.text === "string" ? { text: body.text, markup: "parse_mode" in body } : null;
  },
});

describe("operator-telegram", () => {
  it("declares its port, secrets, flag and webhook in its manifest", () => {
    expect(manifest.ports).toEqual(["OperatorChannel"]);
    expect(manifest.requiredSecrets).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);
    expect(manifest.webhook).toEqual({ path: "/api/webhooks/operator", signature: "telegram-secret-token" });
  });

  it("cannot verify updates while its webhook secret is unset, and says so as unavailable", async () => {
    const { ctx } = context({}, { TELEGRAM_BOT_TOKEN: TOKEN });
    const update = webhook(messageUpdate({ chatId: "1", userId: "1", messageId: "1", text: "hi" }), "");
    await expect(createAdapter(ctx).parseUpdate(update)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("ignores messages from bots, forwarded messages, messages without text and taps with unrecognizable data", async () => {
    const channel = createAdapter(context().ctx);
    const m = { chatId: "100200300", userId: "100200300", messageId: "42", text: "hello" };
    expect(await channel.parseUpdate(webhook(messageUpdate(m, { from: { id: 5, is_bot: true } }), SECRET))).toMatchObject({ type: "ignored" });
    expect(await channel.parseUpdate(webhook(messageUpdate({ ...m, text: "" }), SECRET))).toMatchObject({ type: "ignored" });
    expect(await channel.parseUpdate(webhook(messageUpdate(m, { forward_origin: { type: "user", date: 1793000000 } }), SECRET))).toMatchObject({ type: "ignored" });
    expect(await channel.parseUpdate(webhook(messageUpdate(m, { via_bot: { id: 7, is_bot: true } }), SECRET))).toMatchObject({ type: "ignored" });
    expect(await channel.parseUpdate(webhook(callbackUpdate({ ...m, callbackId: "cb-9", data: "no separator" }), SECRET))).toMatchObject({ type: "ignored" });
    expect(await channel.parseUpdate(new Request(WEBHOOK, { method: "POST", headers: { [SECRET_HEADER]: SECRET }, body: "{not json" }))).toMatchObject({ type: "ignored" });
  });

  it("splits long text at line breaks and puts buttons on the last message only", async () => {
    const { ctx, calls } = context();
    const line = `${"x".repeat(99)}\n`;
    await createAdapter(ctx).notify({ text: line.repeat(60), chatId: "100200300", buttons: [[{ label: "Help", action: "help", payload: "1" }]] });
    expect(calls).toHaveLength(2);
    const [first, second] = await Promise.all(calls.map(sentBody));
    expect((first?.text as string).length).toBeLessThanOrEqual(4096);
    expect(first).not.toHaveProperty("reply_markup");
    expect(second?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Help", callback_data: "help:1" }]] });
    expect(splitText("a".repeat(5000)).every((p) => p.length <= 4096)).toBe(true);
  });

  it("sends to the default chat only when one is configured", async () => {
    const configured = context({ chatId: "-100555" });
    await createAdapter(configured.ctx).notify({ text: "Job failed" });
    expect((await sentBody(configured.calls[0] as Request)).chat_id).toBe("-100555");
    await expect(createAdapter(context().ctx).notify({ text: "Job failed" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses an approval that does not fit in one message instead of truncating it", async () => {
    const { ctx, calls } = context();
    const digest = "a".repeat(64);
    const request = createAdapter(ctx).requestApproval({ approvalId: "dr_long", chatId: "100200300", kind: "send", digest, summary: "Approve?", preview: "y".repeat(5000), actions: ["approve"] });
    await expect(request).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a button whose data would not fit Telegram's callback limit", async () => {
    const channel = createAdapter(context().ctx);
    const payload = "p".repeat(CALLBACK_DATA_MAX_BYTES);
    await expect(channel.notify({ text: "x", chatId: "1", buttons: [[{ label: "Go", action: "go", payload }]] })).rejects.toMatchObject({ code: "invalid" });
  });

  it("registers its webhook with the secret token and only the updates it handles", async () => {
    const { ctx, calls } = context();
    const channel = createAdapter(ctx);
    await channel.registerWebhook(WEBHOOK);
    expect(await sentBody(calls[0] as Request)).toEqual({ url: WEBHOOK, secret_token: SECRET, allowed_updates: ["message", "callback_query"] });
    await expect(channel.registerWebhook("http://agent.acme.example/api/webhooks/operator")).rejects.toMatchObject({ code: "invalid" });
  });

  it("maps Bot API errors to AdapterError codes and keeps the bot token out of every message", async () => {
    const limited = context({}, SECRETS, [{ url: `${API}/sendMessage`, respond: () => json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }, { status: 429 }) }]);
    await expect(createAdapter(limited.ctx).notify({ text: "x", chatId: "1" })).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 7000 });
    const unauthorized = context({}, SECRETS, [{ url: `${API}/sendMessage`, respond: () => json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 }) }]);
    await expect(createAdapter(unauthorized.ctx).notify({ text: "x", chatId: "1" })).rejects.toMatchObject({ code: "auth", retryable: false });
    const down = testContext({ secrets: SECRETS, fetch: () => Promise.reject(new TypeError(`fetch failed for ${API}/sendMessage`)) });
    const error = await createAdapter(down)
      .notify({ text: "x", chatId: "1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).message).not.toContain(TOKEN);
  });

  it("treats an edit to the same text as success", async () => {
    const { ctx } = context({}, SECRETS, [{ url: `${API}/editMessageText`, respond: () => json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 }) }]);
    await expect(createAdapter(ctx).editMessage("5", { text: "same", chatId: "1" })).resolves.toBeUndefined();
  });
});
