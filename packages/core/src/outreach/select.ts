// GTM-agents: the cold batch's selection: contacts who may get a first touch, in rank order.
//
// selectCandidates applies every rule that can be decided one contact at a time, in SQL:
//   - warmth cold and never contacted (no last_contacted_at, no row in the send ledger);
//   - a person-fit verdict of keep, and no account fit score below LOW_FIT_SCORE;
//   - not suppressed, opted out or erased (the canonical suppression check runs again on the picks);
//   - not cached undeliverable, and at or above the verification floor;
//   - no queued deferral and no open draft from the last RELEASE_MAX_AGE_DAYS;
//   - not in the holdout, not known to have moved jobs, and no open evidence conflict.
// Rows come back ordered by account fit (the model score, then the prescore), then oldest first,
// so a batch writes to the best-fitting accounts first. The rules that need the whole account (live
// threads, opt-outs at the account, the weekly cap, one per account) are the picker's (picker.ts).
//
// loadAccountState reads what the picker needs about accounts: which are in a live thread, which
// have someone who opted out or complained, and what each has already used of its weekly cap.
import { accountKey } from "../data/keys.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import type { ConfidenceFloor } from "./flags.ts";
import { HOLDOUT_DAYS } from "./holdout.ts";
import type { AccountUse } from "./picker.ts";

export const RELEASE_MAX_AGE_DAYS = 14;
/** Days a decline or a reply keeps the whole account out of cold outreach. */
export const LIVE_THREAD_DAYS = 90;
const DAY_MS = 86_400_000;
/** Rows read per account-state query. More than this fails the read, rather than drop accounts from a block. */
export const ACCOUNT_STATE_LIMIT = 50_000;
const FETCH_LIMIT = ACCOUNT_STATE_LIMIT + 1;

/** Deal stages past contacted: the account is in a conversation. */
export const LIVE_DEAL_STAGES = ["engaged", "demo_scheduled", "trial", "proposal", "negotiation", "closed_won"] as const;
/** Warmth from warming up: someone at the account is engaged. */
export const LIVE_WARMTH = ["warming", "engaged", "hot", "customer"] as const;

export interface SelectionRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  account_key: string | null;
  account_name: string | null;
  attributes: string | null;
  account_attributes: string | null;
  segment: string | null;
  team_size: string | null;
  persona: string | null;
  email_confidence: string | null;
  verification_status: string | null;
}

const CONFIDENCE_SETS: Readonly<Record<ConfidenceFloor, readonly string[]>> = {
  high: ["high"],
  medium: ["high", "medium"],
  low: ["high", "medium", "low"],
};

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
const quoted = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");

/** One page of selectable contacts, in rank order. Throws on a database error. */
export async function selectCandidates(db: D1Database, options: { limit: number; offset: number; floor: ConfidenceFloor; now: Date }): Promise<SelectionRow[]> {
  const confidence = CONFIDENCE_SETS[options.floor];
  // Cold mail goes only to deliverable addresses: the send function refuses anything else, so
  // selecting a risky address would only waste a slot. The floor narrows by email confidence.
  const verification = ["deliverable"];
  const { results } = await db
    .prepare(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.job_title, c.account_key, c.attributes,
              a.name AS account_name, a.attributes AS account_attributes,
              COALESCE(af.segment, a.segment) AS segment, af.team_size AS team_size,
              ac.persona AS persona, c.email_confidence, c.verification_status
         FROM contacts c
         JOIN contact_fit cf ON cf.contact_id = c.id AND cf.decision = 'keep'
         LEFT JOIN accounts a ON a.account_key = c.account_key
         LEFT JOIN account_fit af ON af.account_key = c.account_key
         LEFT JOIN account_contacts ac ON ac.contact_id = c.id AND ac.account_key = c.account_key
        WHERE c.warmth = 'cold'
          AND c.last_contacted_at IS NULL
          AND (af.fit_score IS NULL OR af.fit_score >= ${LOW_FIT_SCORE})
          AND c.email_confidence IN (${quoted(confidence)})
          AND c.verification_status IN (${quoted(verification)})
          AND (c.employment_status IS NULL OR c.employment_status <> 'moved')
          AND NOT EXISTS (SELECT 1 FROM outreach_sends os WHERE os.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email_sha256 IN (c.email_sha256, c.mailbox_sha256))
          AND NOT EXISTS (SELECT 1 FROM contact_lifecycle cl WHERE cl.contact_id = c.id AND cl.state IN ('opted_out', 'deleted'))
          AND NOT EXISTS (SELECT 1 FROM email_verifications ev WHERE ev.email_sha256 = c.email_sha256 AND ev.status = 'undeliverable')
          AND NOT EXISTS (SELECT 1 FROM deferred_sends ds WHERE ds.contact_id = c.id AND ds.status = 'queued')
          AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.contact_id = c.id AND d.status IN ('draft', 'pending_approval', 'approved') AND d.created_at >= ?3)
          AND NOT EXISTS (SELECT 1 FROM outreach_holdout oh WHERE oh.contact_id = c.id AND oh.held_at > ?4)
          AND NOT EXISTS (SELECT 1 FROM contact_evidence ce WHERE ce.contact_id = c.id AND ce.conflict = 1 AND ce.resolved_at IS NULL)
        ORDER BY (af.fit_score IS NULL), af.fit_score DESC, COALESCE(af.prescore, 0) DESC, c.created_at ASC, c.id ASC
        LIMIT ?1 OFFSET ?2`,
    )
    .bind(options.limit, options.offset, daysAgo(options.now, RELEASE_MAX_AGE_DAYS), daysAgo(options.now, HOLDOUT_DAYS))
    .all<SelectionRow>();
  return results;
}

export interface AccountState {
  live: Set<string>;
  optedOut: Set<string>;
  recent: AccountUse[];
}

function keysOf(rows: ReadonlyArray<{ k: string | null }>, into: Set<string>, fromAddress = false): void {
  for (const row of rows) {
    const key = row.k ? (fromAddress ? accountKey(row.k) : row.k) : null;
    if (key) into.add(key);
  }
}

/** What the picker needs about accounts. Throws on a database error: these blocks are gates. */
export async function loadAccountState(db: D1Database, now: Date): Promise<AccountState> {
  const since = daysAgo(now, LIVE_THREAD_DAYS);
  const weekAgo = daysAgo(now, 7);
  const today = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const draftWindow = daysAgo(now, RELEASE_MAX_AGE_DAYS);
  const [liveContacts, liveDeals, liveInbound, optedContacts, optedSuppressed, optedAddresses, complained, recent] = await db.batch<{ k: string | null; today?: number }>([
    db
      .prepare(
        `SELECT DISTINCT c.account_key AS k FROM contacts c
          WHERE c.account_key IS NOT NULL
            AND (c.warmth IN (${quoted(LIVE_WARMTH)})
              OR (c.declined_at IS NOT NULL AND c.declined_at > ?1)
              OR EXISTS (SELECT 1 FROM inbound_emails ie WHERE ie.contact_id = c.id AND ie.classification IN ('reply', 'new_inquiry') AND ie.received_at > ?1))
          LIMIT ${FETCH_LIMIT}`,
      )
      .bind(since),
    db.prepare(
      `SELECT DISTINCT COALESCE(d.account_key, c.account_key) AS k FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE d.stage IN (${quoted(LIVE_DEAL_STAGES)}) LIMIT ${FETCH_LIMIT}`,
    ),
    db.prepare(`SELECT DISTINCT sender_email AS k FROM inbound_emails WHERE classification IN ('reply', 'new_inquiry') AND received_at > ?1 LIMIT ${FETCH_LIMIT}`).bind(since),
    db.prepare(
      `SELECT DISTINCT c.account_key AS k FROM contacts c LEFT JOIN contact_lifecycle l ON l.contact_id = c.id
        WHERE c.account_key IS NOT NULL AND (c.warmth = 'opted_out' OR l.state IN ('opted_out', 'deleted')) LIMIT ${FETCH_LIMIT}`,
    ),
    db.prepare(
      `SELECT DISTINCT c.account_key AS k FROM suppression s JOIN contacts c ON s.email_sha256 IN (c.email_sha256, c.mailbox_sha256)
        WHERE s.reason IN ('opt_out', 'complaint') AND c.account_key IS NOT NULL LIMIT ${FETCH_LIMIT}`,
    ),
    db.prepare(`SELECT email AS k FROM suppression WHERE reason IN ('opt_out', 'complaint') AND email IS NOT NULL LIMIT ${FETCH_LIMIT}`),
    db.prepare(`SELECT DISTINCT account_key AS k FROM outreach_sends WHERE complained_at IS NOT NULL AND account_key IS NOT NULL LIMIT ${FETCH_LIMIT}`),
    db
      .prepare(
        `SELECT account_key AS k, (sent_at >= ?2) AS today FROM outreach_sends
          WHERE send_path IN ('cold', 'sequence') AND sent_at >= ?1 AND account_key IS NOT NULL
         UNION ALL
         SELECT c.account_key, 1 FROM deferred_sends ds JOIN contacts c ON c.id = ds.contact_id
          WHERE ds.status = 'queued' AND ds.send_path IN ('cold', 'sequence') AND c.account_key IS NOT NULL
         UNION ALL
         SELECT c.account_key, 1 FROM drafts d JOIN contacts c ON c.id = d.contact_id
          WHERE d.kind = 'cold_intro' AND d.status IN ('pending_approval', 'approved') AND d.created_at >= ?3 AND c.account_key IS NOT NULL
         LIMIT ${FETCH_LIMIT}`,
      )
      .bind(weekAgo, today, draftWindow),
  ]);
  const all = [liveContacts, liveDeals, liveInbound, optedContacts, optedSuppressed, optedAddresses, complained, recent];
  if (all.some((r) => (r?.results.length ?? 0) > ACCOUNT_STATE_LIMIT)) {
    throw new Error(`account state exceeds ${ACCOUNT_STATE_LIMIT} rows in one query; the account blocks cannot be applied whole`);
  }
  const live = new Set<string>();
  keysOf(liveContacts?.results ?? [], live);
  keysOf(liveDeals?.results ?? [], live);
  keysOf(liveInbound?.results ?? [], live, true);
  const optedOut = new Set<string>();
  keysOf(optedContacts?.results ?? [], optedOut);
  keysOf(optedSuppressed?.results ?? [], optedOut);
  keysOf(optedAddresses?.results ?? [], optedOut, true);
  keysOf(complained?.results ?? [], optedOut);
  const uses: AccountUse[] = [];
  for (const row of recent?.results ?? []) if (row.k) uses.push({ account_key: row.k, today: Number(row.today ?? 0) === 1 });
  return { live, optedOut, recent: uses };
}
