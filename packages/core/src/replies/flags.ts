// GTM-agents: the flags reply handling reads, and the thresholds that are part of its contract.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it, and every
// one defaults to off. A flag that cannot be read counts as off.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const REPLY_FLAGS = Object.freeze({
  /** Triage new inbound mail with the triage model and apply the routing side effects. */
  triage: "replies:triage_enabled",
  /** Draft answers with the writer model and ask the operator to approve them. */
  drafting: "replies:drafting_enabled",
  /** Send approved reply drafts from the warm mailbox (the send job and /reply_send). */
  send: "replies:send_enabled",
  /** Mirror reply drafts into the mailbox as real drafts, and reconcile what the operator did with them. */
  mirror: "replies:mirror_enabled",
  /** Remind the operator about replies still owed, and surface quiet threads. */
  reminders: "replies:reminders_enabled",
});

/** Confidence thresholds. Routing reads them; docs/REPLIES.md lists them. */
export const REPLY_THRESHOLDS = Object.freeze({
  /** An opt-out, a decline, or spam, an automatic reply or noise this confident is acted on. */
  confident: 0.8,
  /** Interest, a question or an objection this confident advances the deal. */
  dealAdvance: 0.7,
  /** A question this confident, with approved facts, is filed under reply_question. */
  question: 0.8,
});

/** A boolean flag. Unreadable means off. */
export async function replyFlagOn(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}
