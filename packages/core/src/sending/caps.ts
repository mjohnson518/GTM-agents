// GTM-agents: the send caps, counted from the per-send ledger (outreach_sends), the database being
// the truth.
//
//   - Per sending domain: messages through the provider in the current UTC day, at most
//     delivery:domain_daily_cap (default 500). Everything this send function sends goes from the
//     isolated sending domain, so the count is per provider. Overflow waits for midnight UTC.
//   - Per recipient account: cold and sequence messages to one account in any 7 days, at most
//     delivery:account_weekly_cap (default 3). An account is the contact's account key, or the
//     address's account key; an address with no account (a personal mailbox domain) counts by its
//     full domain, which can only hold more back. Replies and lifecycle mail are not counted.
//     Overflow waits until the oldest counted send leaves the 7-day window.
//
// Both reads are gates: a database error propagates, and the caller holds the send.
import { accountKey } from "../data/keys.ts";

export const ACCOUNT_CAP_WINDOW_MS = 7 * 86_400_000;

const IN_CHUNK = 90;

/** Messages sent through `provider` since midnight UTC. Throws on a database error. */
export async function sentTodayCount(db: D1Database, provider: string, now: Date): Promise<number> {
  const start = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM outreach_sends WHERE provider = ?1 AND sent_at >= ?2").bind(provider, start).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** What a send counts against for the per-account cap. */
export interface CapAccount {
  column: "account_key" | "recipient_domain";
  value: string;
}

/** The account key the ledger stores for a send: the contact's, else the address's, else null. */
export function ledgerAccountKey(contactAccountKey: string | null | undefined, address: string): string | null {
  if (typeof contactAccountKey === "string" && contactAccountKey.length > 0) return contactAccountKey;
  return accountKey(address);
}

export function capAccount(contactAccountKey: string | null | undefined, address: string): CapAccount {
  const key = ledgerAccountKey(contactAccountKey, address);
  return key ? { column: "account_key", value: key } : { column: "recipient_domain", value: address.slice(address.lastIndexOf("@") + 1) };
}

export const capAccountId = (account: CapAccount): string => `${account.column}:${account.value}`;

/**
 * Cold and sequence sends per account since `since`, with the oldest one, keyed by capAccountId.
 * Throws on a database error.
 */
export async function accountSendsSince(db: D1Database, accounts: readonly CapAccount[], since: Date): Promise<Map<string, { count: number; oldest: string }>> {
  const counts = new Map<string, { count: number; oldest: string }>();
  for (const column of ["account_key", "recipient_domain"] as const) {
    const values = [...new Set(accounts.filter((a) => a.column === column).map((a) => a.value))];
    for (let i = 0; i < values.length; i += IN_CHUNK) {
      const chunk = values.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map((_, k) => `?${k + 2}`).join(", ");
      const { results } = await db
        .prepare(
          `SELECT ${column} AS k, COUNT(*) AS n, MIN(sent_at) AS oldest FROM outreach_sends
            WHERE sent_at >= ?1 AND send_path IN ('cold', 'sequence') AND ${column} IN (${placeholders})
            GROUP BY ${column}`,
        )
        .bind(since.toISOString(), ...chunk)
        .all<{ k: string; n: number; oldest: string }>();
      for (const row of results) counts.set(capAccountId({ column, value: row.k }), { count: Number(row.n), oldest: row.oldest });
    }
  }
  return counts;
}
