// GTM-agents: is an approved reply still the right one to send?
//
// By the time a person approves a reply, the thread may have moved on. Before sending, every check
// below must pass; any failure refuses the send, and so does any error reading the mailbox (the
// check fails closed):
//   1. the text is exactly what the operator was shown (wasShown);
//   2. no mailbox draft exists for the message, mirrored or started by hand on the thread (the
//      operator sends that one from the mailbox);
//   3. no newer human message arrived on the thread or from the sender (database), and none is on
//      the thread in the mailbox. Automatic replies, bounces and spam do not count;
//   4. no message was sent on the thread after the one being answered. A message from the mailbox
//      that the adapter does not mark as sent or as a draft is treated like a draft: refused, with
//      no change to the reply's state.
// Reads only: nothing here changes a row.
import type { InboxProvider, InboundMessage } from "../ports/email.ts";
import { wasShown, type DraftContent, type ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { mailboxCan, ownMessageKind } from "./mailbox.ts";
import type { InboundRow } from "./rows.ts";

export type FreshnessRefusal = "not_shown" | "mailbox_draft" | "newer_message" | "already_answered" | "unverifiable";

export type Freshness = { ok: true } | { ok: false; reason: FreshnessRefusal; message: string };

const refuse = (reason: FreshnessRefusal, message: string): Freshness => ({ ok: false, reason, message });

/** True for a message a machine sent: Auto-Submitted (other than "no"), autoresponder headers, bulk precedence. */
export function isAutomatic(headers: Record<string, string> | undefined): boolean {
  const h = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase().trim()]));
  const auto = h.get("auto-submitted");
  if (auto !== undefined && auto !== "no") return true;
  if (h.has("x-autoreply") || h.has("x-autorespond") || h.has("x-auto-response-suppress")) return true;
  const precedence = h.get("precedence");
  return precedence === "auto_reply" || precedence === "bulk" || precedence === "junk" || precedence === "list";
}

const time = (iso: string | null | undefined) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? at : Number.NaN;
};

export async function checkFreshness(
  deps: { db: D1Database; shown: ShownStore; inbox: InboxProvider | undefined },
  input: { draftId: string; content: DraftContent; inbound: InboundRow },
): Promise<Freshness> {
  const { inbound } = input;
  if (!(await wasShown(deps.shown, input.draftId, input.content))) {
    return refuse("not_shown", "the text differs from what you were shown (or that record has expired); it goes back to you for approval.");
  }
  if (inbound.provider_draft_id !== null) {
    return refuse("mailbox_draft", "this reply is in your mailbox's drafts; send it from the mailbox, and it is recorded as answered.");
  }
  let newer: { id: string } | null;
  try {
    newer = await deps.db
      .prepare(
        `SELECT id FROM inbound_emails
          WHERE id <> ?1 AND received_at > ?2
            AND ((?3 IS NOT NULL AND provider_thread_id = ?3) OR lower(sender_email) = lower(?4))
            AND COALESCE(classification, '') NOT IN ('auto_reply', 'out_of_office', 'bounce', 'spam')
            AND COALESCE(intent, '') NOT IN ('auto_reply', 'spam', 'noise')
          LIMIT 1`,
      )
      .bind(inbound.id, inbound.received_at, inbound.provider_thread_id, inbound.sender_email)
      .first<{ id: string }>();
  } catch (error) {
    return refuse("unverifiable", `newer mail could not be checked (${sanitizeErrorMessage(error)}); nothing was sent.`);
  }
  if (newer) return refuse("newer_message", "they wrote again after this message, so this draft answers an older one; the newer message gets its own draft.");
  if (!mailboxCan(deps.inbox, "threads")) return refuse("unverifiable", "no mailbox is connected that can read the thread; nothing was sent.");
  if (!inbound.provider_thread_id) return refuse("unverifiable", "the message has no mailbox thread to check or to reply on; nothing was sent.");
  let thread: InboundMessage[];
  try {
    thread = await deps.inbox.getThread(inbound.provider_thread_id);
  } catch (error) {
    return refuse("unverifiable", `the mailbox thread could not be read (${sanitizeErrorMessage(error)}); nothing was sent.`);
  }
  if (!Array.isArray(thread)) return refuse("unverifiable", "the mailbox returned no thread; nothing was sent.");
  const own = thread.find((m) => m.providerMessageId === inbound.provider_message_id);
  const since = Math.max(time(inbound.received_at), time(own?.receivedAt));
  if (!Number.isFinite(since)) return refuse("unverifiable", "the message's time could not be read; nothing was sent.");
  for (const m of thread) {
    if (m.providerMessageId === inbound.provider_message_id) continue;
    const at = time(m.receivedAt);
    if (!Number.isFinite(at)) return refuse("unverifiable", "a message on the thread has a time that could not be read; nothing was sent.");
    if (at <= since) continue;
    if (m.isFromUs) {
      const kind = ownMessageKind(m);
      if (kind === "sent") return refuse("already_answered", "a message was already sent on this thread after theirs; nothing was sent.");
      // A draft, or a message the mailbox does not say was sent: the reply belongs in the mailbox.
      return refuse(
        "mailbox_draft",
        kind === "draft"
          ? "a draft from your mailbox is on this thread; finish and send it there, and it is recorded as answered."
          : "a message from your mailbox (sent or still a draft) is on this thread after theirs; nothing was sent. Finish it in the mailbox, then /reply_done if it went out.",
      );
    }
    if (!isAutomatic(m.headers)) return refuse("newer_message", "a newer message from them is on the thread; nothing was sent.");
  }
  return { ok: true };
}
