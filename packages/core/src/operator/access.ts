// GTM-agents: who may command the agent, and whether the operator agent is on.
//
// Authorization belongs to core, not to the channel adapter: the adapter only reports chat and user
// ids. A chat is served only when its chat id is in operator.allowedChatIds AND its user id is in
// operator.allowedUserIds. Either list empty denies everyone, so a fresh deployment answers no one
// until the operator adds their ids. In a private chat with a bot, the chat id and the user id are
// the same number, so the operator lists it in both.
//
// The agent runs only while the operator:agent_enabled flag is on. The flag is a gate: a value that
// cannot be read counts as off.
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

export const AGENT_DISABLED_TEXT = "The operator agent is turned off for this deployment. The operator can turn it on by setting the operator:agent_enabled flag to true.";
