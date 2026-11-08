// GTM-agents: opting an address out, the one routine behind the unsubscribe link, a provider's
// unsubscribe event, a spam complaint and a hard bounce.
//
// In order:
//   1. suppress the address (opt_out, complaint or bounce). This is the compliance control, so it
//      runs first and a database error propagates: the caller answers so the request is retried
//      (the unsubscribe page asks the person to try again; a provider webhook gets a 500);
//   2. then, as bookkeeping, each write caught and reported:
//      - every contact stored under the same mailbox moves to warmth opted_out (forward-only,
//        compare-and-set, through advanceWarmth);
//      - their sequences stop: campaign_contacts rows go inactive and are marked opted_out (bounced
//        for a bounce), and running sequence runs are cancelled;
//      - queued deferred sends to them are cancelled.
// It is idempotent: suppression keeps its first reason, warmth stays opted_out, and the updates
// only touch rows still active.
import { advanceWarmth } from "../data/contacts.ts";
import { addSuppression, addressHash, mailboxOf, normalizeAddress, type SuppressionReason } from "./suppression.ts";

export type OptOutReason = Extract<SuppressionReason, "opt_out" | "complaint" | "bounce">;

export interface OptOutResult {
  address: string;
  emailSha256: string;
  /** True when this call added the suppression entry (false when it was already there). */
  newlySuppressed: boolean;
  contactIds: string[];
  failedWrites: string[];
}

export interface OptOutOptions {
  reason: OptOutReason;
  /** Where the opt-out came from, kept on the suppression row: "unsubscribe_link", "provider_webhook". */
  source: string;
  notes?: string;
  now?: Date;
}

/** Opt an address out. Throws when it cannot be parsed or the suppression entry cannot be written. */
export async function optOutAddress(db: D1Database, rawAddress: string, options: OptOutOptions): Promise<OptOutResult> {
  const address = normalizeAddress(rawAddress);
  if (!address) throw new TypeError("the address to opt out cannot be parsed");
  const now = (options.now ?? new Date()).toISOString();
  const added = await addSuppression(db, { email: address, reason: options.reason, source: options.source, ...(options.notes ? { notes: options.notes.slice(0, 300) } : {}) });
  const failedWrites: string[] = [];
  const attempt = async (name: string, write: () => Promise<unknown>) => {
    try {
      await write();
    } catch {
      failedWrites.push(name);
    }
  };

  let contactIds: string[] = [];
  const exact = added.emailSha256;
  const mailbox = await addressHash(mailboxOf(address));
  await attempt("contacts_lookup", async () => {
    const { results } = await db
      .prepare("SELECT id FROM contacts WHERE email_sha256 IN (?1, ?2) OR mailbox_sha256 = ?2")
      .bind(exact, mailbox)
      .all<{ id: string }>();
    contactIds = results.map((r) => r.id);
  });

  for (const id of contactIds) await attempt("warmth", () => advanceWarmth(db, id, "opted_out", new Date(now)));

  const ids = JSON.stringify(contactIds);
  const status = options.reason === "bounce" ? "bounced" : "opted_out";
  if (contactIds.length > 0) {
    await attempt("campaign_contacts", () =>
      db
        .prepare(
          `UPDATE campaign_contacts
              SET sequence_active = 0, next_send_at = NULL,
                  sequence_paused_at = COALESCE(sequence_paused_at, ?2), sequence_pause_reason = COALESCE(sequence_pause_reason, ?3),
                  status = CASE WHEN status IN ('pending', 'sent', 'skipped') THEN ?4 ELSE status END, updated_at = ?2
            WHERE contact_id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(ids, now, options.reason, status)
        .run(),
    );
    await attempt("sequence_runs", () =>
      db
        .prepare(
          `UPDATE outreach_sequence_runs SET status = 'cancelled', exit_reason = ?3, completed_at = ?2, last_event_at = ?2
            WHERE contact_id IN (SELECT value FROM json_each(?1)) AND status IN ('running', 'awaiting_decision')`,
        )
        .bind(ids, now, options.reason)
        .run(),
    );
  }
  await attempt("deferred_sends", () =>
    db
      .prepare(
        `UPDATE deferred_sends SET status = 'cancelled', last_error = ?3
          WHERE status = 'queued' AND (contact_id IN (SELECT value FROM json_each(?1)) OR lower(trim(recipient_email)) = ?2)`,
      )
      .bind(ids, address, `cancelled: ${options.reason}`)
      .run(),
  );

  return { address, emailSha256: exact, newlySuppressed: added.added, contactIds, failedWrites };
}
