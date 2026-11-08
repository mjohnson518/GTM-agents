// GTM-agents: threading follow-ups under the first email.
//
// Every step after the first goes out as a reply in the same conversation:
//   - the subject is "Re: " and the first email's subject (with any reply prefixes it already had
//     removed first), so clients that group by subject agree with the headers;
//   - In-Reply-To is the Message-ID of the latest earlier step, and References lists the Message-ID
//     of every earlier step in order (the first email's, then step 2's for step 3, and so on).
// The Message-ID is the RFC 5322 id the provider actually sent each email with. Providers may
// replace one set by the sender, so it is looked up from the provider (EmailProvider.getMessageId)
// the first time a later step needs it and stored on the send ledger (outreach_sends.message_id),
// so it is fetched once. A step whose earlier Message-IDs cannot all be found is not sent unthreaded:
// it is held and stays due for the next sweep.
import type { JobLogger } from "../jobs/registry.ts";
import type { EmailProvider } from "../ports/email.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { messageId } from "../sending/message.ts";
import type { PriorSend } from "./rows.ts";

const REPLY_PREFIX = /^\s*(?:(?:re|aw|sv|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** A subject without its leading reply prefixes ("Re:", "RE: Re:", "AW:"). */
export function stripReplyPrefix(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").trim();
}

/** The subject of every follow-up: "Re: " and the first email's subject. */
export function followUpSubject(firstSubject: string): string {
  return `Re: ${stripReplyPrefix(firstSubject)}`;
}

export interface Thread {
  inReplyTo: string;
  references: string[];
}

/**
 * The threading headers for the next step, from the earlier steps (sorted by step), or null when any
 * earlier step has no known Message-ID. Pure.
 */
export function threadFor(sends: readonly PriorSend[]): Thread | null {
  if (sends.length === 0) return null;
  const ids: string[] = [];
  for (const send of sends) {
    const id = messageId(send.message_id);
    if (!id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  const last = ids.at(-1);
  return last ? { inReplyTo: last, references: ids } : null;
}

export interface LookupBudget {
  /** Provider lookups still allowed in this run. */
  remaining: number;
}

export type LookupMiss = "no_lookup" | "other_provider" | "no_provider_id" | "budget" | "not_found" | "failed";

/**
 * Fill in the Message-ID of each earlier send that lacks one, from the provider, and store what it
 * finds on the ledger. Mutates `sends` in place and returns why any send is still missing one.
 * Never throws: a failed lookup leaves the send without a Message-ID, and a failed write is logged
 * (the id is still used for this run).
 */
export async function resolveMessageIds(
  db: D1Database,
  provider: EmailProvider | undefined,
  sends: PriorSend[],
  budget: LookupBudget,
  log?: JobLogger,
): Promise<Map<string, LookupMiss>> {
  const misses = new Map<string, LookupMiss>();
  for (const send of sends) {
    if (messageId(send.message_id)) continue;
    if (!provider?.getMessageId) {
      misses.set(send.id, "no_lookup");
      continue;
    }
    if (send.provider !== provider.name) {
      misses.set(send.id, "other_provider");
      continue;
    }
    if (!send.provider_message_id) {
      misses.set(send.id, "no_provider_id");
      continue;
    }
    if (budget.remaining <= 0) {
      misses.set(send.id, "budget");
      continue;
    }
    budget.remaining -= 1;
    let found: string | null;
    try {
      found = messageId(await provider.getMessageId(send.provider_message_id));
    } catch (error) {
      log?.warn("a Message-ID lookup failed; the step waits for the next sweep", { sendId: send.id, error: sanitizeErrorMessage(error) });
      misses.set(send.id, "failed");
      continue;
    }
    if (!found) {
      misses.set(send.id, "not_found");
      continue;
    }
    send.message_id = found;
    try {
      await db.prepare("UPDATE outreach_sends SET message_id = ?2 WHERE id = ?1 AND message_id IS NULL").bind(send.id, found).run();
    } catch (error) {
      log?.warn("a Message-ID could not be stored; it will be looked up again", { sendId: send.id, error: sanitizeErrorMessage(error) });
    }
  }
  return misses;
}
