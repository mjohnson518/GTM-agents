// GTM-agents: who may command the agent, and whether the operator agent is on.
//
// Authorization belongs to core, not to the channel adapter: the adapter only reports chat and user
// ids. A chat is served only when its chat id is in operator.allowedChatIds AND its user id is in
// operator.allowedUserIds. Either list empty denies everyone, so a fresh deployment answers no one
// until the operator adds their ids. In a private chat with a bot, the chat id and the user id are
// the same number, so the operator lists it in both.
//
// The agent runs only while the operator:agent_enabled flag is on. The flag is a gate: a value that
// cannot be read counts as off. operator:chat_batching decides whether messages sent in a row share
// one turn (chat.ts); a value that cannot be read counts as off there too. operator:timers_enabled
// offers timer_set and lets due timers fire (operator/timers.ts), and operator:notes_enabled offers
// note_save and notes_read and loads saved notes into turns (agents/notes.ts), and
// operator:outbox_enabled holds and paces notices (operator/outbox.ts); unreadable, each is off.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { isFlagOn } from "../jobs/loop.ts";

export const AGENT_FLAG = "operator:agent_enabled";

export function isAllowedOperator(operator: GtmConfig["operator"], chatId: string, userId: string): boolean {
  if (typeof chatId !== "string" || typeof userId !== "string" || chatId === "" || userId === "") return false;
  return operator.allowedChatIds.includes(chatId) && operator.allowedUserIds.includes(userId);
}

/** True only when the flag reads as on. A read error or an unset flag is off. */
export async function isAgentEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(AGENT_FLAG));
  } catch {
    return false;
  }
}

export const CHAT_BATCHING_FLAG = "operator:chat_batching";

/**
 * True only when the flag reads as on. Merging is not a gate, so off is the conservative side: a read
 * error or an unset flag means one turn per message, as without the flag.
 */
export async function isChatBatchingEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(CHAT_BATCHING_FLAG));
  } catch {
    return false;
  }
}

export const TIMERS_FLAG = "operator:timers_enabled";

/**
 * True only when the flag reads as on. Timers are a capability: a read error or an unset flag means
 * timer_set is not offered and no timer fires.
 */
export async function isTimersEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(TIMERS_FLAG));
  } catch {
    return false;
  }
}

export const NOTES_FLAG = "operator:notes_enabled";

/** True only when the flag reads as on. A read error or an unset flag means no notes are read or saved. */
export async function isNotesEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(NOTES_FLAG));
  } catch {
    return false;
  }
}

export const OUTBOX_FLAG = "operator:outbox_enabled";

/**
 * True only when the flag reads as on. The outbox only delays and folds notices, so off is the
 * conservative side: a read error or an unset flag sends every message straight to the channel.
 */
export async function isOutboxEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(OUTBOX_FLAG));
  } catch {
    return false;
  }
}

export const AGENT_DISABLED_TEXT = "The operator agent is turned off for this deployment. The operator can turn it on by setting the operator:agent_enabled flag to true.";
