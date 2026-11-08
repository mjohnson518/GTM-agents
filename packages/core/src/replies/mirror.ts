// GTM-agents: reply drafts mirrored into the mailbox, and what the operator did with them.
//
// Only when the connected mailbox can create drafts: an inbound-only mailbox (Cloudflare Email
// Routing) is skipped cleanly. Every reply draft waiting for approval becomes a real draft in the
// mailbox, on the thread of the message it answers: only for the newest message on the thread, and
// only for mail under 14 days old. The row is claimed (provider_draft_id 'pending') before the
// mailbox call, so two runs never create two drafts; a failed call releases it for the next run.
// Once a mailbox draft exists, the operator sends from the mailbox and approval in chat refuses to
// send it, so the same reply cannot leave twice.
//
// Every run then reconciles each mirrored draft:
//   - a message was sent on the thread after theirs: the reply is answered. The draft is marked
//     sent, and the evidence is approved_unchanged when the sent text matches the draft once
//     quoted history and the signature are stripped, approved_edited otherwise;
//   - nothing sent and the mailbox draft is gone (when the mailbox can tell): the operator is told
//     once and the reply stays owed, since a scheduled send also removes the draft;
//   - nothing sent after 7 days: the message is marked ignored, the draft rejected, and the
//     evidence is rejected.
// A thread read returns the mailbox's drafts as well as its sent mail (mailbox.ts). A message the
// adapter marks as sent counts as sent; one it does not mark counts only once the mailbox draft is
// known to be gone. When the mailbox cannot tell a draft from a send, nothing is concluded from it:
// the reply stays owed, and a reply closed after 7 days records no evidence either way.
// Mailbox drafts carry no footer and no unsubscribe header, like any reply the operator writes.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { InboxProvider, InboundMessage } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { messageId } from "../sending/message.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { closeReplyEvidence, recordReplyEvidence, type ReplyEvidence } from "./evidence.ts";
import { mailboxCan, mailboxDraftExists, ownMessagesAfter } from "./mailbox.ts";
import { DAY_MS, daysAgo, inboundColumns, type InboundRow } from "./rows.ts";
import { senderLabel, sentMatchesDraft } from "./text.ts";

export const MIRROR_MAX_AGE_DAYS = 14;
export const MIRROR_GONE_WAIT_DAYS = 7;
const PENDING = "pending";
/** A claim older than this was left by a run that stopped; it is released. */
const STALE_CLAIM_MS = 60 * 60_000;

export interface MirrorDeps {
  db: D1Database;
  inbox: InboxProvider | undefined;
  operator?: OperatorChannel;
  chatId?: string;
  now: Date;
  log: JobLogger;
  maxRows: number;
}

export interface MirrorResult {
  skipped: string | null;
  created: number;
  failed: number;
  sent: number;
  waiting: number;
  discarded: number;
}

interface MirrorRow extends InboundRow {
  d_id: string;
  d_subject: string | null;
  d_body: string | null;
  d_to: string | null;
  d_status: string;
  d_class: string | null;
  updated_at: string;
}

const time = (iso: string | null | undefined) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? at : Number.NaN;
};

interface ThreadState {
  /** The first message the mailbox sent after theirs, when it can be told. */
  sent: InboundMessage | null;
  /** Messages from the mailbox after theirs that the adapter does not mark as sent or as a draft. */
  unknown: InboundMessage[];
  /** True when any message from the mailbox follows theirs (sent, draft or unknown). */
  anyOwn: boolean;
}

/** What the mailbox has put on the thread after `row`. A draft never counts as sent. */
function threadState(thread: readonly InboundMessage[], row: InboundRow): ThreadState {
  const own = ownMessagesAfter(thread, row.provider_message_id, row.received_at);
  return {
    sent: own.find((m) => m.kind === "sent")?.message ?? null,
    unknown: own.filter((m) => m.kind === "unknown").map((m) => m.message),
    anyOwn: own.length > 0,
  };
}

async function tell(deps: MirrorDeps, text: string): Promise<boolean> {
  if (!deps.operator) return false;
  try {
    await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** The reply went out from the mailbox: answered, draft sent, evidence, and a touch on the contact. */
async function markAnsweredFromMailbox(deps: MirrorDeps, row: MirrorRow, sent: InboundMessage): Promise<void> {
  const at = deps.now.toISOString();
  const outcome: ReplyEvidence = row.d_body && typeof sent.text === "string" && sentMatchesDraft(sent.text, row.d_body) ? "approved_unchanged" : "approved_edited";
  await recordReplyEvidence(deps.db, { draftId: row.d_id, actionClass: row.d_class, outcome, detail: "sent from the mailbox", now: deps.now });
  const writes = [
    deps.db.prepare("UPDATE inbound_emails SET status = 'responded', updated_at = ?2 WHERE id = ?1 AND status IN ('new', 'notified', 'draft_created')").bind(row.id, at),
    deps.db.prepare("UPDATE drafts SET status = 'sent', sent_at = ?2, updated_at = ?2 WHERE id = ?1 AND status IN ('pending_approval', 'approved')").bind(row.d_id, at),
  ];
  if (row.contact_id) {
    writes.push(
      deps.db
        .prepare(
          `INSERT INTO outreach_log (id, contact_id, channel, direction, subject, summary, outcome, provider, provider_message_id, created_at)
           VALUES (?1, ?2, 'email', 'outbound', ?3, 'reply sent from the mailbox', 'sent', ?4, ?5, ?6)`,
        )
        .bind(crypto.randomUUID(), row.contact_id, row.d_subject, deps.inbox?.name ?? "mailbox", sent.providerMessageId, at),
      deps.db.prepare("UPDATE contacts SET last_contacted_at = ?2, updated_at = ?2 WHERE id = ?1").bind(row.contact_id, at),
    );
  }
  await deps.db.batch(writes);
}

/** Create the missing mailbox drafts, then follow the ones already there. Throws only on a database read error. */
export async function runMirror(deps: MirrorDeps): Promise<MirrorResult> {
  const result: MirrorResult = { skipped: null, created: 0, failed: 0, sent: 0, waiting: 0, discarded: 0 };
  const inbox = deps.inbox;
  if (!mailboxCan(inbox, "drafts") || !mailboxCan(inbox, "threads")) {
    result.skipped = "the connected mailbox cannot create drafts or read threads";
    return result;
  }
  const { db, now, log } = deps;
  const at = now.toISOString();

  // Claims a stopped run left behind.
  await db
    .prepare("UPDATE inbound_emails SET provider_draft_id = NULL WHERE provider_draft_id = ?1 AND status = 'draft_created' AND updated_at < ?2")
    .bind(PENDING, new Date(now.getTime() - STALE_CLAIM_MS).toISOString())
    .run()
    .catch(() => undefined);

  const select = `SELECT ${inboundColumns("i")}, i.updated_at, d.id AS d_id, d.subject AS d_subject, d.body AS d_body, d.recipient_email AS d_to,
                         d.status AS d_status, d.action_class AS d_class
                    FROM inbound_emails i JOIN drafts d ON d.id = i.draft_id`;

  // 1. Create.
  const { results: missing } = await db
    .prepare(
      `${select}
        WHERE i.status = 'draft_created' AND i.provider_draft_id IS NULL AND i.provider_thread_id IS NOT NULL
          AND d.kind = 'reply' AND d.status = 'pending_approval' AND i.received_at >= ?1
          AND NOT EXISTS (SELECT 1 FROM inbound_emails n WHERE n.provider_thread_id = i.provider_thread_id AND n.received_at > i.received_at
                            AND COALESCE(n.classification, 'unclassified') IN ('reply', 'new_inquiry', 'unclassified'))
        ORDER BY i.received_at DESC LIMIT ?2`,
    )
    .bind(daysAgo(now, MIRROR_MAX_AGE_DAYS), deps.maxRows)
    .all<MirrorRow>();
  for (const row of missing) {
    try {
      if (!row.d_to || !row.d_body || !row.d_subject) continue;
      const suppression = await checkSuppression(db, [row.d_to]);
      if (!suppression.ok) continue;
      const thread = await inbox.getThread(row.provider_thread_id as string);
      const state = threadState(thread, row);
      if (state.sent) {
        await markAnsweredFromMailbox(deps, row, state.sent);
        result.sent += 1;
        continue;
      }
      // Something from the mailbox is already on the thread (a draft of their own, perhaps): add nothing.
      if (state.anyOwn) continue;
      const claim = await db
        .prepare(
          `UPDATE inbound_emails SET provider_draft_id = ?2, updated_at = ?4
            WHERE id = ?1 AND provider_draft_id IS NULL AND EXISTS (SELECT 1 FROM drafts WHERE id = ?3 AND status = 'pending_approval')`,
        )
        .bind(row.id, PENDING, row.d_id, at)
        .run();
      if ((claim.meta.changes ?? 0) === 0) continue;
      let draftId: string;
      try {
        const parent = messageId(row.message_id ?? row.provider_message_id);
        ({ draftId } = await inbox.createDraft({ threadId: row.provider_thread_id as string, to: row.d_to, subject: row.d_subject, text: row.d_body, ...(parent ? { inReplyTo: parent } : {}) }));
      } catch (error) {
        await db.prepare("UPDATE inbound_emails SET provider_draft_id = NULL WHERE id = ?1 AND provider_draft_id = ?2").bind(row.id, PENDING).run();
        throw error;
      }
      await db.prepare("UPDATE inbound_emails SET provider_draft_id = ?2, updated_at = ?3 WHERE id = ?1").bind(row.id, String(draftId).slice(0, 200), at).run();
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      log.warn("a mailbox draft could not be created", { inboundId: row.id, error: sanitizeErrorMessage(error) });
    }
  }

  // 2. Reconcile.
  const { results: mirrored } = await db
    .prepare(
      `${select}
        WHERE i.status = 'draft_created' AND i.provider_draft_id IS NOT NULL AND i.provider_draft_id <> ?1
          AND d.kind = 'reply' AND d.status IN ('pending_approval', 'approved')
        ORDER BY i.received_at DESC LIMIT ?2`,
    )
    .bind(PENDING, deps.maxRows)
    .all<MirrorRow>();
  for (const row of mirrored) {
    try {
      const thread = await inbox.getThread(row.provider_thread_id as string);
      const state = threadState(thread, row);
      const exists = await mailboxDraftExists(inbox, row.provider_draft_id as string);
      // A message the mailbox does not mark counts as the send once the draft is known to be gone.
      const sent = state.sent ?? (exists === false ? (state.unknown[0] ?? null) : null);
      if (sent) {
        await markAnsweredFromMailbox(deps, row, sent);
        result.sent += 1;
        continue;
      }
      const age = now.getTime() - time(row.received_at);
      if (Number.isFinite(age) && age < MIRROR_GONE_WAIT_DAYS * DAY_MS) {
        if (exists !== false) continue;
        const key = `reply_mirror_gone:${row.id}`;
        if (!(await claimEffect(db, key, "reply_mirror_gone"))) continue;
        const delivered = await tell(
          deps,
          `The mailbox draft replying to ${senderLabel(row.sender_email)} is gone and nothing was sent on the thread [${row.id}]. If you scheduled it, there is nothing to do. Otherwise the reply is still owed: reminders continue, and it is marked answered as soon as a reply goes out. It closes as ignored after ${MIRROR_GONE_WAIT_DAYS} days with nothing sent.`,
        );
        if (!delivered) await releaseEffect(db, key, "reply_mirror_gone");
        result.waiting += 1;
        continue;
      }
      // Rejected evidence only when the mailbox can tell nothing was sent: no unmarked message of its own.
      if (state.unknown.length === 0) {
        await recordReplyEvidence(db, { draftId: row.d_id, actionClass: row.d_class, outcome: "rejected", detail: `nothing sent from the mailbox in ${MIRROR_GONE_WAIT_DAYS} days`, now });
      } else {
        await closeReplyEvidence(db, row.d_id);
      }
      await db.batch([
        db.prepare("UPDATE inbound_emails SET status = 'ignored', updated_at = ?2 WHERE id = ?1 AND status = 'draft_created'").bind(row.id, at),
        db.prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status IN ('pending_approval', 'approved')").bind(row.d_id, at),
      ]);
      result.discarded += 1;
    } catch (error) {
      log.warn("a mailbox draft could not be reconciled", { inboundId: row.id, error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}
