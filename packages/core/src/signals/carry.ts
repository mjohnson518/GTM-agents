// GTM-agents: signal carry: an account-level signal found before the account had contacts is copied
// to the first contacts promoted there.
//
// A signal recorded while an account had no never-contacted, keep-listed contact is held at account
// level (record.ts). For 72 hours after it was detected, carrySignals copies it to a newly promoted
// contact when all of these hold:
//   - the contact is cold, has never been contacted (no last_contacted_at, nothing on the send
//     ledger), has a deliverable verification, and has had no signal of its own in 90 days;
//   - the signal is still new and unexpired, and has been copied to fewer than 2 contacts;
//   - it is not a category or source that is never carried: a job change (it is about another
//     person), a multithread marker, or anything derived from product usage (privacy: what one
//     person does in the product is never told to a colleague).
// Only the strongest qualifying signal is copied, so a contact carries at most one. The copy keeps
// the original's category, URL, event date, evidence and expiry; only the contact differs. Carry is
// bookkeeping on the promotion path: an error is logged and dropped, never failing the promotion.
import { NEVER_CARRIED_SOURCES, NEVER_CARRIED_TYPES, signalId } from "./record.ts";
import { SIGNAL_LIMITS } from "./flags.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const quoted = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");

interface HeldSignal {
  id: string;
  type: string;
  account_key: string;
  entity_id: string;
  headline: string;
  evidence: string | null;
  source_url: string;
  source: string;
  severity: number;
  event_date: string;
  expires_at: string;
}

/** Copy the strongest held account-level signal to one newly promoted contact. True when a copy was written. */
export async function carrySignals(db: D1Database, contactId: string, now: Date): Promise<boolean> {
  const stamp = now.toISOString();
  const contact = await db
    .prepare(
      `SELECT c.id, c.account_key FROM contacts c
        WHERE c.id = ?1 AND c.warmth = 'cold' AND c.last_contacted_at IS NULL AND c.verification_status = 'deliverable'
          AND c.account_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM outreach_sends s WHERE s.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM signal_events e WHERE e.contact_id = c.id AND e.detected_at >= ?2)`,
    )
    .bind(contactId, new Date(now.getTime() - SIGNAL_LIMITS.carryQuietDays * DAY_MS).toISOString())
    .first<{ id: string; account_key: string }>();
  if (!contact) return false;
  const { results } = await db
    .prepare(
      `SELECT id, type, account_key, entity_id, headline, evidence, source_url, source, severity, event_date, expires_at FROM signal_events e
        WHERE e.account_key = ?1 AND e.contact_id IS NULL AND e.status = 'new'
          AND e.detected_at >= ?2 AND e.expires_at IS NOT NULL AND e.expires_at > ?3
          AND e.source_url IS NOT NULL AND e.event_date IS NOT NULL AND e.entity_id IS NOT NULL
          AND e.type NOT IN (${quoted(NEVER_CARRIED_TYPES)}) AND (e.source IS NULL OR e.source NOT IN (${quoted(NEVER_CARRIED_SOURCES)}))
          AND (SELECT COUNT(*) FROM signal_events k WHERE k.source = e.source AND k.entity_id = e.entity_id AND k.account_key = e.account_key AND k.contact_id IS NOT NULL) < ?4
        ORDER BY e.severity DESC, e.event_date DESC, e.id LIMIT 1`,
    )
    .bind(contact.account_key, new Date(now.getTime() - SIGNAL_LIMITS.carryHoldHours * HOUR_MS).toISOString(), stamp, SIGNAL_LIMITS.carryMaxContacts)
    .all<HeldSignal>();
  const held = results[0];
  if (!held) return false;
  const id = await signalId(held.source, held.entity_id, `contact:${contact.id}`);
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO signal_events (id, type, account_key, contact_id, entity_id, headline, evidence, source_url, source, severity, status, event_date, detected_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', ?11, ?12, ?13)`,
    )
    .bind(id, held.type, held.account_key, contact.id, held.entity_id, held.headline, held.evidence, held.source_url, held.source, held.severity, held.event_date, stamp, held.expires_at)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
