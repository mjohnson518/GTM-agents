// GTM-agents: the cold batch's picker: which selected contacts actually get a first touch.
//
// Selection (select.ts) returns contacts in rank order, already filtered one by one. The picker
// applies the rules that need the whole account, in order, and is pure:
//   1. the account key exists: the contact's account key is a registrable company domain and their
//      address is at it;
//   2. the brain's never list (accounts, domains, titles);
//   3. the live-thread block: nobody at an account already in a conversation (anyone warming or
//      better, a deal past contacted, a reply in the last 90 days, a decline in the last 90 days);
//   4. the opt-out block: nobody at an account where anyone opted out or complained;
//   5. the weekly account cap: cold and sequence messages per account in any 7 days, counting this
//      batch. Selection stops one short of the cap, so the readiness check never sees an account at it;
//   6. one contact per account per batch, counting today's sends and open drafts.
// Each skip is counted by reason, so a short batch shows which rule cost the seats.
import { accountKey } from "../data/keys.ts";
import { matchNeverList, type NeverList } from "../sourcing/identity.ts";

export const PICK_SKIP_REASONS = ["no_account_key", "never_list", "live_thread", "account_opt_out", "account_weekly_cap", "account_batch"] as const;
export type PickSkipReason = (typeof PICK_SKIP_REASONS)[number];

export interface PickableContact {
  email: string;
  account_key: string | null;
  account_name?: string | null;
  job_title?: string | null;
}

/** One message already counted against an account: a recent send, a queued deferral or an open draft. */
export interface AccountUse {
  account_key: string;
  /** True when it went out today or is still waiting to go: it uses the account's slot for this batch. */
  today: boolean;
}

export interface PickOptions {
  limit: number;
  /** The weekly account cap the send path enforces. Selection fills to one below it. */
  weeklyCap: number;
  /** Contacts per account per batch. */
  perBatch: number;
  live: ReadonlySet<string>;
  optedOut: ReadonlySet<string>;
  recent: readonly AccountUse[];
  never?: NeverList;
}

export interface PickResult<T> {
  picked: T[];
  skipped: Record<PickSkipReason, number>;
}

/** The weekly limit selection fills to: one short of the cap, never below one. */
export function selectionWeeklyCap(cap: number): number {
  return Math.max(1, cap - 1);
}

/** Pick contacts from rows in rank order. Pure. */
export function pickContacts<T extends PickableContact>(rows: readonly T[], options: PickOptions): PickResult<T> {
  const skipped = Object.fromEntries(PICK_SKIP_REASONS.map((r) => [r, 0])) as Record<PickSkipReason, number>;
  const weekly = new Map<string, number>();
  const batch = new Map<string, number>();
  for (const use of options.recent) {
    weekly.set(use.account_key, (weekly.get(use.account_key) ?? 0) + 1);
    if (use.today) batch.set(use.account_key, (batch.get(use.account_key) ?? 0) + 1);
  }
  const weeklyLimit = selectionWeeklyCap(options.weeklyCap);
  const picked: T[] = [];
  for (const row of rows) {
    if (picked.length >= options.limit) break;
    const key = row.account_key ? accountKey(row.account_key) : null;
    if (!key || key !== row.account_key || accountKey(row.email) !== key) {
      skipped.no_account_key++;
      continue;
    }
    if (options.never && matchNeverList(options.never, { domain: key, accountName: row.account_name ?? null, title: row.job_title ?? null })) {
      skipped.never_list++;
      continue;
    }
    if (options.live.has(key)) {
      skipped.live_thread++;
      continue;
    }
    if (options.optedOut.has(key)) {
      skipped.account_opt_out++;
      continue;
    }
    const usedThisWeek = weekly.get(key) ?? 0;
    if (usedThisWeek >= weeklyLimit) {
      skipped.account_weekly_cap++;
      continue;
    }
    const usedToday = batch.get(key) ?? 0;
    if (usedToday >= options.perBatch) {
      skipped.account_batch++;
      continue;
    }
    weekly.set(key, usedThisWeek + 1);
    batch.set(key, usedToday + 1);
    picked.push(row);
  }
  return { picked, skipped };
}
