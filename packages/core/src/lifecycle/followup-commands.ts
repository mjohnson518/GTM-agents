// GTM-agents: the operator's commands for drafted lifecycle follow-ups. They never reach the model,
// and the chat consumer runs each once per message.
//
//   fu-approve-<id>  send a drafted follow-up, after checking everything again, in order:
//                    lifecycle:followups_enabled is on; the follow-up is still drafted and its
//                    draft waits for approval; it is within its approvable age (2 to 14 days by
//                    kind); the contact is still in the stay in a state that scheduled it; they are
//                    neither erased nor suppressed; the caps and the gap hold, counting what has
//                    gone out since; the draft is exactly what the operator was shown (otherwise it
//                    is shown again, and nothing is sent); and the recipient's weekday window is
//                    open. Outside the window nothing is sent, and the same command again within an
//                    hour hands it to the send function anyway, which holds it until the window
//                    opens: nothing goes out at night either way. Then the follow-up and its draft
//                    are claimed by compare-and-set writes, so a repeated command cannot send twice,
//                    and it goes through the send function on path "lifecycle" with the approved
//                    digest, which the send function verifies again;
//   fu-reject-<id>   drop it.
// This is the only way an offer (the upgrade offer, the win-back) is ever sent: a person approving
// it is what the permanently human class requires.
import { recordDraftDecision } from "../autonomy/evidence.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { isErased } from "../product-bridge/identity.ts";
import { label } from "../reports/format.ts";
import { draftDigest } from "../security/approval-digest.ts";
import { readSwitch } from "../sending/flags.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { DEFAULT_TIMEZONE, recipientTimezone } from "../sending/timezone.ts";
import type { SendOutreach } from "../sending/types.ts";
import { isWithinWindow, windowForPath } from "../sending/window.ts";
import { FOLLOWUP_LIMITS, FOLLOWUP_RULES, capProblem, isFollowupKind } from "./followup-rules.ts";
import { countedHistory, followupDraftKey, followupPreview, personLabel, safeSend, settleSend, tellOperator } from "./followups.ts";
import { LIFECYCLE_FLAGS } from "./flags.ts";

export type FollowupCommand = { action: "approve" | "reject"; id: string };

export const FOLLOWUP_HELP_LINES = ["fu-approve-<id> / fu-reject-<id>  send or drop a lifecycle follow-up drafted for you (it is checked again before it is sent)"];

const COMMAND = /^fu-(approve|reject)-([0-9a-f]{10})$/i;

/** The follow-up command in a message, or null. */
export function parseFollowupCommand(text: string): FollowupCommand | null {
  const match = COMMAND.exec(text.trim());
  if (!match) return null;
  return { action: (match[1] ?? "").toLowerCase() === "approve" ? "approve" : "reject", id: (match[2] ?? "").toLowerCase() };
}

export interface FollowupCommandDeps {
  db: D1Database;
  flags: FlagReader;
  config: Pick<GtmConfig, "sending">;
  /** The send function. Without it, approvals are refused. */
  send?: SendOutreach | undefined;
  operator?: OperatorChannel | undefined;
  chatId?: string | undefined;
  /** The operator's user id, recorded as who decided. */
  userId: string;
  now?: () => Date;
  log?: JobLogger;
}

interface CommandRow {
  id: string;
  contact_id: string;
  kind: string;
  state: string;
  entered_at: string;
  status: string;
  reason: string | null;
  draft_id: string | null;
  shown_digest: string | null;
  override_at: string | null;
  created_at: string;
  template_id: string | null;
  recipient_email: string | null;
  recipient_name: string | null;
  subject: string | null;
  body: string | null;
  draft_status: string | null;
  email: string | null;
  email_sha256: string | null;
  mailbox_sha256: string | null;
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  location: string | null;
  current_state: string | null;
  current_entered: string | null;
  product_user_id: string | null;
}

async function close(db: D1Database, row: CommandRow, status: "withdrawn" | "expired" | "rejected", reason: string, at: string, decidedBy: string | null = null): Promise<boolean> {
  const changed = await db
    .prepare("UPDATE lifecycle_followups SET status = ?2, reason = ?3, decided_by = COALESCE(?4, decided_by), updated_at = ?5 WHERE id = ?1 AND status = 'drafted'")
    .bind(row.id, status, reason, decidedBy, at)
    .run();
  if ((changed.meta.changes ?? 0) === 0) return false;
  if (row.draft_id) await db.prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE id = ?1 AND status = 'pending_approval'").bind(row.draft_id, at).run();
  return true;
}

/** Run a follow-up command and return the reply. Throws on a database error; the caller reports it. */
export async function runFollowupCommand(deps: FollowupCommandDeps, command: FollowupCommand): Promise<string> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  if (!(await readSwitch(deps.flags, LIFECYCLE_FLAGS.followups)) || !(await readSwitch(deps.flags, LIFECYCLE_FLAGS.enabled))) return "Lifecycle follow-ups are off (lifecycle:followups_enabled and lifecycle:enabled must both be on), so nothing was changed.";
  const row = await db
    .prepare(
      `SELECT f.id, f.contact_id, f.kind, f.state, f.entered_at, f.status, f.reason, f.draft_id, f.shown_digest, f.override_at, f.created_at, f.template_id,
              d.recipient_email, d.recipient_name, d.subject, d.body, d.status AS draft_status,
              c.email, c.email_sha256, c.mailbox_sha256, c.first_name, c.last_name, c.timezone, c.location,
              l.state AS current_state, l.state_changed_at AS current_entered, l.product_user_id
         FROM lifecycle_followups f
         LEFT JOIN drafts d ON d.id = f.draft_id
         LEFT JOIN contacts c ON c.id = f.contact_id
         LEFT JOIN contact_lifecycle l ON l.contact_id = f.contact_id
        WHERE f.id = ?1`,
    )
    .bind(command.id)
    .first<CommandRow>();
  if (!row || !isFollowupKind(row.kind)) return `There is no lifecycle follow-up ${command.id}.`;
  const rule = FOLLOWUP_RULES[row.kind];
  if (row.status !== "drafted") return `Follow-up ${row.id} is ${row.status}${row.reason ? ` (${label(row.reason, 120)})` : ""}, so nothing was changed.`;
  const actor = `operator:${deps.userId}`;
  const who = personLabel({ first_name: row.first_name, last_name: row.last_name, email: row.email ?? row.recipient_email ?? "(no address)" });

  if (command.action === "reject") {
    if (!(await close(db, row, "rejected", "rejected by the operator", at, actor))) return `Follow-up ${row.id} was already decided, so nothing was changed.`;
    if (row.draft_id) await recordDraftDecision(db, row.draft_id, "rejected", now);
    return `Dropped the ${rule.label} for ${who} [${row.id}]. Nothing was sent.`;
  }

  // Approve: everything is checked again, in order.
  if (!row.draft_id || row.draft_status !== "pending_approval" || row.recipient_email === null) return `Follow-up ${row.id} has no draft waiting for approval (it is ${row.draft_status ?? "missing"}), so nothing was sent.`;
  if (now.getTime() - Date.parse(row.created_at) > rule.maxDraftAgeMs) {
    await close(db, row, "expired", "not approved in time", at);
    return `The ${rule.label} for ${who} [${row.id}] is too old to send now, so it was dropped. Nothing was sent.`;
  }
  if (!row.email || row.current_state !== row.state || row.current_entered !== row.entered_at) {
    await close(db, row, "withdrawn", "the contact moved on", at);
    return `${who} is no longer ${row.state} as when the ${rule.label} was drafted, so it was withdrawn [${row.id}]. Nothing was sent.`;
  }
  const suppression = await checkSuppression(db, [row.recipient_email]);
  if (suppression.blocked.some((b) => b.reason === "check_failed")) return "The suppression list could not be read, so nothing was sent. Send the same command again to retry.";
  if (!suppression.ok || (await isErased(db, { userId: row.product_user_id, emailSha256: row.email_sha256, mailboxSha256: row.mailbox_sha256 }))) {
    await close(db, row, "withdrawn", "the address is suppressed or erased", at);
    return `The address for this follow-up is suppressed or erased, so it was withdrawn [${row.id}]. Nothing was sent.`;
  }
  const cap = capProblem(await countedHistory(db, row.contact_id, now, { exceptId: row.id, wentOutOnly: true }), now, rule);
  if (cap) {
    return cap === "cap"
      ? `${who} has had ${FOLLOWUP_LIMITS.capCount} follow-ups in the last 30 days, so nothing was sent [${row.id}].`
      : `${who} had another follow-up too recently for the ${rule.label}, so nothing was sent [${row.id}]. It can be approved until it expires.`;
  }
  const content = { to: row.recipient_email, subject: row.subject, body: row.body };
  const digest = await draftDigest(content);
  if (row.shown_digest !== digest) {
    // An approval covers exactly what was shown: show this version, and wait for a new command.
    const preview = followupPreview({ id: row.id, rule, who, enteredAt: row.entered_at, createdAt: row.created_at, to: row.recipient_email, subject: row.subject ?? "", body: row.body ?? "", notes: ["It changed since it was shown to you, or was never shown. This is the version an approval sends."] });
    if (await tellOperator({ operator: deps.operator, chatId: deps.chatId, log: deps.log }, preview)) {
      await db.prepare("UPDATE lifecycle_followups SET shown_digest = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'drafted'").bind(row.id, digest, at).run();
      return `Nothing was sent: review the version above, then send fu-approve-${row.id} again.`;
    }
    return "Nothing was sent: the follow-up could not be shown to you first. Send the same command again to retry.";
  }
  const window = windowForPath("lifecycle", deps.config.sending);
  const zone = recipientTimezone({ timezone: row.timezone, location: row.location }, DEFAULT_TIMEZONE).timezone;
  const outside = window !== null && !isWithinWindow(now, zone, window);
  if (outside) {
    const repeated = row.override_at !== null && now.getTime() - Date.parse(row.override_at) >= 0 && now.getTime() - Date.parse(row.override_at) <= FOLLOWUP_LIMITS.windowOverrideMs;
    if (!repeated) {
      await db.prepare("UPDATE lifecycle_followups SET override_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'drafted'").bind(row.id, at).run();
      return `It is outside ${who}'s sending window (weekdays, ${window.startHour}:00 to ${window.endHour}:00 in ${zone}), so nothing was sent. Send fu-approve-${row.id} again within an hour to hand it over now; it is still held until the window opens.`;
    }
  }
  if (!deps.send) return "No send function is configured for this deployment, so nothing was sent.";

  // The claims: the follow-up first, then the draft, each a compare-and-set.
  const claimed = await db.prepare("UPDATE lifecycle_followups SET status = 'sending', decided_by = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'drafted'").bind(row.id, actor, at).run();
  if ((claimed.meta.changes ?? 0) === 0) return `Follow-up ${row.id} was already decided, so nothing was sent.`;
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
      db.prepare("UPDATE lifecycle_followups SET status = 'drafted', decided_by = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'sending'").bind(row.id, at),
    ]);
  };
  if ((approved.meta.changes ?? 0) === 0) {
    await revert();
    return `The draft for follow-up ${row.id} changed while it was being approved, so nothing was sent. Send the same command again to see it.`;
  }
  const outcomes = await safeSend(deps.send, [
    {
      idempotencyKey: followupDraftKey(row.id),
      path: "lifecycle",
      contactId: row.contact_id,
      to: row.recipient_email,
      ...(row.recipient_name ? { toName: row.recipient_name } : {}),
      subject: row.subject ?? "",
      body: row.body ?? "",
      draftId: row.draft_id,
      approvedDigest: digest,
      ...(row.template_id ? { templateId: row.template_id } : {}),
    },
  ]);
  const settled = await settleSend(db, row.id, row.draft_id, outcomes[0], now);
  if (settled === "retry") {
    await revert();
    const outcome = outcomes[0];
    return `The ${rule.label} could not be sent now (${outcome && outcome.status === "failed" ? label(outcome.message, 120) : "no outcome"}). Nothing was sent; send the same command again later.`;
  }
  await recordDraftDecision(db, row.draft_id, "approved", now);
  if (settled === "sent") return `Sent the ${rule.label} to ${who} [${row.id}].`;
  if (settled === "queued") return `Approved the ${rule.label} for ${who} [${row.id}]. The send function holds it until it can go (the recipient's window or a send cap), then sends it.`;
  if (settled === "skipped") return `The send function refused the ${rule.label} for ${who} [${row.id}], so it was not sent.`;
  return `The ${rule.label} for ${who} [${row.id}] may or may not have gone out (the provider's answer was lost), so it will not be sent again.`;
}
