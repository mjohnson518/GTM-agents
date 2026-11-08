// GTM-agents: operator chat commands. A message that starts with "/" is a command and never reaches
// the model; anything else is a task for the hub agent.
//
//   /clean   delete this chat's history and reset its taint, in one batch
//   /status  the session's taint and size, drafts waiting for approval, today's chat spend
//   /help    what the agent can do and how sessions, taint and approvals work (also /start)
//
// One command does not start with "/": `batch-release-<id>-<code>` releases a cold batch that waits
// for the operator (outreach/release.ts). It never reaches the model either; the chat consumer routes
// it to runReleaseCommand before anything else.
import { clearSession, loadSession } from "../agents/sessions.ts";
import { CHAT_JOB } from "../agents/hub.ts";
import type { KVReader } from "../brain/load.ts";
import { microCentsToCents } from "../budget/cost-ledger.ts";
import { spentMicroCents } from "../budget/gate.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { releaseBatch, type ReleaseCommand } from "../outreach/release.ts";
import type { SendOutreach } from "../sending/types.ts";
import { startOfUtcDay } from "../shared/kv.ts";

export { parseReleaseCommand } from "../outreach/release.ts";

export interface ParsedCommand {
  name: string;
  args: string;
}

/** The command in a message, or null when the message is not a command. "/Clean@SomeBot now" gives { name: "clean", args: "now" }. */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

export function helpText(agentName: string, domain = "your-prospect.example"): string {
  return [
    `${agentName} commands:`,
    "/clean  start a clean session (clears this chat's history and taint)",
    "/status  session taint, drafts waiting for approval, today's chat spend",
    "/help  this message",
    "batch-release-<id>-<code>  send a cold batch that waits for you (the batch message carries the exact command)",
    "",
    `Anything else is a task, for example: look at https://${domain}/pricing and summarize it, or draft a short intro to someone@${domain} with the facts you want used.`,
    "",
    "Drafts come back as approval requests. Approving marks a draft approved; nothing is sent by the tap. The only thing this chat sends is a cold batch you release with its batch-release command, and every draft in it is checked again first.",
    "",
    "Sessions and taint: once a session has read a web page, it cannot create drafts, because the page could carry instructions. You get the research back. To draft from it, send /clean and then give me the facts you want me to use.",
  ].join("\n");
}

export interface CommandDeps {
  db: D1Database;
  agentName: string;
  strategistModel: string | undefined;
  now?: () => Date;
}

/** Run a command and return the reply text. Throws on a database error; the caller reports it. */
export async function runCommand(deps: CommandDeps, command: ParsedCommand, session: { sessionKey: string; chatId: string }): Promise<string> {
  const now = deps.now?.() ?? new Date();
  switch (command.name) {
    case "clean":
      await clearSession(deps.db, session.sessionKey, session.chatId, now);
      return "Started a clean session. This chat's history and taint are cleared.";
    case "help":
    case "start":
      return helpText(deps.agentName);
    case "status": {
      const state = await loadSession(deps.db, session.sessionKey, session.chatId, now);
      const [pending, spent] = await Promise.all([
        deps.db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending_approval'").first<{ n: number }>(),
        spentMicroCents(deps.db, { since: startOfUtcDay(now), job: CHAT_JOB }),
      ]);
      const cents = microCentsToCents(spent);
      return [
        `Session taint: ${state.taint}${state.taint === "full" ? " (drafting is refused until /clean)" : ""}`,
        `Messages in history: ${state.messageCount}`,
        `Drafts waiting for approval: ${Number(pending?.n ?? 0)}`,
        `Chat spend today: $${(cents / 100).toFixed(2)}`,
        `Strategist model: ${deps.strategistModel ?? "not configured"}`,
      ].join("\n");
    }
    default:
      return `Unknown command /${command.name}. Send /help for the list.`;
  }
}

export interface ReleaseCommandDeps {
  db: D1Database;
  flags: FlagReader;
  /** The KV namespace holding the brain. */
  kv: KVReader | undefined;
  /** The send function. Undefined when the deployment has not wired one. */
  send: SendOutreach | undefined;
  config: Pick<GtmConfig, "sequences">;
  /** The operator's user id, recorded as who approved the batch. */
  userId: string;
  now?: () => Date;
}

/** Run `batch-release-<id>-<code>` and return the reply text. Throws on a database error; the caller reports it. */
export async function runReleaseCommand(deps: ReleaseCommandDeps, command: ReleaseCommand): Promise<string> {
  if (!deps.send) return "No send function is configured for this deployment, so nothing was released.";
  const result = await releaseBatch(
    { db: deps.db, flags: deps.flags, kv: deps.kv, send: deps.send, config: deps.config, actor: `operator:${deps.userId}`, ...(deps.now ? { now: deps.now } : {}) },
    command,
  );
  return result.text;
}
