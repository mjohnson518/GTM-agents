// GTM-agents: the checks every sequence step passes before it is drafted, released or sent.
//
// In order, per row:
//   1. the reply check: any inbound mail in the last 30 days from the contact (by contact id or by
//      address), or from anyone at the same account (a contact at the account, or a sender whose
//      domain is the account's domain or a subdomain of it), that is classified as a reply, an
//      inquiry or an unsubscribe, or is not classified yet, stops the sequence for the whole account;
//   2. the account rules (loadAccountState): someone at the account is in a conversation (warming
//      or warmer, a deal past contacted, a reply or a decline in 90 days), or opted out or
//      complained: the sequence ends;
//   3. the contact: person fit no longer keep (or no verdict), on the brain's never list, moved
//      jobs, warmth past contacted, opted out or erased, suppressed, or an address known to be
//      undeliverable: the sequence ends. A contact with no account pauses, since the account rules
//      cannot be applied to it.
// These are gates, so they fail closed: if the reply check, the account state or the suppression
// list cannot be read, checkRows reports a failure and nothing is drafted or sent for any row.
import type { AccountState } from "../outreach/select.ts";
import { loadAccountState } from "../outreach/select.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { matchNeverList, type NeverList } from "../sourcing/identity.ts";
import { SEQUENCE_LIMITS } from "./flags.ts";
import type { DueRow } from "./rows.ts";
import { rowKey } from "./rows.ts";
import { SEQUENCE_STOPPING_CLASSIFICATIONS } from "./state.ts";

const DAY_MS = 86_400_000;

export type RowVerdict =
  | { kind: "go" }
  /** Mail from the account: stop every sequence at the account (stopSequences, status replied). */
  | { kind: "stop"; reason: string }
  /** The sequence ends for this contact; its campaign status is kept. */
  | { kind: "end"; reason: string }
  /** The sequence waits for an operator. */
  | { kind: "pause"; reason: string };

export type ChecksResult = { ok: true; verdicts: Map<string, RowVerdict> } | { ok: false; reason: string };

/** Warmth from here on means the contact is past a cold sequence. */
const PAST_CONTACTED = new Set(["warming", "engaged", "hot", "customer", "churned", "opted_out"]);

const STOPPING_SQL = SEQUENCE_STOPPING_CLASSIFICATIONS.map((c) => `'${c}'`).join(", ");

/**
 * The contact ids among `rows` with stopping inbound mail since `since`. Throws on a database error.
 * Exported so the release path and the tests run exactly the same check.
 */
export async function contactsWithReplies(db: D1Database, rows: ReadonlyArray<Pick<DueRow, "contact_id" | "email" | "account_key">>, since: Date): Promise<Set<string>> {
  const found = new Set<string>();
  const candidates = [...new Map(rows.map((r) => [r.contact_id, [r.contact_id, r.email.toLowerCase(), r.account_key ? r.account_key.toLowerCase() : null]])).values()];
  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const { results } = await db
      .prepare(
        `WITH cand AS (
           SELECT json_extract(j.value, '$[0]') AS contact_id, json_extract(j.value, '$[1]') AS email, json_extract(j.value, '$[2]') AS account
             FROM json_each(?1) j)
         SELECT cand.contact_id AS id FROM cand
          WHERE EXISTS (
            SELECT 1 FROM inbound_emails ie
             WHERE ie.received_at >= ?2
               AND (ie.classification IS NULL OR ie.classification IN (${STOPPING_SQL}))
               AND (ie.contact_id = cand.contact_id
                 OR lower(ie.sender_email) = cand.email
                 OR (cand.account IS NOT NULL AND (
                      ie.contact_id IN (SELECT c.id FROM contacts c WHERE c.account_key = cand.account)
                   OR lower(substr(ie.sender_email, instr(ie.sender_email, '@') + 1)) = cand.account
                   OR substr(lower(substr(ie.sender_email, instr(ie.sender_email, '@') + 1)), -(length(cand.account) + 1)) = '.' || cand.account))))`,
      )
      .bind(JSON.stringify(chunk), since.toISOString())
      .all<{ id: string }>();
    for (const r of results) found.add(r.id);
  }
  return found;
}

/** Contact ids that were erased (an unresolved erasure tombstone matches their address). Throws on a database error. */
async function erasedContacts(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT c.id FROM contacts c WHERE c.id IN (${chunk.map((_, k) => `?${k + 1}`).join(", ")})
           AND EXISTS (SELECT 1 FROM erasure_tombstones t WHERE t.resolved_at IS NULL AND (t.email_sha256 = c.email_sha256 OR t.mailbox_sha256 = c.mailbox_sha256))`,
      )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of results) found.add(r.id);
  }
  return found;
}

/** The contact rules (3), for one row. Null when the row passes them. */
export function contactRule(row: DueRow, never: NeverList): RowVerdict | null {
  if (row.fit_decision !== "keep") return { kind: "end", reason: `person fit is ${row.fit_decision ?? "missing"}, no longer keep` };
  const listed = matchNeverList(never, { domain: row.account_key, accountName: row.account_name, title: row.job_title });
  if (listed) return { kind: "end", reason: listed };
  if (row.employment_status === "moved") return { kind: "end", reason: "the contact moved jobs" };
  if (row.lifecycle_state === "opted_out" || row.lifecycle_state === "deleted") return { kind: "end", reason: "the contact opted out" };
  if (PAST_CONTACTED.has(row.warmth)) return { kind: "end", reason: `the contact's warmth is ${row.warmth}, past a cold sequence` };
  if (row.verification_status === "undeliverable") return { kind: "end", reason: "the address is known to be undeliverable" };
  if (!row.account_key) return { kind: "pause", reason: "the contact has no account, so the account rules cannot be applied" };
  return null;
}

/** Run every check over `rows`. Never throws: a read error is { ok: false } and no row may go. */
export async function checkRows(db: D1Database, rows: readonly DueRow[], options: { now: Date; never: NeverList; accounts?: AccountState }): Promise<ChecksResult> {
  const verdicts = new Map<string, RowVerdict>();
  if (rows.length === 0) return { ok: true, verdicts };
  let replied: Set<string>;
  try {
    replied = await contactsWithReplies(db, rows, new Date(options.now.getTime() - SEQUENCE_LIMITS.replyLookbackDays * DAY_MS));
  } catch {
    return { ok: false, reason: "the reply check could not read inbound mail" };
  }
  let accounts: AccountState;
  try {
    accounts = options.accounts ?? (await loadAccountState(db, options.now));
  } catch {
    return { ok: false, reason: "the account rules could not be read" };
  }
  let suppressed: Map<string, string>;
  let erased: Set<string>;
  try {
    const check = await checkSuppression(db, rows.map((r) => r.email));
    if (check.blocked.some((b) => b.reason === "check_failed")) return { ok: false, reason: "the suppression list could not be read" };
    suppressed = new Map(check.blocked.map((b) => [b.recipient, b.reason]));
    erased = await erasedContacts(db, [...new Set(rows.map((r) => r.contact_id))]);
  } catch {
    return { ok: false, reason: "the suppression list could not be read" };
  }
  for (const row of rows) {
    const key = rowKey({ campaignId: row.campaign_id, contactId: row.contact_id });
    if (replied.has(row.contact_id)) {
      verdicts.set(key, { kind: "stop", reason: `mail from the contact or someone at ${row.account_key ?? "the account"} in the last ${SEQUENCE_LIMITS.replyLookbackDays} days (a reply, an inquiry, an unsubscribe or mail not yet triaged)` });
      continue;
    }
    if (row.account_key && accounts.live.has(row.account_key)) {
      verdicts.set(key, { kind: "end", reason: "someone at the account is in a conversation" });
      continue;
    }
    if (row.account_key && accounts.optedOut.has(row.account_key)) {
      verdicts.set(key, { kind: "end", reason: "someone at the account opted out or complained" });
      continue;
    }
    const suppression = suppressed.get(row.email);
    if (suppression) {
      verdicts.set(key, { kind: "end", reason: `the address is suppressed (${suppression})` });
      continue;
    }
    if (erased.has(row.contact_id)) {
      verdicts.set(key, { kind: "end", reason: "the contact was erased" });
      continue;
    }
    verdicts.set(key, contactRule(row, options.never) ?? { kind: "go" });
  }
  return { ok: true, verdicts };
}
