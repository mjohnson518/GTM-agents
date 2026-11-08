// GTM-agents: the manual channel step: a short note the operator sends by hand on LinkedIn or X
// before the last email of a sequence.
//
// Behind followup:manual_channel_enabled (default off). When a row is about to take the last step
// and the flag is on, the sweep:
//   - the first time: stores a manual touch (manual_touches) with a fixed note of at most 300
//     characters (the contact's first name, the first email's subject and the sender's name, all
//     from the database and gtm.config.ts), asks the operator to send it and mark it with
//     `channel-done-<id> [linkedin|x]` or `channel-skip-<id>`, and makes the last step wait;
//   - while the touch is pending and younger than 5 days: the last step keeps waiting;
//   - once it is marked done or skipped, or 5 days pass: the last step goes as usual.
// Nothing is posted anywhere automatically. A done touch is recorded in the contact's history
// (outreach_log, channel linkedin or x, provider manual), never in the email send ledger, so it
// never counts as an email in a metric, a cap or a bounce rate. At most 10 touches are asked for
// per UTC day; past that the last step goes without one.
//
// The step is an optional extra touch, not a safety check: if the touches cannot be read or
// written, the last step goes as it would without the flag. Every gate still runs before it.
import { usableFirstName } from "../quality/gate.ts";
import { SEQUENCE_LIMITS } from "./flags.ts";
import type { DueRow } from "./rows.ts";
import { rowKey } from "./rows.ts";
import { stripReplyPrefix } from "./threading.ts";

const DAY_MS = 86_400_000;

export type ManualChannel = "linkedin" | "x";

export interface ManualTouch {
  id: string;
  campaignId: string;
  contactId: string;
  body: string;
  expiresAt: string;
}

export type ManualGate = { kind: "proceed" } | { kind: "wait"; until: string; created: ManualTouch | null };

/** The note the operator sends by hand. Fixed text, at most 300 characters. Pure. */
export function composeManualNote(input: { firstName: string | null; firstSubject: string; senderName: string }): string {
  const name = usableFirstName(input.firstName);
  const hi = name ? `Hi ${name},` : "Hi,";
  const close = "If it is easier to pick it up here, I am happy to.";
  const subject = stripReplyPrefix(input.firstSubject).replace(/\s+/g, " ").slice(0, 120);
  const full = [hi, `I sent you a short email about "${subject}".`, close, input.senderName].join(" ");
  if (subject !== "" && full.length <= SEQUENCE_LIMITS.manualTouchMaxChars) return full;
  return [hi, "I sent you a short email recently.", close, input.senderName].join(" ").slice(0, SEQUENCE_LIMITS.manualTouchMaxChars);
}

export const newTouchId = (): string => `mt${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

interface TouchRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: string;
  expires_at: string;
}

/**
 * The manual-channel decision for rows about to take their last step. Never throws: on any error
 * every row proceeds, as it would with the flag off.
 */
export async function manualGates(
  db: D1Database,
  rows: ReadonlyArray<{ row: DueRow; firstSubject: string }>,
  options: { now: Date; senderName: string; perDay?: number },
): Promise<Map<string, ManualGate>> {
  const gates = new Map<string, ManualGate>();
  if (rows.length === 0) return gates;
  const now = options.now;
  const at = now.toISOString();
  try {
    const pairs = rows.map((r) => [r.row.campaign_id, r.row.contact_id]);
    const { results } = await db
      .prepare(
        `SELECT t.id, t.campaign_id, t.contact_id, t.status, t.expires_at FROM manual_touches t
          WHERE EXISTS (SELECT 1 FROM json_each(?1) j WHERE json_extract(j.value, '$[0]') = t.campaign_id AND json_extract(j.value, '$[1]') = t.contact_id)
          ORDER BY t.created_at ASC`,
      )
      .bind(JSON.stringify(pairs))
      .all<TouchRow>();
    const existing = new Map<string, TouchRow>();
    for (const t of results) {
      const key = rowKey({ campaignId: t.campaign_id, contactId: t.contact_id });
      if (!existing.has(key)) existing.set(key, t);
    }
    const today = await db.prepare("SELECT COUNT(*) AS n FROM manual_touches WHERE created_at >= ?1").bind(`${at.slice(0, 10)}T00:00:00.000Z`).first<{ n: number }>();
    let room = Math.max(0, (options.perDay ?? SEQUENCE_LIMITS.manualTouchesPerDay) - Number(today?.n ?? 0));
    for (const { row, firstSubject } of rows) {
      const key = rowKey({ campaignId: row.campaign_id, contactId: row.contact_id });
      const touch = existing.get(key);
      if (touch) {
        if (touch.status !== "pending") gates.set(key, { kind: "proceed" });
        else if (touch.expires_at <= at) {
          await db.prepare("UPDATE manual_touches SET status = 'expired', decided_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(touch.id, at).run();
          gates.set(key, { kind: "proceed" });
        } else gates.set(key, { kind: "wait", until: touch.expires_at, created: null });
        continue;
      }
      if (room <= 0) {
        gates.set(key, { kind: "proceed" });
        continue;
      }
      const created: ManualTouch = {
        id: newTouchId(),
        campaignId: row.campaign_id,
        contactId: row.contact_id,
        body: composeManualNote({ firstName: row.first_name, firstSubject, senderName: options.senderName }),
        expiresAt: new Date(now.getTime() + SEQUENCE_LIMITS.manualTouchDays * DAY_MS).toISOString(),
      };
      const inserted = await db
        .prepare(
          `INSERT INTO manual_touches (id, campaign_id, contact_id, channel, body, status, expires_at, created_at)
           SELECT ?1, ?2, ?3, NULL, ?4, 'pending', ?5, ?6
            WHERE NOT EXISTS (SELECT 1 FROM manual_touches WHERE campaign_id = ?2 AND contact_id = ?3)`,
        )
        .bind(created.id, created.campaignId, created.contactId, created.body, created.expiresAt, at)
        .run();
      const won = (inserted.meta.changes ?? 0) > 0;
      if (won) room -= 1;
      // Another sweep asked for it first: wait on that one.
      gates.set(key, { kind: "wait", until: created.expiresAt, created: won ? created : null });
    }
    return gates;
  } catch {
    for (const { row } of rows) gates.set(rowKey({ campaignId: row.campaign_id, contactId: row.contact_id }), { kind: "proceed" });
    return gates;
  }
}

/** The operator's message for touches asked for in one sweep. */
export function manualTouchText(touches: ReadonlyArray<{ touch: ManualTouch; to: string; accountName: string | null }>): string {
  const lines = [`Manual touch${touches.length === 1 ? "" : "es"} before the last follow-up: send ${touches.length === 1 ? "this note" : "these notes"} by hand on LinkedIn or X. Nothing is posted for you.`];
  for (const { touch, to, accountName } of touches.slice(0, SEQUENCE_LIMITS.listed)) {
    lines.push(
      "",
      `To ${to}${accountName ? ` at ${accountName}` : ""}:`,
      touch.body,
      `Sent it on LinkedIn: channel-done-${touch.id} (on X: channel-done-${touch.id} x). Not sending it: channel-skip-${touch.id}`,
    );
  }
  if (touches.length > SEQUENCE_LIMITS.listed) lines.push("", `And ${touches.length - SEQUENCE_LIMITS.listed} more; each waits the same way.`);
  lines.push("", `The last email to each waits until you mark it, or ${SEQUENCE_LIMITS.manualTouchDays} days.`);
  return lines.join("\n");
}

/**
 * Record the operator's answer for a manual touch. Done logs the touch in the contact's history;
 * both make the last step due now (every check still runs before it goes). Throws on a database
 * error. Returns the reply text.
 */
export async function recordManualTouch(db: D1Database, input: { id: string; decision: "done" | "skip"; channel: ManualChannel; by: string; now: Date }): Promise<string> {
  const at = input.now.toISOString();
  const status = input.decision === "done" ? "done" : "skipped";
  const claimed = await db
    .prepare("UPDATE manual_touches SET status = ?2, channel = ?3, decided_at = ?4, decided_by = ?5 WHERE id = ?1 AND status = 'pending'")
    .bind(input.id, status, input.decision === "done" ? input.channel : null, at, input.by.slice(0, 80))
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    const row = await db.prepare("SELECT status FROM manual_touches WHERE id = ?1").bind(input.id).first<{ status: string }>();
    return row ? `Manual touch ${input.id} is already ${row.status}; nothing changed.` : `There is no manual touch ${input.id}.`;
  }
  const touch = await db.prepare("SELECT campaign_id, contact_id FROM manual_touches WHERE id = ?1").bind(input.id).first<{ campaign_id: string | null; contact_id: string }>();
  if (touch && input.decision === "done") {
    await db
      .prepare("INSERT INTO outreach_log (id, contact_id, channel, direction, subject, summary, outcome, provider, created_at) VALUES (?1, ?2, ?3, 'outbound', NULL, ?4, 'sent', 'manual', ?5)")
      .bind(crypto.randomUUID(), touch.contact_id, input.channel, "manual touch before the last follow-up", at)
      .run();
  }
  if (touch?.campaign_id) {
    await db
      .prepare("UPDATE campaign_contacts SET next_send_at = ?3, updated_at = ?3 WHERE campaign_id = ?1 AND contact_id = ?2 AND sequence_active = 1 AND (next_send_at IS NULL OR next_send_at > ?3)")
      .bind(touch.campaign_id, touch.contact_id, at)
      .run();
  }
  const where = input.channel === "x" ? "X" : "LinkedIn";
  return input.decision === "done" ? `Recorded the ${where} touch. The last follow-up email goes on the next sweep, after every check runs again.` : "Skipped. The last follow-up email goes on the next sweep, after every check runs again.";
}
