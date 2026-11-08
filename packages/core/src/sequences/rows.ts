// GTM-agents: what the follow-up sweep reads: due sequence rows with their contact, and each row's
// earlier steps from the send ledger.
//
// A row is due when its sequence is active, not paused, and next_send_at has passed. Each row comes
// with everything the checks and the composer need about the contact and the account, in one query.
// The ledger (outreach_sends) is the truth about which steps went out, when, under which subject and
// with which Message-ID; the row's own sequence_step is a summary of it that a failed write can leave
// behind, so the sweep reconciles the two before taking a step.
import { inChunks, placeholders } from "../data/d1.ts";
import type { SelectionRow } from "../outreach/select.ts";
import type { SequenceRowKey } from "./state.ts";

/** A due row, with its contact. Its contact columns are a cold selection row's, so the composer can read it. */
export interface DueRow extends SelectionRow {
  campaign_id: string;
  contact_id: string;
  /** The last step that went out. */
  sequence_step: number | null;
  next_send_at: string | null;
  warmth: string;
  employment_status: string | null;
  fit_decision: string | null;
  lifecycle_state: string | null;
}

/** One earlier step from the send ledger. */
export interface PriorSend {
  id: string;
  contact_id: string;
  campaign_id: string;
  sequence_step: number;
  subject: string | null;
  template_id: string | null;
  provider: string;
  provider_message_id: string | null;
  message_id: string | null;
  sent_at: string;
}

export const rowKey = (row: SequenceRowKey): string => `${row.campaignId}\u0000${row.contactId}`;
export const keyOf = (row: Pick<DueRow, "campaign_id" | "contact_id">): SequenceRowKey => ({ campaignId: row.campaign_id, contactId: row.contact_id });

const ROW_COLUMNS = `cc.campaign_id, cc.contact_id, cc.sequence_step, cc.next_send_at,
       c.id, c.email, c.first_name, c.last_name, c.job_title, c.account_key, c.attributes,
       a.name AS account_name, a.attributes AS account_attributes,
       COALESCE(af.segment, a.segment) AS segment, af.team_size AS team_size, ac.persona AS persona,
       c.email_confidence, c.verification_status, c.warmth, c.employment_status,
       cf.decision AS fit_decision, l.state AS lifecycle_state`;

const ROW_JOINS = `FROM campaign_contacts cc
  JOIN contacts c ON c.id = cc.contact_id
  LEFT JOIN accounts a ON a.account_key = c.account_key
  LEFT JOIN account_fit af ON af.account_key = c.account_key
  LEFT JOIN account_contacts ac ON ac.contact_id = c.id AND ac.account_key = c.account_key
  LEFT JOIN contact_fit cf ON cf.contact_id = c.id
  LEFT JOIN contact_lifecycle l ON l.contact_id = c.id`;

/** Due rows, oldest due first, at most `limit`. Throws on a database error. */
export async function loadDueRows(db: D1Database, options: { now: Date; limit: number }): Promise<DueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} ${ROW_JOINS}
        WHERE cc.sequence_active = 1 AND cc.sequence_paused_at IS NULL AND cc.next_send_at IS NOT NULL AND cc.next_send_at <= ?1
        ORDER BY cc.next_send_at ASC, cc.campaign_id ASC, cc.contact_id ASC
        LIMIT ?2`,
    )
    .bind(options.now.toISOString(), Math.max(0, Math.floor(options.limit)))
    .all<DueRow>();
  return results;
}

/** Specific rows, whatever their state, with the same columns. Missing rows are left out. Throws on a database error. */
export async function loadRows(db: D1Database, keys: readonly SequenceRowKey[]): Promise<Array<DueRow & { sequence_active: number; sequence_paused_at: string | null }>> {
  const out: Array<DueRow & { sequence_active: number; sequence_paused_at: string | null }> = [];
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200).map((k) => [k.campaignId, k.contactId]);
    const { results } = await db
      .prepare(
        `SELECT ${ROW_COLUMNS}, cc.sequence_active, cc.sequence_paused_at ${ROW_JOINS}
          WHERE EXISTS (SELECT 1 FROM json_each(?1) j WHERE json_extract(j.value, '$[0]') = cc.campaign_id AND json_extract(j.value, '$[1]') = cc.contact_id)`,
      )
      .bind(JSON.stringify(chunk))
      .all<DueRow & { sequence_active: number; sequence_paused_at: string | null }>();
    out.push(...results);
  }
  return out;
}

/** Each row's earlier steps from the send ledger, sorted by step (the first send of each step). Throws on a database error. */
export async function loadPriorSends(db: D1Database, rows: readonly SequenceRowKey[]): Promise<Map<string, PriorSend[]>> {
  const wanted = new Set(rows.map(rowKey));
  const byRow = new Map<string, PriorSend[]>();
  for (const chunk of inChunks([...new Set(rows.map((r) => r.contactId))])) {
    const { results } = await db
      .prepare(
        `SELECT id, contact_id, campaign_id, sequence_step, subject, template_id, provider, provider_message_id, message_id, sent_at
           FROM outreach_sends
          WHERE contact_id IN (${placeholders(chunk.length)}) AND send_path IN ('cold', 'sequence') AND sequence_step IS NOT NULL AND campaign_id IS NOT NULL
          ORDER BY sequence_step ASC, sent_at ASC, id ASC`,
      )
      .bind(...chunk)
      .all<PriorSend>();
    for (const send of results) {
      const key = rowKey({ campaignId: send.campaign_id, contactId: send.contact_id });
      if (!wanted.has(key)) continue;
      const list = byRow.get(key) ?? [];
      if (!list.some((s) => s.sequence_step === send.sequence_step)) list.push(send);
      byRow.set(key, list);
    }
  }
  return byRow;
}
