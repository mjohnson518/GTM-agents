// GTM-agents: the inbox-gmail adapter: the InboxProvider port over the Gmail API, with no SDK.
//
// It translates and decides nothing; core records, classifies and acts. Specifically:
//   - listNew with a cursor ("h:<historyId>") reads users.history.list for messages added under any
//     label since then (a reply filtered to spam or archived before the poll still counts), up to
//     five pages. It asks core which ids it already holds before fetching
//     any message, skips sent copies and drafts, and returns at most `limit` messages. When it stops
//     early the cursor points just before the first message it did not return, and `more` is set;
//     otherwise the cursor is the mailbox's latest history id. A cursor Gmail no longer accepts
//     (history ids last about a week) falls back to the window below, with `reset` set;
//   - listNew without a cursor reads the mailbox's current history id first (so nothing arriving
//     meanwhile is skipped), then lists messages received since `since` in any folder but sent,
//     drafts, trash and chats (in:anywhere -in:sent -in:drafts -in:trash -in:chats after:<epoch
//     seconds>, newest first, up to scanLimit ids) and fetches the unknown ones. The sweep uses
//     this form. A message the mailbox no longer has is left out; any other fetch failure throws;
//   - messages are fetched with format=full and decoded from Gmail's structured payload (mime.ts):
//     text/plain preferred, else text from text/html, charsets honored, a delivery report for
//     bounces. Headers are reduced to the triage set with lowercase keys. isFromUs is set for the
//     SENT and DRAFT labels and for mail from the configured mailbox address;
//   - getThread reads users.threads.get; createDraft, updateDraft and deleteDraft write plain-text
//     drafts on the thread with In-Reply-To and References (updateDraft keeps the draft's
//     recipient, subject and threading and replaces its text; deleting a draft that is already gone
//     succeeds); send posts users.messages.send on the thread and returns a SendOutcome, never
//     throwing. Core claims the effect key first; the adapter derives the message's Message-ID from
//     it, so a resend of the same effect carries the same id;
//   - draftExists reads a draft and answers false once it is gone; capabilities says threads,
//     drafts and send all work;
//   - watch registers users.watch on the inbox to the Pub/Sub topic. It exists only when a topic is
//     configured, so core can tell "push not configured" from a failure;
//   - every call goes through ctx.fetch with a Google access token (_google-auth); a 401 refreshes
//     the token once. Errors are typed AdapterErrors: 400 invalid, 401 and 403 auth (403 rate
//     limits are rate_limited), 404 not_found, 429 rate_limited, 5xx unavailable, and a dropped
//     connection timeout.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (granted the gmail.modify
// scope), and optionally GMAIL_PUBSUB_TOPIC.
// Options (adapters.inbox-gmail.options):
//   address        the mailbox's own address, so mail from it counts as ours
//   pubsubTopic    projects/<project>/topics/<topic>, instead of the GMAIL_PUBSUB_TOPIC secret
//   userId         defaults to "me", the account the refresh token belongs to
//   scanLimit      message ids a window listing reads, 1 to 500 (default 200)
//   apiBaseUrl     defaults to https://gmail.googleapis.com/gmail/v1
import { AdapterError, type AdapterContext, type AdapterErrorCode, type InboundMessage, type InboxProvider, type OutboundMessage, type SendOutcome } from "@gtm-agents/core/ports";
import { parseMessageIds, pickInboundHeaders } from "@gtm-agents/core/inbox";
import { createGoogleAuth } from "../_google-auth/index.ts";
import { buildRawMessage, decodeEncodedWords, decodePayload, headerValue, isPlainAddress, parseAddressList, parseMailbox, type GmailHeader, type GmailPart } from "./mime.ts";

export const NAME = "inbox-gmail";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const REFRESH_TOKEN_NAME = "GMAIL_REFRESH_TOKEN";
export const PUBSUB_TOPIC_NAME = "GMAIL_PUBSUB_TOPIC";
/** History pages read per listNew call. */
export const HISTORY_MAX_PAGES = 5;
/** Messages fetched at once. */
const FETCH_CONCURRENCY = 5;
const DEFAULT_SCAN_LIMIT = 200;
const SKIPPED_LABELS: ReadonlySet<string> = new Set(["SENT", "DRAFT", "TRASH", "CHAT"]);

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

interface Options {
  baseUrl: string;
  userId: string;
  address: string | null;
  topic: string | null;
  scanLimit: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function readOptions(ctx: AdapterContext): Options {
  const raw = ctx.options;
  const base = typeof raw.apiBaseUrl === "string" && /^https:\/\/[^/\s]+/.test(raw.apiBaseUrl) ? raw.apiBaseUrl.replace(/\/+$/, "") : GMAIL_API;
  const userId = typeof raw.userId === "string" && /^[A-Za-z0-9._%+@-]{1,254}$/.test(raw.userId) ? raw.userId : "me";
  const address = typeof raw.address === "string" && isPlainAddress(raw.address) ? raw.address.toLowerCase() : null;
  const topicRaw = str(raw.pubsubTopic) ?? ctx.optionalSecret(PUBSUB_TOPIC_NAME);
  const topic = topicRaw && /^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/.test(topicRaw) ? topicRaw : null;
  const scan = typeof raw.scanLimit === "number" && Number.isInteger(raw.scanLimit) && raw.scanLimit >= 1 && raw.scanLimit <= 500 ? raw.scanLimit : DEFAULT_SCAN_LIMIT;
  return { baseUrl: base, userId, address, topic, scanLimit: scan };
}

/** The AdapterError for a Gmail API error response. */
export async function gmailError(response: Response, what: string): Promise<AdapterError> {
  let reason = "";
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    const first = Array.isArray(error.errors) && isRecord(error.errors[0]) ? error.errors[0] : {};
    const candidate = str(first.reason) ?? str(error.status) ?? "";
    reason = /^[A-Za-z_]{1,60}$/.test(candidate) ? candidate : "";
  } catch {
    // No reason.
  }
  const detail = `${what} failed with HTTP ${response.status}${reason ? ` (${reason})` : ""}`;
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const opts = retryAfterMs !== undefined ? { retryAfterMs } : {};
  if (response.status === 400) return new AdapterError(detail, "invalid", false);
  if (response.status === 401) return new AdapterError(detail, "auth", false);
  if (response.status === 403) {
    if (/ratelimit/i.test(reason)) return new AdapterError(detail, "rate_limited", true, opts);
    if (/dailylimit|quota/i.test(reason)) return new AdapterError(detail, "quota", true, opts);
    return new AdapterError(detail, "auth", false);
  }
  if (response.status === 404) return new AdapterError(detail, "not_found", false);
  if (response.status === 429) return new AdapterError(detail, "rate_limited", true, opts);
  if (response.status >= 500) return new AdapterError(detail, "unavailable", true, opts);
  return new AdapterError(detail, "unknown", false);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cursor a listing resumes from, or null when it is not one this adapter wrote. */
export function parseCursor(cursor: string | undefined): bigint | null {
  if (typeof cursor !== "string") return null;
  const match = /^h:(\d{1,30})$/.exec(cursor);
  return match ? BigInt(match[1] ?? "0") : null;
}

const cursorOf = (historyId: bigint | string): string => `h:${historyId.toString()}`;

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export function createAdapter(ctx: AdapterContext): InboxProvider {
  const options = readOptions(ctx);
  const auth = createGoogleAuth(ctx, { refreshTokenName: REFRESH_TOKEN_NAME });
  const userPath = `${options.baseUrl}/users/${encodeURIComponent(options.userId)}`;

  async function call(path: string, what: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<Response> {
    const token = await auth.accessToken();
    let response: Response;
    try {
      response = await ctx.fetch(`${userPath}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      throw new AdapterError(`${what} failed before an answer arrived`, "timeout", true, { cause: error });
    }
    if (response.status === 401 && !retried) {
      auth.invalidate();
      return call(path, what, init, true);
    }
    if (!response.ok) throw await gmailError(response, what);
    return response;
  }

  async function json(path: string, what: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
    const response = await call(path, what, init);
    try {
      const body: unknown = await response.json();
      return isRecord(body) ? body : {};
    } catch {
      throw new AdapterError(`${what} answered with something other than JSON`, "unknown", true);
    }
  }

  // A part Gmail no longer has is skipped; it never makes the whole message look deleted.
  const fetchAttachment = (messageId: string) => async (attachmentId: string): Promise<string | null> => {
    try {
      const body = await json(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, "attachment read");
      return str(body.data) ?? null;
    } catch (error) {
      if (error instanceof AdapterError && error.code === "not_found") return null;
      throw error;
    }
  };

  async function toInbound(message: GmailMessage): Promise<InboundMessage> {
    const headers: GmailHeader[] = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
    const triage = pickInboundHeaders(headers.filter((h) => typeof h?.name === "string" && typeof h.value === "string").map((h) => [h.name, h.value] as const));
    const from = parseMailbox(headerValue(headers, "From") ?? "");
    const decoded = await decodePayload(message.payload, fetchAttachment(message.id));
    const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
    const internal = Number(message.internalDate);
    const dateHeader = Date.parse(headerValue(headers, "Date") ?? "");
    const receivedAt = Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : Number.isFinite(dateHeader) ? new Date(dateHeader).toISOString() : ctx.now().toISOString();
    const inReplyTo = parseMessageIds(headerValue(headers, "In-Reply-To"))[0];
    const references = parseMessageIds(headerValue(headers, "References"));
    const cc = parseAddressList(headerValue(headers, "Cc"));
    return {
      providerMessageId: message.id,
      threadId: message.threadId ?? message.id,
      from,
      to: parseAddressList(headerValue(headers, "To")),
      ...(cc.length > 0 ? { cc } : {}),
      subject: decodeEncodedWords(headerValue(headers, "Subject") ?? "").replace(/[\r\n]+/g, " ").trim(),
      text: decoded.text,
      receivedAt,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
      headers: triage,
      isFromUs: labels.includes("SENT") || labels.includes("DRAFT") || (options.address !== null && from.email.toLowerCase() === options.address),
      isDraft: labels.includes("DRAFT"),
      ...(decoded.deliveryReport ? { deliveryReport: decoded.deliveryReport } : {}),
    };
  }

  /** Fetch full messages; a message deleted since it was listed is left out. */
  async function fetchMessages(ids: readonly string[]): Promise<InboundMessage[]> {
    const fetched = await inBatches(ids, FETCH_CONCURRENCY, async (id) => {
      let body: Record<string, unknown>;
      try {
        body = await json(`/messages/${encodeURIComponent(id)}?format=full`, "message read");
      } catch (error) {
        // Only the message read itself saying "gone" drops a message; any other failure throws, so
        // the cursor does not move past it.
        if (error instanceof AdapterError && error.code === "not_found") return null;
        throw error;
      }
      if (typeof body.id !== "string") return null;
      return toInbound(body as unknown as GmailMessage);
    });
    return fetched.filter((m): m is InboundMessage => m !== null).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async function unknownOf(ids: readonly string[], known: ((ids: readonly string[]) => Promise<ReadonlySet<string>>) | undefined): Promise<Set<string>> {
    if (!known || ids.length === 0) return new Set(ids);
    let held: ReadonlySet<string>;
    try {
      held = await known(ids);
    } catch {
      held = new Set();
    }
    return new Set(ids.filter((id) => !held.has(id)));
  }

  async function fromHistory(start: bigint, limit: number, known: Parameters<InboxProvider["listNew"]>[0]["known"]): Promise<Awaited<ReturnType<InboxProvider["listNew"]>>> {
    // Every message added, in history order, with the history record that added it.
    const entries: Array<{ record: bigint; id: string }> = [];
    const seen = new Set<string>();
    let latest = start;
    let lastRecord = start;
    let pageToken: string | undefined;
    let pages = 0;
    do {
      // Every label, not just the inbox: a reply filtered to spam, archived or skipped past the inbox
      // still counts. Sent copies, drafts, trash and chat are left out below.
      const params = new URLSearchParams({ startHistoryId: start.toString(), historyTypes: "messageAdded", maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const body = await json(`/history?${params.toString()}`, "history list");
      pages += 1;
      const historyId = str(body.historyId);
      if (historyId && /^\d+$/.test(historyId)) latest = BigInt(historyId);
      for (const record of Array.isArray(body.history) ? body.history : []) {
        if (!isRecord(record) || typeof record.id !== "string" || !/^\d+$/.test(record.id)) continue;
        const recordId = BigInt(record.id);
        lastRecord = recordId;
        for (const added of Array.isArray(record.messagesAdded) ? record.messagesAdded : []) {
          const message = isRecord(added) && isRecord(added.message) ? added.message : null;
          if (!message || typeof message.id !== "string" || seen.has(message.id)) continue;
          seen.add(message.id);
          const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
          // Sent copies and drafts are ours, and trash and chat are not mail; none is fetched.
          if (labels.some((l) => SKIPPED_LABELS.has(String(l)))) continue;
          entries.push({ record: recordId, id: message.id });
        }
      }
      pageToken = str(body.nextPageToken);
    } while (pageToken && pages < HISTORY_MAX_PAGES);

    const unknown = await unknownOf(entries.map((e) => e.id), known);
    const wanted = entries.filter((e) => unknown.has(e.id));
    const taken = wanted.slice(0, limit);
    const cut = wanted[limit];
    let cursor: string;
    let more = false;
    if (cut) {
      // Resume just before the record holding the first message not returned.
      cursor = cursorOf(cut.record - 1n);
      more = true;
    } else if (pageToken) {
      // Pages remain: resume after the last record read.
      cursor = cursorOf(lastRecord);
      more = true;
    } else {
      cursor = cursorOf(latest > lastRecord ? latest : lastRecord);
    }
    const items = await fetchMessages(taken.map((e) => e.id));
    return { items, cursor, ...(more ? { more } : {}) };
  }

  async function fromWindow(since: string | undefined, limit: number, known: Parameters<InboxProvider["listNew"]>[0]["known"], reset: boolean): Promise<Awaited<ReturnType<InboxProvider["listNew"]>>> {
    // The position first, so mail arriving while the window is listed is not skipped.
    const profile = await json("/profile", "profile read");
    const historyId = str(profile.historyId);
    const sinceMs = since ? Date.parse(since) : NaN;
    const query = ["in:anywhere", "-in:sent", "-in:drafts", "-in:trash", "-in:chats", ...(Number.isFinite(sinceMs) ? [`after:${Math.floor(sinceMs / 1000)}`] : [])].join(" ");
    const params = new URLSearchParams({ q: query, maxResults: String(options.scanLimit) });
    const body = await json(`/messages?${params.toString()}`, "message list");
    const ids = (Array.isArray(body.messages) ? body.messages : []).map((m) => (isRecord(m) ? str(m.id) : undefined)).filter((id): id is string => id !== undefined);
    const unknown = [...(await unknownOf(ids, known))];
    const items = await fetchMessages(unknown.slice(0, limit));
    return {
      items,
      ...(historyId && /^\d+$/.test(historyId) ? { cursor: cursorOf(historyId) } : {}),
      ...(unknown.length > limit ? { more: true } : {}),
      ...(reset ? { reset: true } : {}),
    };
  }

  const refuse = (m: OutboundMessage, code: AdapterErrorCode, retryable: boolean, detail: string): SendOutcome => ({ effectKey: m.effectKey, ok: false, code, retryable, detail });

  const provider: InboxProvider = {
    name: NAME,
    capabilities: { threads: true, drafts: true, send: true },

    async draftExists(draftId) {
      try {
        await call(`/drafts/${encodeURIComponent(draftId)}?format=minimal`, "draft read");
        return true;
      } catch (error) {
        if (error instanceof AdapterError && error.code === "not_found") return false;
        throw error;
      }
    },

    async listNew(args) {
      const limit = Math.max(1, Math.min(Number.isInteger(args.limit) ? args.limit : 25, 100));
      const start = parseCursor(args.cursor);
      if (start !== null) {
        try {
          return await fromHistory(start, limit, args.known);
        } catch (error) {
          // Gmail answers 404 for a history id it no longer keeps: list the window instead.
          if (!(error instanceof AdapterError && error.code === "not_found")) throw error;
          return fromWindow(args.since, limit, args.known, true);
        }
      }
      return fromWindow(args.since, limit, args.known, args.cursor !== undefined);
    },

    async getThread(threadId) {
      const body = await json(`/threads/${encodeURIComponent(threadId)}?format=full`, "thread read");
      const messages = (Array.isArray(body.messages) ? body.messages : []).filter((m): m is GmailMessage => isRecord(m) && typeof m.id === "string");
      const out: InboundMessage[] = [];
      for (const message of messages) out.push(await toInbound(message));
      return out;
    },

    async createDraft(draft) {
      let raw: string;
      try {
        raw = buildRawMessage({ to: draft.to, subject: draft.subject, text: draft.text, ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}), ...(draft.references ? { references: draft.references } : {}) });
      } catch (error) {
        throw new AdapterError("the draft cannot be built: its recipient is not one plain address", "invalid", false, { cause: error });
      }
      const body = await json("/drafts", "draft create", { method: "POST", body: { message: { raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } } });
      const draftId = str(body.id);
      if (!draftId) throw new AdapterError("the draft create answer held no draft id", "unknown", false);
      return { draftId };
    },

    async updateDraft(draftId, text) {
      const current = await json(`/drafts/${encodeURIComponent(draftId)}?format=full`, "draft read");
      const message = isRecord(current.message) ? (current.message as unknown as GmailMessage) : null;
      const headers = message?.payload?.headers ?? [];
      const to = parseAddressList(headerValue(headers, "To"))[0];
      if (!message || !to) throw new AdapterError("the draft has no recipient to keep", "invalid", false);
      const inReplyTo = parseMessageIds(headerValue(headers, "In-Reply-To"))[0];
      const raw = buildRawMessage({
        to,
        cc: parseAddressList(headerValue(headers, "Cc")),
        subject: decodeEncodedWords(headerValue(headers, "Subject") ?? ""),
        text,
        ...(inReplyTo ? { inReplyTo } : {}),
        references: parseMessageIds(headerValue(headers, "References")),
      });
      await json(`/drafts/${encodeURIComponent(draftId)}`, "draft update", { method: "PUT", body: { id: draftId, message: { raw, ...(message.threadId ? { threadId: message.threadId } : {}) } } });
    },

    async deleteDraft(draftId) {
      try {
        await call(`/drafts/${encodeURIComponent(draftId)}`, "draft delete", { method: "DELETE" });
      } catch (error) {
        if (error instanceof AdapterError && error.code === "not_found") return;
        throw error;
      }
    },

    async send(message) {
      const headerOf = (name: string) => Object.entries(message.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
      const fromDomain = message.from.email.slice(message.from.email.lastIndexOf("@") + 1).toLowerCase();
      let raw: string;
      try {
        const inReplyTo = headerOf("in-reply-to");
        raw = buildRawMessage({
          from: message.from,
          to: message.to.email,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          subject: message.subject,
          text: message.text,
          ...(inReplyTo ? { inReplyTo } : {}),
          references: parseMessageIds(headerOf("references")),
          messageId: `<${(await sha256Hex(message.effectKey)).slice(0, 40)}@${fromDomain}>`,
          headers: message.headers ?? {},
        });
      } catch {
        return refuse(message, "invalid", false, "the sender or recipient is not one plain address");
      }
      try {
        const body = await json("/messages/send", "send", { method: "POST", body: { raw, ...(message.threadId ? { threadId: message.threadId } : {}) } });
        const id = str(body.id);
        return id ? { effectKey: message.effectKey, ok: true, providerMessageId: id } : refuse(message, "unknown", false, "the send answer held no message id");
      } catch (error) {
        if (!(error instanceof AdapterError)) return refuse(message, "unknown", false, "the send failed unexpectedly");
        // A server error may come after Gmail accepted the message: report it as unknown, so core
        // keeps its claim rather than send twice.
        const code: AdapterErrorCode = error.code === "unavailable" ? "unknown" : error.code;
        return refuse(message, code, error.retryable, error.message.slice(0, 200));
      }
    },
  };

  if (options.topic) {
    const topic = options.topic;
    provider.watch = async () => {
      const body = await json("/watch", "watch", { method: "POST", body: { topicName: topic, labelIds: ["INBOX"] } });
      const expiration = Number(body.expiration);
      if (!Number.isFinite(expiration) || expiration <= 0) throw new AdapterError("the watch answer held no expiration", "unknown", true);
      return { expiresAt: new Date(expiration).toISOString() };
    };
  }
  return provider;
}
