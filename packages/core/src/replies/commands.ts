// GTM-agents: operator commands for replies. They never reach the model.
//
//   /replies               what is owed: messages waiting on a person, oldest first
//   /reply_done <id>       mark a message answered by hand (when you replied from your mail client,
//                          or the mailbox cannot be mirrored or send)
//   /reply_ignore <id>     mark a message as needing no answer
//   /reply_send <draft>    send an approved reply now, with every freshness check and send gate
//   /reply_draft <id>      show a message's pending draft again, as an approval request here
//
// An <id> is an inbound message id, or a unique prefix of at least 6 characters among the messages
// owed. Approve and Reject are the buttons on each approval request (operator/approvals.ts).
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { requestDraftApproval } from "../operator/approvals.ts";
import type { InboxProvider } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import type { KvStore } from "../shared/kv.ts";
import { closeReplyEvidence } from "./evidence.ts";
import { REPLY_FLAGS, replyFlagOn } from "./flags.ts";
import { describeSend } from "./outbox.ts";
import { OWED_SQL, waitedFor } from "./owed.ts";
import { daysAgo } from "./rows.ts";
import { sendApprovedReply } from "./send.ts";
import { senderLabel } from "./text.ts";

export const REPLY_COMMAND_NAMES = ["replies", "reply_done", "reply_ignore", "reply_send", "reply_draft"] as const;

export function isReplyCommand(name: string): boolean {
  return (REPLY_COMMAND_NAMES as readonly string[]).includes(name);
}

/** Lines for /help. */
export const REPLY_HELP_LINES: readonly string[] = Object.freeze([
  "/replies  replies waiting on you",
  "/reply_done <id>  mark a reply answered by hand",
  "/reply_ignore <id>  mark a message as needing no answer",
  "/reply_send <draft id>  send an approved reply now",
  "/reply_draft <id>  show a message's pending draft again for approval",
]);

export interface ReplyCommandDeps {
  db: D1Database;
  kv: KvStore | undefined | null;
  shown: ShownStore;
  flags: FlagReader;
  config: GtmConfig;
  operator: OperatorChannel;
  inbox?: InboxProvider;
  unsubscribeSigningKey: string | undefined;
  baseUrl: string | undefined;
  now?: () => Date;
  log?: JobLogger;
}

const ID = /^[A-Za-z0-9_-]{6,100}$/;
const LIST_LIMIT = 15;
const OWED_WINDOW_DAYS = 30;

interface Target {
  id: string;
  sender_email: string;
  draft_id: string | null;
  draft_status: string | null;
}

/** The owed message an id or unique prefix names. */
async function resolveOwed(db: D1Database, raw: string, now: Date): Promise<Target | string> {
  const id = raw.trim().split(/\s+/)[0] ?? "";
  if (!ID.test(id)) return "Give the message id from /replies (at least 6 characters).";
  const { results } = await db
    .prepare(
      `SELECT i.id, i.sender_email, i.draft_id, d.status AS draft_status FROM inbound_emails i LEFT JOIN drafts d ON d.id = i.draft_id
        WHERE i.status IN ('new', 'notified', 'draft_created') AND i.received_at >= ?3 AND (i.id = ?1 OR substr(i.id, 1, ?2) = ?1)
        LIMIT 3`,
    )
    .bind(id, id.length, daysAgo(now, OWED_WINDOW_DAYS))
    .all<Target>();
  const exact = results.find((r) => r.id === id);
  if (exact) return exact;
  if (results.length === 0) return `No open message matches ${id}. /replies lists them.`;
  if (results.length > 1) return `${id} matches more than one message; give more of the id.`;
  return results[0] as Target;
}

/** Close a message: answered by hand, or needing no answer. Its pending draft is rejected, with no evidence. */
async function closeMessage(deps: ReplyCommandDeps, raw: string, status: "responded" | "ignored", now: Date): Promise<string> {
  const target = await resolveOwed(deps.db, raw, now);
  if (typeof target === "string") return target;
  const at = now.toISOString();
  if (target.draft_id && (target.draft_status === "pending_approval" || target.draft_status === "approved")) {
    await closeReplyEvidence(deps.db, target.draft_id);
    await deps.db.prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status IN ('pending_approval', 'approved')").bind(target.draft_id, at).run();
  }
  const done = await deps.db
    .prepare("UPDATE inbound_emails SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('new', 'notified', 'draft_created')")
    .bind(target.id, status, at)
    .run();
  if ((done.meta.changes ?? 0) === 0) return "That message changed state in the meantime; nothing was marked.";
  const who = senderLabel(target.sender_email);
  return status === "responded" ? `Marked the message from ${who} as answered. Reminders stop.` : `Marked the message from ${who} as needing no answer. Reminders stop.`;
}

/** Run a reply command and return the reply text. Throws on a database error; the caller reports it. */
export async function runReplyCommand(deps: ReplyCommandDeps, command: { name: string; args: string }, chat: { chatId: string; userId: string }): Promise<string> {
  const now = deps.now?.() ?? new Date();
  switch (command.name) {
    case "replies": {
      const { results } = await deps.db
        .prepare(
          `SELECT i.id, i.sender_email, i.intent, i.received_at, i.draft_id, d.status AS draft_status
             FROM inbound_emails i LEFT JOIN drafts d ON d.id = i.draft_id
            WHERE ${OWED_SQL} AND i.received_at >= ?1 ORDER BY i.received_at ASC LIMIT ?2`,
        )
        .bind(daysAgo(now, OWED_WINDOW_DAYS), LIST_LIMIT + 1)
        .all<{ id: string; sender_email: string; intent: string | null; received_at: string; draft_id: string | null; draft_status: string | null }>();
      if (results.length === 0) return "No replies are waiting on you.";
      const lines = results.slice(0, LIST_LIMIT).map((r) => {
        const draft = r.draft_id ? `, draft ${r.draft_id} (${r.draft_status ?? "unknown"})` : "";
        return `${r.id}  ${senderLabel(r.sender_email)}  ${r.intent ?? "not triaged yet"}, waiting ${waitedFor(new Date(r.received_at), now)}${draft}`;
      });
      return [
        `Replies waiting on you${results.length > LIST_LIMIT ? ` (the oldest ${LIST_LIMIT})` : ""}:`,
        ...lines,
        "",
        "/reply_done <id> answered by hand, /reply_ignore <id> no answer needed, /reply_draft <id> show its draft again, /reply_send <draft id> send an approved draft.",
      ].join("\n");
    }
    case "reply_done":
      return closeMessage(deps, command.args, "responded", now);
    case "reply_ignore":
      return closeMessage(deps, command.args, "ignored", now);
    case "reply_send": {
      if (!(await replyFlagOn(deps.flags, REPLY_FLAGS.send))) return `Sending replies is turned off (${REPLY_FLAGS.send}). Send it from your mailbox, then /reply_done <id>.`;
      const id = command.args.trim().split(/\s+/)[0] ?? "";
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return "Give the draft id, as shown in /replies.";
      const recipient = await deps.db.prepare("SELECT recipient_email FROM drafts WHERE id = ?1").bind(id).first<{ recipient_email: string | null }>();
      const result = await sendApprovedReply(
        {
          db: deps.db,
          kv: deps.kv,
          shown: deps.shown,
          flags: deps.flags,
          config: deps.config,
          inbox: deps.inbox,
          unsubscribeSigningKey: deps.unsubscribeSigningKey,
          baseUrl: deps.baseUrl,
          operator: deps.operator,
          now: () => now,
          ...(deps.log ? { log: deps.log } : {}),
        },
        id,
      );
      return describeSend(result, recipient?.recipient_email ?? "(unknown)");
    }
    case "reply_draft": {
      const target = await resolveOwed(deps.db, command.args, now);
      if (typeof target === "string") return target;
      if (!target.draft_id) return "That message has no draft. Drafts are written when replies:drafting_enabled is on.";
      if (target.draft_status !== "pending_approval") return `Its draft is ${target.draft_status ?? "missing"}, so there is nothing to approve.`;
      const request = await requestDraftApproval({ db: deps.db, shown: deps.shown, operator: deps.operator, now: () => now }, target.draft_id, chat.chatId);
      return request.ok ? "Here it is again." : `The approval request could not be shown: ${request.reason}.`;
    }
    default:
      return `Unknown command /${command.name}. Send /help for the list.`;
  }
}
