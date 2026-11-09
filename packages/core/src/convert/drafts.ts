// GTM-agents: the drafts that follow a meeting: the recap, the rebook, and the two post-demo
// follow-ups. Every one is a draft that waits for a person; nothing here sends.
//
// The text is deterministic: a short, plain-text note built from the contact's first name, the
// product and agent names in gtm.config.ts, the booking URL when one is configured, and the meeting
// day in the contact's time zone when it is known. No model writes it and nothing from outside goes
// into it. It is a starting point the operator edits in their mail client.
//
// Each draft is keyed `convert:<meeting code>:<kind>` (drafts.idempotency_key), so a rerun, a
// redelivered command or two jobs racing can never write it twice; the insert is the claim. A draft
// that was withdrawn or rejected is written afresh when it is needed again (the operator corrected
// a no-show to held, say), through a compare-and-set on its rejected status. A
// suppressed or erased address gets no draft at all. Drafts are filed under the post-meeting
// follow-up or rebook action classes, which stay at "draft and ask" here: nothing is sent
// automatically, whatever the class's level. Mailbox mirroring is not offered for these drafts: the
// operator approves in chat and sends from the mail client.
import type { ActionClass } from "../autonomy/levels.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { DraftKind } from "../data/enums.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { requestDraftApproval } from "../operator/approvals.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { ShownStore } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { checkSuppression } from "../sending/suppression.ts";

export const CONVERT_DRAFT_KINDS = ["recap", "rebook", "step2", "step3"] as const;
export type ConvertDraftKind = (typeof CONVERT_DRAFT_KINDS)[number];

const FILED: Record<ConvertDraftKind, { kind: DraftKind; actionClass: ActionClass }> = {
  recap: { kind: "recap", actionClass: "post_meeting_followup" },
  rebook: { kind: "check_in", actionClass: "rebook" },
  step2: { kind: "check_in", actionClass: "post_meeting_followup" },
  step3: { kind: "check_in", actionClass: "post_meeting_followup" },
};

/** The idempotency key of a meeting's draft. */
export const convertDraftKey = (code: string, kind: ConvertDraftKind): string => `convert:${code}:${kind}`;

/** Draft statuses that are still open: not sent, not rejected. */
export const OPEN_DRAFT_STATUSES = ["draft", "pending_approval", "approved"] as const;

export interface DraftContext {
  firstName: string | null;
  /** The contact's IANA time zone, when known. */
  timezone: string | null;
  meetingStart: string;
  /** Why a rebook is drafted. */
  reason?: "cancelled" | "no_show";
}

/** "Tuesday, 10 November", in the time zone when it is a valid one, else in UTC. */
export function meetingDay(iso: string, timezone: string | null): string {
  const at = new Date(iso);
  for (const zone of [timezone, "UTC"]) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: zone }).format(at);
    } catch {
      // Not a time zone this runtime knows; fall back to UTC.
    }
  }
  return iso.slice(0, 10);
}

const greeting = (firstName: string | null) => {
  const name = (firstName ?? "").replace(/[^\p{L}\p{M}' -]/gu, "").trim().slice(0, 40);
  return name ? `Hi ${name},` : "Hello,";
};

/** The subject and body of a meeting draft. Pure. */
export function draftText(kind: ConvertDraftKind, ctx: DraftContext, config: Pick<GtmConfig, "agent" | "company" | "sending">): { subject: string; body: string } {
  const sign = `Best,\n${config.agent.name}`;
  const product = config.company.product.name;
  const day = meetingDay(ctx.meetingStart, ctx.timezone);
  const booking = config.sending.bookingUrl;
  const next = booking ? `If a next conversation would help, you can pick a time here: ${booking}` : "If a next conversation would help, reply with a couple of times that suit you and I will send an invite.";
  const paragraphs: Record<ConvertDraftKind, { subject: string; lines: string[] }> = {
    recap: {
      subject: "Following up on our conversation",
      lines: [
        `Thank you for your time on ${day} and for walking me through how your team works today.`,
        `If questions about ${product} came up afterwards, or you would like to bring a colleague into the next conversation, just reply here.`,
        next,
      ],
    },
    rebook: {
      subject: "Finding another time",
      lines: [
        ctx.reason === "cancelled" ? `I saw our call on ${day} was cancelled. No problem at all.` : `It looks like we missed each other on ${day}. No problem at all.`,
        booking ? `Would another time work? You can pick one here: ${booking}` : "Would another time work? Reply with a couple of times that suit you and I will send a new invite.",
      ],
    },
    step2: {
      subject: "Checking in after our conversation",
      lines: [`I wanted to check in after our conversation on ${day}. Is there anything I can send over that would help your team decide on next steps with ${product}?`, next],
    },
    step3: {
      subject: "Closing the loop",
      lines: ["I do not want to crowd your inbox, so this is my last note for now. If the timing is not right, that is completely fine.", "Whenever it makes sense to pick this up again, just reply here."],
    },
  };
  const chosen = paragraphs[kind];
  return { subject: chosen.subject, body: [greeting(ctx.firstName), "", chosen.lines.join("\n\n"), "", sign].join("\n") };
}

export interface ConvertDraftDeps {
  db: D1Database;
  config: Pick<GtmConfig, "agent" | "company" | "sending" | "operator">;
  operator?: OperatorChannel | undefined;
  /** Where approval requests record what was shown (the KV namespace). */
  shown?: ShownStore | undefined;
  /** The chat approvals go to; defaults to the first allowed chat. */
  chatId?: string | undefined;
  now: Date;
  log: JobLogger;
}

export interface ConvertDraftInput {
  code: string;
  kind: ConvertDraftKind;
  contact: { id: string; email: string; first_name: string | null; timezone: string | null };
  dealId: string | null;
  meetingStart: string;
  attribution: string | null;
  reason?: "cancelled" | "no_show";
}

export type ConvertDraftResult =
  | { status: "created"; draftId: string; approvalRequested: boolean }
  | { status: "exists"; draftId: string | null }
  | { status: "suppressed" }
  | { status: "failed"; reason: string };

/** Write a meeting draft once and ask for approval. Never throws. */
export async function createConvertDraft(deps: ConvertDraftDeps, input: ConvertDraftInput): Promise<ConvertDraftResult> {
  const { db, log } = deps;
  const key = convertDraftKey(input.code, input.kind);
  try {
    const existing = await db.prepare("SELECT id, status FROM drafts WHERE idempotency_key = ?1").bind(key).first<{ id: string; status: string }>();
    if (existing && existing.status !== "rejected") return { status: "exists", draftId: existing.id };
    // A gate: a suppressed, opted-out or erased address, or a check that cannot be read, gets no draft.
    const suppression = await checkSuppression(db, [input.contact.email]);
    if (!suppression.ok) return { status: "suppressed" };
    const text = draftText(input.kind, { firstName: input.contact.first_name, timezone: input.contact.timezone, meetingStart: input.meetingStart, ...(input.reason ? { reason: input.reason } : {}) }, deps.config);
    const filed = FILED[input.kind];
    const at = deps.now.toISOString();
    const notes = JSON.stringify({ meeting: input.code, step: input.kind, attribution: input.attribution, ...(input.reason ? { reason: input.reason } : {}) });
    const chat = deps.chatId ?? deps.config.operator.allowedChatIds[0];
    const ask = async (id: string): Promise<boolean> => {
      if (!deps.operator || !deps.shown || !chat) return false;
      const request = await requestDraftApproval({ db, shown: deps.shown, operator: deps.operator, now: () => deps.now, logger: log }, id, chat);
      if (!request.ok) log.warn("a meeting draft's approval request could not be sent", { draftId: id, reason: request.reason });
      return request.ok;
    };
    if (existing) {
      const revived = await db
        .prepare(
          `UPDATE drafts SET status = 'pending_approval', recipient_email = ?2, subject = ?3, body = ?4, notes = ?5, deal_id = ?6, approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?7
            WHERE id = ?1 AND status = 'rejected'`,
        )
        .bind(existing.id, input.contact.email, text.subject, text.body, notes, input.dealId, at)
        .run();
      if ((revived.meta.changes ?? 0) === 0) return { status: "exists", draftId: existing.id };
      return { status: "created", draftId: existing.id, approvalRequested: await ask(existing.id) };
    }
    const id = `dr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const insert = await db
      .prepare(
        `INSERT INTO drafts (id, contact_id, deal_id, kind, recipient_email, subject, body, status, idempotency_key, action_class, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending_approval', ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .bind(id, input.contact.id, input.dealId, filed.kind, input.contact.email, text.subject, text.body, key, filed.actionClass, notes, at)
      .run();
    if ((insert.meta.changes ?? 0) === 0) {
      const raced = await db.prepare("SELECT id FROM drafts WHERE idempotency_key = ?1").bind(key).first<{ id: string }>();
      return { status: "exists", draftId: raced?.id ?? null };
    }
    return { status: "created", draftId: id, approvalRequested: await ask(id) };
  } catch (error) {
    log.warn("a meeting draft could not be written", { code: input.code, kind: input.kind, error: sanitizeErrorMessage(error) });
    return { status: "failed", reason: sanitizeErrorMessage(error) };
  }
}

/** Withdraw a meeting's open drafts of these kinds (status rejected). Returns how many. Throws on a database error. */
export async function withdrawConvertDrafts(db: D1Database, code: string, kinds: readonly ConvertDraftKind[], now: Date): Promise<number> {
  const keys = JSON.stringify(kinds.map((k) => convertDraftKey(code, k)));
  const result = await db
    .prepare(`UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE idempotency_key IN (SELECT value FROM json_each(?1)) AND status IN ('draft', 'pending_approval', 'approved')`)
    .bind(keys, now.toISOString())
    .run();
  return result.meta.changes ?? 0;
}

/** The status of a meeting's draft of one kind, or null when there is none. Throws on a database error. */
export async function convertDraftStatus(db: D1Database, code: string, kind: ConvertDraftKind): Promise<string | null> {
  const row = await db.prepare("SELECT status FROM drafts WHERE idempotency_key = ?1").bind(convertDraftKey(code, kind)).first<{ status: string }>();
  return row?.status ?? null;
}
