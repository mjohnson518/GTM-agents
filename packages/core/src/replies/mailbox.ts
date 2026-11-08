// GTM-agents: what the connected mailbox can do, for reply handling.
//
// Some inbox adapters only receive mail (Cloudflare Email Routing records inbound messages and can
// neither read a thread back, create a draft nor send). An adapter says so with an optional
// `capabilities` object ({ threads, drafts, send }, each true unless set to false); reply handling
// then skips mirroring and sending cleanly instead of failing on every run. An adapter may also
// offer `draftExists(draftId)`, which lets mirroring tell a discarded mailbox draft from one still
// waiting. Both are optional: an adapter without them is treated as able to do everything the
// InboxProvider port lists, and without `draftExists` mirroring relies on the thread alone.
//
// A thread read can return the mailbox's own drafts as well as its sent mail, both marked isFromUs.
// An adapter that sets `isDraft` on each message lets reply handling tell them apart. Without it, a
// message from the mailbox is "unknown": never taken as proof that a reply was sent, and never
// recorded as evidence either way.
import type { InboundMessage, InboxProvider } from "../ports/email.ts";

export type MailboxCapability = "threads" | "drafts" | "send";

interface MailboxExtras {
  capabilities?: Partial<Record<MailboxCapability, boolean>>;
  draftExists?: (draftId: string) => Promise<boolean>;
}

/** True when a mailbox is connected and does not say it lacks `what`. */
export function mailboxCan(inbox: InboxProvider | undefined | null, what: MailboxCapability): inbox is InboxProvider {
  if (!inbox) return false;
  const extras = inbox as InboxProvider & MailboxExtras;
  return extras.capabilities?.[what] !== false;
}

export type OwnMessageKind = "sent" | "draft" | "unknown";

/** What a message from the mailbox is: sent, a draft, or unknown when the adapter does not say. */
export function ownMessageKind(message: InboundMessage): OwnMessageKind {
  const flag = (message as InboundMessage & { isDraft?: unknown }).isDraft;
  return flag === true ? "draft" : flag === false ? "sent" : "unknown";
}

const at = (iso: string | null | undefined) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : Number.NaN;
};

/**
 * The mailbox's own messages on a thread after the message `providerMessageId` (received at
 * `receivedAt`), oldest first, each with its kind. Messages with a time that does not parse are
 * returned with a NaN time, so a caller can fail closed on them.
 */
export function ownMessagesAfter(thread: readonly InboundMessage[], providerMessageId: string, receivedAt: string): Array<{ message: InboundMessage; kind: OwnMessageKind; time: number }> {
  const own = thread.find((m) => m.providerMessageId === providerMessageId);
  const since = Math.max(at(receivedAt), at(own?.receivedAt));
  return thread
    .filter((m) => m.isFromUs && m.providerMessageId !== providerMessageId)
    .map((m) => ({ message: m, kind: ownMessageKind(m), time: at(m.receivedAt) }))
    .filter((m) => !(m.time <= since))
    .sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity));
}

/** Whether a mailbox draft still exists: true, false, or null when the mailbox cannot tell. Throws on a read error. */
export async function mailboxDraftExists(inbox: InboxProvider, draftId: string): Promise<boolean | null> {
  const extras = inbox as InboxProvider & MailboxExtras;
  if (typeof extras.draftExists !== "function") return null;
  return (await extras.draftExists(draftId)) === true;
}
