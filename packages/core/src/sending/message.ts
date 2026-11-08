// GTM-agents: the message that leaves: plain text, the postal footer, the RFC 8058 unsubscribe
// headers, threading headers and the correlation tags.
//
//   - From is the cold sender on the isolated sending domain (sending.from) and Reply-To the real
//     mailbox (sending.replyTo), so every reply lands in one inbox.
//   - The body is plain text. The footer is appended here, never by a caller: the postal address
//     from gtm.config.ts and a line saying how to stop (reply "unsubscribe", or open the link).
//   - List-Unsubscribe carries the signed one-click link and a mailto to the reply-to mailbox, and
//     List-Unsubscribe-Post marks the link as one-click (RFC 8058).
//   - In-Reply-To and References are added when threading. Ids that do not look like message ids
//     (no "@", or whitespace, angle brackets or line breaks inside) are left out rather than
//     guessed at, so nothing a caller passes can start another header.
//   - Tags carry contact, campaign, draft, experiment, variant and send ids, so delivery webhooks
//     can be matched to the send. There is no tracking pixel and no link rewriting.
import type { GtmConfig } from "../config/schema.ts";
import type { OutboundMessage } from "../ports/email.ts";
import type { OutreachItem } from "./types.ts";

const MESSAGE_ID = /^<?([^\s<>@"]{1,200}@[^\s<>@"]{1,200})>?$/;
const MAX_REFERENCES = 20;

/** A message id in angle brackets, or null when the value is not a plausible message id. */
export function messageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = MESSAGE_ID.exec(value.trim());
  return match ? `<${match[1]}>` : null;
}

/** The plain-text footer appended to every message. */
export function plainTextFooter(sending: Pick<GtmConfig["sending"], "postalAddress">, link: string): string {
  return `-- \n${sending.postalAddress.trim()}\nTo stop hearing from us, reply "unsubscribe" or open ${link}`;
}

/** The body with the footer appended. */
export function withFooter(body: string, footer: string): string {
  return `${body.replace(/\s+$/, "")}\n\n${footer}`;
}

/** List-Unsubscribe, List-Unsubscribe-Post and, when threading, In-Reply-To and References. */
export function messageHeaders(link: string, replyTo: string, thread: Pick<OutreachItem, "inReplyTo" | "references">): Record<string, string> {
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${link}>, <mailto:${replyTo}?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  const parent = messageId(thread.inReplyTo);
  const references = [...new Set((thread.references ?? []).map(messageId).filter((id): id is string => id !== null))];
  if (parent && !references.includes(parent)) references.push(parent);
  if (parent) headers["In-Reply-To"] = parent;
  if (references.length > 0) headers.References = references.slice(-MAX_REFERENCES).join(" ");
  return headers;
}

/** The correlation tags. Only ids that are set are included. */
export function messageTags(item: OutreachItem, sendId: string): Record<string, string> {
  const tags: Record<string, string> = { send_id: sendId, contact_id: item.contactId, send_path: item.path };
  if (item.campaignId) tags.campaign_id = item.campaignId;
  if (item.draftId) tags.draft_id = item.draftId;
  if (item.experimentId) tags.experiment_id = item.experimentId;
  if (item.experimentArm) tags.variant_id = item.experimentArm;
  if (item.templateId) tags.template_id = item.templateId;
  return tags;
}

// A display name may not hold line breaks, control characters or address syntax.
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const UNSAFE_NAME = /[\x00-\x1f\x7f<>@,;"\\]/;

export interface MessageParts {
  item: OutreachItem;
  /** The normalized recipient address, as the suppression check returned it. */
  to: string;
  sendId: string;
  link: string;
  sending: Pick<GtmConfig["sending"], "from" | "replyTo" | "postalAddress">;
}

/** The outbound message for one item. */
export function buildOutboundMessage(parts: MessageParts): OutboundMessage {
  const { item, sending } = parts;
  const name = item.toName?.trim();
  return {
    effectKey: item.idempotencyKey,
    from: { email: sending.from.email, ...(sending.from.name ? { name: sending.from.name } : {}) },
    to: { email: parts.to, ...(name && name.length <= 80 && !UNSAFE_NAME.test(name) ? { name } : {}) },
    replyTo: sending.replyTo,
    subject: item.subject,
    text: withFooter(item.body, plainTextFooter(sending, parts.link)),
    headers: messageHeaders(parts.link, sending.replyTo, item),
    tags: messageTags(item, parts.sendId),
  };
}
