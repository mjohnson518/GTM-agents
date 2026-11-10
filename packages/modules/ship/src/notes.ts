// GTM-agents: the "you asked, it is live" notes to the people who asked for a shipped change.
//
// The writer never writes copy. It fills the operator's approved template (kind lifecycle, id
// ship-live unless the deployment names another) with the requester's first name, the agent's name,
// the booking URL and the shipped change's title as {{attributes.shipped_title}}, and nothing else.
// A variable with no value skips the requester (skip rather than guess), and the quality gate checks
// the result as it checks every outbound message. The title is the approved spec's, cleaned of
// links, addresses, dashes and anything that reads like an instruction; a title that is not fit for
// mail skips every note of the theme.
//
// Who gets one: each requester of the theme who resolves to a contact (feedback_items.contact_id,
// or the contact whose product user id the feedback carries) and is a product user, the same
// condition the send function holds lifecycle mail to. Anyone who cannot be resolved is skipped;
// erased or suppressed people are skipped before anything is drafted. One row per (theme, contact)
// in ship_notes is the claim, so a theme announced twice never drafts or sends twice.
//
// How it goes out: only through the shared send function, on path "lifecycle", with the digest of
// the exact draft as its approval, which the send function verifies again:
//   - automatically only while ship_notification is at level 2 or above, with a quality pass and a
//     send function wired; level 2 also tells the operator. A send that definitely did not happen
//     returns the note to the operator as a draft;
//   - otherwise it is drafted for `ship-note-approve-<id> <code>` (the code is the first 32 hex
//     characters of the draft's digest) or `ship-note-decline-<id>`. The approve command checks the
//     contact again (suppression, erasure, still a product user), refuses a code that is not the
//     current draft's, claims the note and its draft by compare-and-set, and sends. A note can be
//     approved for NOTE_APPROVABLE_DAYS.
// Every decision is autonomy evidence for ship_notification, written once per note.
import type { Env } from "@gtm-agents/core";
import { readAutonomyLevel, recordAutonomyEvidenceOnce } from "@gtm-agents/core/autonomy/runtime";
import type { GtmConfig } from "@gtm-agents/core/config";
import { PRODUCT_STATES } from "@gtm-agents/core/data";
import type { FlagReader, JobLogger } from "@gtm-agents/core/jobs";
import { followupLinks } from "@gtm-agents/core/lifecycle";
import type { OperatorChannel } from "@gtm-agents/core/ports";
import { isErased } from "@gtm-agents/core/product-bridge";
import { checkOutboundQuality, usableFirstName } from "@gtm-agents/core/quality";
import { detectInjection, draftDigest, sanitizeErrorMessage } from "@gtm-agents/core/security";
import { checkSuppression, type OutreachOutcome, type SendOutreach } from "@gtm-agents/core/sending";
import { loadTemplates, renderTemplate, serveTemplateFiles, type ServedTemplate, type TemplateFile } from "@gtm-agents/core/templates";
import { SHIP_FLAGS, shipStepOn } from "./planning-flags.ts";
import { constantTimeEqual, hexId, oneLine, shortId } from "./planning-shared.ts";
import { cleanModelText } from "./triage.ts";

export const DEFAULT_NOTE_TEMPLATE_ID = "ship-live";
export const NOTE_APPROVABLE_DAYS = 14;
/** Notes drafted for one theme, at most. */
export const MAX_NOTES_PER_THEME = 50;
export const NOTE_CODE_CHARS = 32;
const DAY_MS = 86_400_000;
const TITLE_MAX = 90;

export const noteKey = (id: string): string => `ship_note:${id}`;
const newDraftId = (): string => `dr_${hexId(20)}`;
const PRODUCT_STATE_SQL = PRODUCT_STATES.map((s) => `'${s}'`).join(", ");

/** The title as a note carries it, or null when it is not fit for mail. Pure. */
export function noteTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const cleaned = cleanModelText(title, TITLE_MAX).replace(/[.!?;:,\s]+$/, "");
  if (cleaned.length < 4 || /\[(?:link|email|REDACTED)\]/i.test(cleaned) || detectInjection(cleaned) > 0) return null;
  return cleaned;
}

export interface NoteDeps<E extends Env> {
  env: E;
  db: D1Database;
  flags: FlagReader;
  config: Pick<GtmConfig, "agent" | "company" | "sending" | "autonomy">;
  send: SendOutreach | undefined;
  operator: OperatorChannel | undefined;
  chatId: string | undefined;
  templates: readonly TemplateFile[] | undefined;
  templateId: string;
  maxNotes: number;
  now: Date;
  log: JobLogger;
}

export interface NoteRunResult {
  requesters: number;
  unresolved: number;
  drafted: number;
  sent: number;
  queued: number;
  skipped: number;
  failed: number;
  /** Why nothing was drafted at all, when nothing was. */
  reason?: string;
}

interface RequesterRow {
  contact_id: string;
  email: string | null;
  email_sha256: string | null;
  mailbox_sha256: string | null;
  first_name: string | null;
  last_name: string | null;
  account_key: string | null;
  product_user_id: string | null;
  product_user: number;
}

/** The approved note template, or the reason there is none. */
export async function noteTemplate<E extends Env>(deps: Pick<NoteDeps<E>, "env" | "config" | "templates" | "templateId">): Promise<ServedTemplate | string> {
  const companyDomain = deps.config.company.domain;
  const load = deps.templates ? await serveTemplateFiles(deps.templates, { companyDomain }) : await loadTemplates(deps.env.KV, { companyDomain });
  if (load.error) return `the templates could not be loaded (${load.error})`;
  const template = load.templates.find((t) => t.id === deps.templateId && t.meta.kind === "lifecycle" && t.meta.status === "approved");
  return template ?? `there is no approved lifecycle template ${deps.templateId}`;
}

type Composed = { ok: true; subject: string; body: string; toName: string | null } | { ok: false; reason: string };

/** Render one note and run the quality gate on it. Pure. */
export function composeNote(
  template: Pick<ServedTemplate, "subject" | "body">,
  contact: { email: string; first_name: string | null; account_key: string | null },
  title: string,
  config: Pick<GtmConfig, "agent" | "company" | "sending">,
  appUrl: string | undefined,
): Composed {
  const first = usableFirstName(contact.first_name);
  const rendered = renderTemplate(template, {
    first_name: first ?? undefined,
    sender_name: config.agent.name,
    booking_url: config.sending.bookingUrl,
    attributes: { shipped_title: title },
  });
  if (!rendered.ok) return { ok: false, reason: `no value for ${rendered.missing.join(", ")}` };
  const quality = checkOutboundQuality({
    kind: "lifecycle",
    subject: rendered.subject,
    body: rendered.body,
    recipient: contact.email,
    contact: { email: contact.email, firstName: contact.first_name, accountName: null, accountKey: contact.account_key },
    links: followupLinks(config, appUrl),
    claimSources: [template.subject, template.body, first ?? "", config.company.name, config.company.product.name, config.agent.name, title].filter((s) => s.length > 0),
  });
  if (quality.verdict !== "pass") return { ok: false, reason: `the quality gate ${quality.verdict === "block" ? "blocked" : "held"} it: ${quality.findings.map((f) => f.code).join(", ")}` };
  return { ok: true, subject: rendered.subject, body: rendered.body, toName: first };
}

/** The message that shows a drafted note to the operator, with its commands. Pure. */
export function notePreview(input: { id: string; who: string; title: string; to: string; subject: string; body: string; digest: string; lead?: string }): string {
  return [
    ...(input.lead ? [input.lead, ""] : []),
    `A "you asked, it is live" note for ${input.who} about ${input.title} [note ${input.id}].`,
    "",
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "",
    input.body,
    "",
    `Send exactly this: ship-note-approve-${input.id} ${input.digest.slice(0, NOTE_CODE_CHARS)}`,
    `Drop it: ship-note-decline-${input.id}`,
  ].join("\n");
}

const who = (r: { first_name: string | null; last_name: string | null; email: string | null }) => {
  const name = [r.first_name, r.last_name].map((v) => oneLine(v, 40)).filter(Boolean).join(" ");
  return name ? `${name} <${r.email ?? "(no address)"}>` : (r.email ?? "(no address)");
};

/** Call the send function. If it throws anyway, acceptance is uncertain: a failure that is never retried. */
async function safeSend(send: SendOutreach, items: Parameters<SendOutreach>[0]): Promise<OutreachOutcome[]> {
  try {
    return await send(items);
  } catch (error) {
    return items.map((item) => ({ idempotencyKey: item.idempotencyKey, status: "failed" as const, retryable: false, message: `the send function failed: ${sanitizeErrorMessage(error)}` }));
  }
}

/** What a send outcome leaves the note as. "retry" means it definitely did not go. Throws on a database error. */
async function settle(db: D1Database, noteId: string, draftId: string, outcome: OutreachOutcome | undefined, now: Date): Promise<"sent" | "queued" | "skipped" | "failed" | "retry"> {
  const at = now.toISOString();
  if (!outcome) return "retry";
  if (outcome.status === "sent" || outcome.status === "duplicate") {
    await db.prepare("UPDATE ship_notes SET status = 'sent', sent_at = ?2, updated_at = ?2 WHERE id = ?1").bind(noteId, at).run();
    return "sent";
  }
  if (outcome.status === "deferred") {
    await db.prepare("UPDATE ship_notes SET status = 'queued', reason = ?2, sent_at = ?3, updated_at = ?3 WHERE id = ?1").bind(noteId, `held by the send function: ${outcome.reason}`, at).run();
    return "queued";
  }
  if (outcome.status === "blocked") {
    await db.batch([
      db.prepare("UPDATE ship_notes SET status = 'skipped', reason = ?2, updated_at = ?3 WHERE id = ?1").bind(noteId, `the send function refused it: ${outcome.reason}`, at),
      db.prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status IN ('draft', 'pending_approval', 'approved')").bind(draftId, at),
    ]);
    return "skipped";
  }
  if (outcome.retryable) return "retry";
  await db.prepare("UPDATE ship_notes SET status = 'failed', reason = ?2, sent_at = ?3, updated_at = ?3 WHERE id = ?1").bind(noteId, oneLine(outcome.message, 160), at).run();
  return "failed";
}

async function tell(deps: { operator: OperatorChannel | undefined; chatId: string | undefined; log: JobLogger }, text: string): Promise<boolean> {
  if (!deps.operator) return false;
  try {
    await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    return true;
  } catch (error) {
    deps.log.warn("a ship note notice could not be delivered", { error: sanitizeErrorMessage(error) });
    return false;
  }
}

async function skipRow(db: D1Database, input: { themeId: string; taskId: string; contactId: string; reason: string; level: number | null; now: Date }): Promise<boolean> {
  const changed = await db
    .prepare(
      `INSERT INTO ship_notes (id, theme_id, task_id, contact_id, level, status, reason, created_at, updated_at)
       VALUES (?1, ?2, (SELECT id FROM ship_tasks WHERE id = ?3), ?4, ?5, 'skipped', ?6, ?7, ?7) ON CONFLICT (theme_id, contact_id) DO NOTHING`,
    )
    .bind(shortId(), input.themeId, input.taskId, input.contactId, input.level, oneLine(input.reason, 200), input.now.toISOString())
    .run();
  return (changed.meta.changes ?? 0) > 0;
}

/**
 * Draft (or, at an earned level, send) the notes for one shipped theme. Throws only when the
 * requesters or the template cannot be read; one requester failing never stops the others.
 */
export async function draftShipNotes<E extends Env>(deps: NoteDeps<E>, theme: { id: string; title: string }, taskId: string): Promise<NoteRunResult> {
  const { db, now, log } = deps;
  const result: NoteRunResult = { requesters: 0, unresolved: 0, drafted: 0, sent: 0, queued: 0, skipped: 0, failed: 0 };
  const title = noteTitle(theme.title);
  if (!title) return { ...result, reason: "the shipped change's title is not fit for mail" };
  const unresolved = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM feedback_items f
        WHERE f.theme_id = ?1 AND f.contact_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM contact_lifecycle l WHERE f.product_user_id IS NOT NULL AND l.product_user_id = f.product_user_id)`,
    )
    .bind(theme.id)
    .first<{ n: number }>();
  result.unresolved = Number(unresolved?.n ?? 0);
  const { results: requesters } = await db
    .prepare(
      `SELECT c.id AS contact_id, c.email, c.email_sha256, c.mailbox_sha256, c.first_name, c.last_name, c.account_key, l.product_user_id,
              CASE WHEN l.signed_up_at IS NOT NULL OR l.state IN (${PRODUCT_STATE_SQL}) THEN 1 ELSE 0 END AS product_user
         FROM contacts c
         LEFT JOIN contact_lifecycle l ON l.contact_id = c.id
        WHERE c.id IN (
          SELECT COALESCE(f.contact_id, (SELECT l2.contact_id FROM contact_lifecycle l2 WHERE f.product_user_id IS NOT NULL AND l2.product_user_id = f.product_user_id))
            FROM feedback_items f WHERE f.theme_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM ship_notes n WHERE n.theme_id = ?1 AND n.contact_id = c.id)
        ORDER BY c.id LIMIT ?2`,
    )
    .bind(theme.id, deps.maxNotes)
    .all<RequesterRow>();
  result.requesters = requesters.length;
  if (requesters.length === 0) return result;
  const template = await noteTemplate(deps);
  if (typeof template === "string") return { ...result, reason: template };
  const reading = await readAutonomyLevel({ flags: deps.flags, db, config: deps.config }, "ship_notification");
  const level = reading.level;

  for (const r of requesters) {
    try {
      const skip = async (reason: string) => {
        if (await skipRow(db, { themeId: theme.id, taskId, contactId: r.contact_id, reason, level, now })) result.skipped += 1;
      };
      if (!r.email) {
        await skip("the contact has no address");
        continue;
      }
      if (Number(r.product_user) !== 1) {
        await skip("the contact is not a product user, so lifecycle mail cannot reach them");
        continue;
      }
      if (await isErased(db, { userId: r.product_user_id, emailSha256: r.email_sha256, mailboxSha256: r.mailbox_sha256 })) {
        await skip("the person is erased");
        continue;
      }
      const suppression = await checkSuppression(db, [r.email]);
      if (suppression.blocked.some((b) => b.reason === "check_failed")) {
        // Unreadable: nothing is recorded, so announcing again can still reach them.
        result.failed += 1;
        continue;
      }
      if (!suppression.ok) {
        await skip("the address is suppressed");
        continue;
      }
      if (level === 0) {
        await skip("ship_notification is at level 0 (observe only)");
        continue;
      }
      const composed = composeNote(template, { email: r.email, first_name: r.first_name, account_key: r.account_key }, title, deps.config, deps.env.PRODUCT_APP_URL);
      if (!composed.ok) {
        await skip(composed.reason);
        continue;
      }
      const automatic = level >= 2 && deps.send !== undefined;
      const id = shortId();
      const draftId = newDraftId();
      const at = now.toISOString();
      const digest = await draftDigest({ to: r.email, subject: composed.subject, body: composed.body });
      // One transaction: the claim, its draft (written only when this claim is the one that took
      // the (theme, contact) slot) and the link between them. Every note starts as a draft waiting
      // for approval, so nothing half-written can leave a claim without a usable draft.
      const [claim] = await db.batch([
        db
          .prepare(
            `INSERT INTO ship_notes (id, theme_id, task_id, contact_id, level, status, decided_by, created_at, updated_at)
             VALUES (?1, ?2, (SELECT id FROM ship_tasks WHERE id = ?3), ?4, ?5, 'drafted', NULL, ?6, ?6) ON CONFLICT (theme_id, contact_id) DO NOTHING`,
          )
          .bind(id, theme.id, taskId, r.contact_id, level, at),
        db
          .prepare(
            `INSERT INTO drafts (id, contact_id, kind, recipient_email, recipient_name, subject, body, status, idempotency_key, action_class, template_id, template_sha256, notes, created_at, updated_at)
             SELECT ?1, ?2, 'lifecycle', ?3, ?4, ?5, ?6, 'pending_approval', ?7, 'ship_notification', ?8, ?9, ?10, ?11, ?11
              WHERE EXISTS (SELECT 1 FROM ship_notes WHERE id = ?12 AND draft_id IS NULL)`,
          )
          .bind(draftId, r.contact_id, r.email, composed.toName, composed.subject, composed.body, noteKey(id), template.id, template.sha256, JSON.stringify({ ship_note: id, theme: theme.id }), at, id),
        db.prepare("UPDATE ship_notes SET draft_id = ?2 WHERE id = ?1 AND draft_id IS NULL AND EXISTS (SELECT 1 FROM drafts WHERE id = ?2)").bind(id, draftId),
      ]);
      if ((claim?.meta.changes ?? 0) === 0) continue;

      const offer = async (lead?: string) => {
        await tell(deps, notePreview({ id, who: who(r), title, to: r.email ?? "", subject: composed.subject, body: composed.body, digest, ...(lead ? { lead } : {}) }));
        result.drafted += 1;
      };
      if (!automatic || !deps.send) {
        await offer();
        continue;
      }
      // Sending on its own: the note and its draft are claimed for the send together, each by
      // compare-and-set, right before it goes, as an approval in chat does.
      const decider = `auto:ship_notification:L${level}`;
      const [noteClaim, draftClaim] = await db.batch([
        db.prepare("UPDATE ship_notes SET status = 'sending', decided_by = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'drafted'").bind(id, decider, at),
        db
          .prepare("UPDATE drafts SET status = 'approved', approved_digest = ?2, approved_at = ?3, approved_by = ?4, updated_at = ?3 WHERE id = ?1 AND status = 'pending_approval'")
          .bind(draftId, digest, at, decider),
      ]);
      if ((noteClaim?.meta.changes ?? 0) === 0 || (draftClaim?.meta.changes ?? 0) === 0) {
        await db.batch([
          db.prepare("UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(draftId, at),
          db.prepare("UPDATE ship_notes SET status = 'drafted', decided_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'sending'").bind(id, at),
        ]);
        await offer("It could not be claimed for an automatic send, so it waits for you.");
        continue;
      }
      const outcomes = await safeSend(deps.send, [
        {
          idempotencyKey: noteKey(id),
          path: "lifecycle",
          contactId: r.contact_id,
          to: r.email,
          ...(composed.toName ? { toName: composed.toName } : {}),
          subject: composed.subject,
          body: composed.body,
          draftId,
          approvedDigest: digest,
          templateId: template.id,
          templateSha256: template.sha256,
        },
      ]);
      const settled = await settle(db, id, draftId, outcomes[0], now);
      if (settled === "retry") {
        // Definitely not sent: it waits for the operator as a draft instead of being retried in a loop.
        await db.batch([
          db.prepare("UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(draftId, at),
          db.prepare("UPDATE ship_notes SET status = 'drafted', decided_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'sending'").bind(id, at),
        ]);
        const outcome = outcomes[0];
        await offer(`The automatic send could not run (${outcome && outcome.status === "failed" ? oneLine(outcome.message, 120) : "no outcome"}), so this note waits for you.`);
        continue;
      }
      await recordAutonomyEvidenceOnce(db, `ship_notification:${id}`, { actionClass: "ship_notification", outcome: "auto_sent", subjectId: draftId, detail: "sent automatically at an earned level", now });
      result[settled] += 1;
      // Level 3 is announced like level 2: the digest-only mode does not exist yet.
      if (settled === "sent" && level >= 2) await tell(deps, `Sent the "you asked, it is live" note to ${who(r)} [note ${id}]: ship_notification is at level ${level} (act and notify).`);
    } catch (error) {
      result.failed += 1;
      log.warn("a ship note could not be drafted", { themeId: theme.id, error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}

export type NoteCommand = { action: "approve"; id: string; code: string | null } | { action: "decline"; id: string };

interface NoteRow {
  id: string;
  theme_id: string;
  contact_id: string;
  status: string;
  draft_id: string | null;
  created_at: string;
  recipient_email: string | null;
  recipient_name: string | null;
  subject: string | null;
  body: string | null;
  draft_status: string | null;
  template_id: string | null;
  template_sha256: string | null;
  email: string | null;
  email_sha256: string | null;
  mailbox_sha256: string | null;
  first_name: string | null;
  last_name: string | null;
  product_user_id: string | null;
  product_user: number;
  title: string | null;
}

async function closeNote(db: D1Database, row: NoteRow, status: "rejected" | "expired" | "skipped", reason: string, at: string, decidedBy: string | null = null): Promise<boolean> {
  const changed = await db
    .prepare("UPDATE ship_notes SET status = ?2, reason = ?3, decided_by = COALESCE(?4, decided_by), updated_at = ?5 WHERE id = ?1 AND status = 'drafted'")
    .bind(row.id, status, oneLine(reason, 200), decidedBy, at)
    .run();
  if ((changed.meta.changes ?? 0) === 0) return false;
  if (row.draft_id) await db.prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status = 'pending_approval'").bind(row.draft_id, at).run();
  return true;
}

/** Run `ship-note-approve-<id> <code>` or `ship-note-decline-<id>`. Throws on a database error; the caller reports it. */
export async function runNoteCommand<E extends Env>(deps: Pick<NoteDeps<E>, "db" | "flags" | "send" | "now" | "log">, command: NoteCommand, actor: string): Promise<string> {
  const { db, now } = deps;
  const at = now.toISOString();
  if (!(await shipStepOn(deps.flags, SHIP_FLAGS.notes))) return `Ship notes are off (${SHIP_FLAGS.notes} and ${SHIP_FLAGS.enabled} must both be on), so nothing was changed.`;
  const row = await db
    .prepare(
      `SELECT n.id, n.theme_id, n.contact_id, n.status, n.draft_id, n.created_at,
              d.recipient_email, d.recipient_name, d.subject, d.body, d.status AS draft_status, d.template_id, d.template_sha256,
              c.email, c.email_sha256, c.mailbox_sha256, c.first_name, c.last_name, l.product_user_id,
              CASE WHEN l.signed_up_at IS NOT NULL OR l.state IN (${PRODUCT_STATE_SQL}) THEN 1 ELSE 0 END AS product_user,
              t.title
         FROM ship_notes n
         LEFT JOIN drafts d ON d.id = n.draft_id
         LEFT JOIN contacts c ON c.id = n.contact_id
         LEFT JOIN contact_lifecycle l ON l.contact_id = n.contact_id
         LEFT JOIN themes t ON t.id = n.theme_id
        WHERE n.id = ?1`,
    )
    .bind(command.id)
    .first<NoteRow>();
  if (!row) return `There is no ship note ${command.id}.`;
  if (row.status !== "drafted") return `Ship note ${row.id} is ${row.status}, so nothing was changed.`;
  const person = who({ first_name: row.first_name, last_name: row.last_name, email: row.email ?? row.recipient_email });

  if (command.action === "decline") {
    if (!(await closeNote(db, row, "rejected", "declined by the operator", at, actor))) return `Ship note ${row.id} was already decided, so nothing was changed.`;
    await recordAutonomyEvidenceOnce(db, `ship_notification:${row.id}`, { actionClass: "ship_notification", outcome: "rejected", subjectId: row.draft_id, detail: "declined in chat", now });
    return `Dropped the note to ${person} [note ${row.id}]. Nothing was sent.`;
  }

  if (!row.draft_id || row.draft_status !== "pending_approval" || !row.recipient_email) return `Ship note ${row.id} has no draft waiting for approval, so nothing was sent.`;
  if (now.getTime() - Date.parse(row.created_at) > NOTE_APPROVABLE_DAYS * DAY_MS) {
    await closeNote(db, row, "expired", "not approved in time", at);
    return `The note to ${person} [note ${row.id}] is too old to send now, so it was dropped. Nothing was sent.`;
  }
  const digest = await draftDigest({ to: row.recipient_email, subject: row.subject, body: row.body });
  const preview = (lead: string) =>
    notePreview({ id: row.id, who: person, title: noteTitle(row.title) ?? "the shipped change", to: row.recipient_email ?? "", subject: row.subject ?? "", body: row.body ?? "", digest, lead });
  if (!command.code || !constantTimeEqual(command.code, digest.slice(0, NOTE_CODE_CHARS))) {
    return preview(command.code ? "Nothing was sent: that code is not this note's current version. This is the version an approval sends." : "Nothing was sent yet. This is the note an approval sends.");
  }
  // The person, again: erased, suppressed or no longer a product user, it is dropped.
  if (!row.email || Number(row.product_user) !== 1) {
    await closeNote(db, row, "skipped", "the contact is no longer a product user", at);
    return `${person} is no longer a product user, so the note was dropped [note ${row.id}]. Nothing was sent.`;
  }
  const suppression = await checkSuppression(db, [row.recipient_email]);
  if (suppression.blocked.some((b) => b.reason === "check_failed")) return "The suppression list could not be read, so nothing was sent. Send the same command again to retry.";
  if (!suppression.ok || (await isErased(db, { userId: row.product_user_id, emailSha256: row.email_sha256, mailboxSha256: row.mailbox_sha256 }))) {
    await closeNote(db, row, "skipped", "the address is suppressed or erased", at);
    return `The address for this note is suppressed or erased, so it was dropped [note ${row.id}]. Nothing was sent.`;
  }
  if (!deps.send) return "No send function is configured for this deployment, so nothing was sent.";

  // The claims: the note first, then its draft, each a compare-and-set.
  const claimed = await db.prepare("UPDATE ship_notes SET status = 'sending', decided_by = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'drafted'").bind(row.id, actor, at).run();
  if ((claimed.meta.changes ?? 0) === 0) return `Ship note ${row.id} was already decided, so nothing was sent.`;
  const approved = await db
    .prepare(
      `UPDATE drafts SET status = 'approved', approved_digest = ?2, approved_at = ?3, approved_by = ?4, updated_at = ?3
        WHERE id = ?1 AND status = 'pending_approval' AND recipient_email IS ?5 AND subject IS ?6 AND body IS ?7`,
    )
    .bind(row.draft_id, digest, at, actor, row.recipient_email, row.subject, row.body)
    .run();
  const revert = async () => {
    await db.batch([
      db.prepare("UPDATE drafts SET status = 'pending_approval', approved_digest = NULL, approved_at = NULL, approved_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(row.draft_id, at),
      db.prepare("UPDATE ship_notes SET status = 'drafted', decided_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'sending'").bind(row.id, at),
    ]);
  };
  if ((approved.meta.changes ?? 0) === 0) {
    await revert();
    return `The draft for note ${row.id} changed while it was being approved, so nothing was sent. Send ship-note-approve-${row.id} to see it again.`;
  }
  const outcomes = await safeSend(deps.send, [
    {
      idempotencyKey: noteKey(row.id),
      path: "lifecycle",
      contactId: row.contact_id,
      to: row.recipient_email,
      ...(row.recipient_name ? { toName: row.recipient_name } : {}),
      subject: row.subject ?? "",
      body: row.body ?? "",
      draftId: row.draft_id,
      approvedDigest: digest,
      ...(row.template_id ? { templateId: row.template_id } : {}),
      ...(row.template_sha256 ? { templateSha256: row.template_sha256 } : {}),
    },
  ]);
  const settled = await settle(db, row.id, row.draft_id, outcomes[0], now);
  if (settled === "retry") {
    await revert();
    const outcome = outcomes[0];
    return `The note could not be sent now (${outcome && outcome.status === "failed" ? oneLine(outcome.message, 120) : "no outcome"}). Nothing was sent; send the same command again later.`;
  }
  await recordAutonomyEvidenceOnce(db, `ship_notification:${row.id}`, { actionClass: "ship_notification", outcome: "approved_unchanged", subjectId: row.draft_id, detail: "approved in chat", now });
  if (settled === "sent") return `Sent the note to ${person} [note ${row.id}].`;
  if (settled === "queued") return `Approved the note to ${person} [note ${row.id}]. The send function holds it until it can go (the recipient's window or a send cap), then sends it.`;
  if (settled === "skipped") return `The send function refused the note to ${person} [note ${row.id}], so it was not sent.`;
  return `The note to ${person} [note ${row.id}] may or may not have gone out (the provider's answer was lost), so it will not be sent again.`;
}
