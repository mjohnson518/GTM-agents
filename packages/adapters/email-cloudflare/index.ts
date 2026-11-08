// GTM-agents: the email-cloudflare adapter: an inbound-only InboxProvider for Cloudflare Email
// Routing.
//
// Email Routing hands the Worker's email() handler each message sent to a routed address. This
// adapter turns that raw message into an InboundMessage with postal-mime; core's email() entry
// point (createWorker's inboundEmail option) records it through the same intake as polled mail.
//   - the sender is the From header's mailbox (the envelope sender when From has none);
//   - the provider message id is the Message-ID header, or a SHA-256 of the raw message when there
//     is none, so a redelivered message is recognized either way;
//   - the thread id is the first message id in References, else In-Reply-To, else the message's own
//     id: Email Routing has no threads, and the root of the chain groups a conversation;
//   - the body is the text/plain part, or text derived from the HTML part (htmlToText); the
//     machine-readable parts of a delivery status notification (message/delivery-status,
//     text/rfc822-headers, the returned message's header block) become its delivery report;
//   - headers are reduced to the triage set with lowercase keys; receivedAt is when the message
//     arrived, not its Date header, which the sender writes.
// Email Routing only receives, so listNew, getThread and the draft methods throw
// AdapterError("invalid", not retryable) saying so, send returns the same refusal as an outcome,
// and its capabilities say threads, drafts and send are all unavailable.
// Core treats that refusal as "this provider does not list mail" and keeps running its pending
// pass. The manifest declares the one capability, "inbound".
//
// No secrets. Options (adapters.email-cloudflare.options):
//   ownAddresses   addresses whose mail counts as the deployment's own (isFromUs)
//   maxBytes       the largest message parsed, default 25 MiB (Email Routing's own limit)
import { htmlToText, parseMessageIds, pickInboundHeaders, type RoutedEmail, type RoutedEmailParser } from "@gtm-agents/core/inbox";
import { AdapterError, type AdapterContext, type InboundMessage, type InboxProvider, type SendOutcome } from "@gtm-agents/core/ports";
import PostalMime, { type Address, type Attachment } from "postal-mime";

export const NAME = "email-cloudflare";
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** The longest delivery report kept, in characters. */
export const MAX_REPORT_CHARS = 32_000;
/** The longest body kept, in characters. Core keeps less. */
export const MAX_TEXT_CHARS = 200_000;

/** An InboxProvider that also parses what Email Routing delivers. */
export interface EmailRoutingInbox extends InboxProvider, RoutedEmailParser {}

const unsupported = (method: string) => new AdapterError(`${NAME} receives mail through Email Routing only; ${method} is not supported`, "invalid", false);

function mailboxOf(address: Address | undefined): { email: string; name?: string } | null {
  if (!address) return null;
  if (address.group !== undefined) {
    const first = address.group[0];
    return first ? { email: first.address, ...(first.name ? { name: first.name } : {}) } : null;
  }
  return address.address ? { email: address.address, ...(address.name ? { name: address.name } : {}) } : null;
}

function addressesOf(list: Address[] | undefined): string[] {
  const out: string[] = [];
  for (const address of list ?? []) {
    if (address.group !== undefined) for (const member of address.group) out.push(member.address);
    else if (address.address) out.push(address.address);
  }
  return out.filter((a) => a.includes("@")).slice(0, 100);
}

function attachmentText(attachment: Attachment): string {
  const content = attachment.content;
  if (typeof content === "string") return attachment.encoding === "base64" ? new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0))) : content;
  return new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
}

/** The text of a delivery report's machine-readable parts, or undefined. */
function deliveryReportOf(attachments: readonly Attachment[]): string | undefined {
  const parts: string[] = [];
  for (const attachment of attachments) {
    const type = attachment.mimeType.toLowerCase();
    if (type === "message/delivery-status" || type === "message/global-delivery-status" || type === "text/rfc822-headers") parts.push(attachmentText(attachment));
    else if (type === "message/rfc822" || type === "message/global") parts.push(attachmentText(attachment).split(/\r?\n\r?\n/)[0] ?? "");
  }
  const joined = parts.join("\n\n").replace(/\r\n?/g, "\n").slice(0, MAX_REPORT_CHARS);
  return joined.trim() ? joined : undefined;
}

async function rawBytes(raw: RoutedEmail["raw"]): Promise<ArrayBuffer | string> {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) return raw.slice().buffer;
  return new Response(raw).arrayBuffer();
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAdapter(ctx: AdapterContext): EmailRoutingInbox {
  const own = new Set(
    (Array.isArray(ctx.options.ownAddresses) ? ctx.options.ownAddresses : []).filter((a): a is string => typeof a === "string").map((a) => a.trim().toLowerCase()),
  );
  const maxBytes = typeof ctx.options.maxBytes === "number" && Number.isInteger(ctx.options.maxBytes) && ctx.options.maxBytes > 0 ? ctx.options.maxBytes : DEFAULT_MAX_BYTES;

  return {
    name: NAME,
    capabilities: { threads: false, drafts: false, send: false },

    async parseRouted(message: RoutedEmail): Promise<InboundMessage> {
      if (typeof message.rawSize === "number" && message.rawSize > maxBytes) throw new AdapterError(`the routed message is larger than ${maxBytes} bytes`, "invalid", false);
      const raw = await rawBytes(message.raw);
      const size = typeof raw === "string" ? raw.length : raw.byteLength;
      if (size > maxBytes) throw new AdapterError(`the routed message is larger than ${maxBytes} bytes`, "invalid", false);
      let email: Awaited<ReturnType<typeof PostalMime.parse>>;
      try {
        email = await PostalMime.parse(raw, { forceRfc822Attachments: true, attachmentEncoding: "arraybuffer" });
      } catch (error) {
        throw new AdapterError("the routed message could not be parsed as MIME", "invalid", false, { cause: error });
      }
      const headers = pickInboundHeaders(email.headers.map((h) => [h.key, h.value] as const));
      const from = mailboxOf(email.from) ?? { email: message.from };
      const ownIds = parseMessageIds(email.messageId);
      const inReplyTo = parseMessageIds(email.inReplyTo)[0];
      const references = parseMessageIds(email.references);
      const providerMessageId = ownIds[0] ?? `sha256:${await sha256Hex(raw)}`;
      const cc = addressesOf(email.cc);
      const report = deliveryReportOf(email.attachments);
      const text = (email.text ?? (email.html ? htmlToText(email.html) : "")).replace(/\r\n?/g, "\n").slice(0, MAX_TEXT_CHARS);
      const envelopeTo = typeof message.to === "string" && message.to.includes("@") ? [message.to] : [];
      const to = addressesOf(email.to);
      return {
        providerMessageId,
        threadId: references[0] ?? inReplyTo ?? providerMessageId,
        from,
        to: to.length > 0 ? to : envelopeTo,
        ...(cc.length > 0 ? { cc } : {}),
        subject: (email.subject ?? "").replace(/[\r\n]+/g, " ").trim(),
        text,
        receivedAt: ctx.now().toISOString(),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references.length > 0 ? { references } : {}),
        headers,
        isFromUs: own.has(from.email.trim().toLowerCase()),
        ...(report ? { deliveryReport: report } : {}),
      };
    },

    listNew() {
      return Promise.reject(unsupported("listNew"));
    },
    getThread() {
      return Promise.reject(unsupported("getThread"));
    },
    createDraft() {
      return Promise.reject(unsupported("createDraft"));
    },
    updateDraft() {
      return Promise.reject(unsupported("updateDraft"));
    },
    deleteDraft() {
      return Promise.reject(unsupported("deleteDraft"));
    },
    send(message): Promise<SendOutcome> {
      return Promise.resolve({ effectKey: message.effectKey, ok: false, code: "invalid", retryable: false, detail: unsupported("send").message });
    },
  };
}
