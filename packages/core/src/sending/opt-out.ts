// GTM-agents: opting an address out, the one routine behind the unsubscribe link, a provider's
// unsubscribe event, a spam complaint and a hard bounce.
//
// In order:
//   1. suppress the address (opt_out, complaint or bounce). This is the compliance control, so it
//      runs first and a database error propagates: the caller answers so the request is retried
//      (the unsubscribe page asks the person to try again; a provider webhook gets a 500);
//   2. then, as bookkeeping, each write caught and reported:
//      - an opt-out or a complaint moves every contact stored under the same mailbox to warmth
//        opted_out (forward-only, compare-and-set, through advanceWarmth). A hard bounce is not an
//        opt-out: their warmth stays where it was, and the address is marked undeliverable on the
//        contacts and in the verification cache instead;
//      - their sequences stop (stopSequences): campaign_contacts rows go inactive and are marked
//        opted_out (bounced for a bounce), and running sequence runs are cancelled;
//      - queued deferred sends to them are cancelled.
// It is idempotent: suppression keeps its first reason, warmth stays opted_out, and the updates
// only touch rows still active.
import { advanceWarmth } from "../data/contacts.ts";
import { stopSequences } from "../sequences/state.ts";
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

  const ids = JSON.stringify(contactIds);
  if (options.reason === "bounce") {
    await attempt("verification", () =>
      db.batch([
        db
          .prepare(
            `INSERT INTO email_verifications (email_sha256, status, provider, verified_at, created_at) VALUES (?1, 'undeliverable', 'hard_bounce', ?2, ?2)
             ON CONFLICT (email_sha256) DO UPDATE SET status = 'undeliverable', provider = 'hard_bounce', verified_at = excluded.verified_at`,
          )
          .bind(exact, now),
        db.prepare("UPDATE contacts SET verification_status = 'undeliverable', updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))").bind(ids, now),
      ]),
    );
  } else {
    for (const id of contactIds) await attempt("warmth", () => advanceWarmth(db, id, "opted_out", new Date(now)));
  }

  if (contactIds.length > 0) {
    await attempt("sequences", () => stopSequences(db, { contactIds }, { reason: options.reason, status: options.reason === "bounce" ? "bounced" : "opted_out", now: new Date(now) }));
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
