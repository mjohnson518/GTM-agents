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
//
// Sequence commands (sequences/commands.ts) do not start with "/" either, and never reach the model:
// `sequence-release-<id>-<code>` sends follow-ups a sweep put up for release,
// `sequence-resume-<contact id>` resumes a paused sequence, and `channel-done-<id> [linkedin|x]` and
// `channel-skip-<id>` answer a manual touch. The chat consumer routes them to runSequenceCommand.
//
// Reply commands (replies/commands.ts) start with "/" and never reach the model: /replies lists what
// is owed, /reply_done and /reply_ignore settle a message, /reply_send sends an approved reply, and
// /reply_draft shows a pending reply draft again. The chat consumer routes them to runReplyCommand.
//
// Report commands (reports/commands.ts) start with "/", only read, and never reach the model:
// /scorecard shows the daily scorecard as of now, and /report conversion|funnel|cost|holdout shows
// the other reports. The chat consumer routes them to runReportCommand.
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
// Sequences: the follow-up release, resume and manual-touch commands.
export { parseSequenceCommand, runSequenceCommand, type SequenceCommand, type SequenceCommandDeps } from "../sequences/commands.ts";
// Replies: list and settle owed replies, and send approved ones.
export { REPLY_COMMAND_NAMES, REPLY_HELP_LINES, isReplyCommand, runReplyCommand, type ReplyCommandDeps } from "../replies/commands.ts";
import { REPLY_HELP_LINES } from "../replies/commands.ts";
// Reports: the scorecard and the other reports on demand, read-only.
export { REPORT_COMMAND_NAMES, REPORT_HELP_LINES, isReportCommand, runReportCommand, type ReportCommandDeps } from "../reports/commands.ts";
import { REPORT_HELP_LINES } from "../reports/commands.ts";

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
    "sequence-release-<id>-<code>  send follow-ups that wait for you (the follow-up message carries the exact command)",
    "sequence-resume-<contact id>  resume a contact's paused follow-up sequence",
    "channel-done-<id> [linkedin|x] / channel-skip-<id>  answer a manual touch before the last follow-up",
    ...REPLY_HELP_LINES,
    ...REPORT_HELP_LINES,
    "",
    `Anything else is a task, for example: look at https://${domain}/pricing and summarize it, or draft a short intro to someone@${domain} with the facts you want used.`,
    "",
    "Drafts come back as approval requests. Approving marks a draft approved; nothing is sent by the tap. The only things this chat sends are a cold batch or follow-ups you release with their release commands, and every draft in them is checked again first. Reply drafts are the exception: an approved reply goes out from your mailbox (when replies:send_enabled is on), after checking the thread still waits for it.",
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
