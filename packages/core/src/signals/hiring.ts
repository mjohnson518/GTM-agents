// GTM-agents: hiring boards: open roles on high-fit accounts' public job boards, kept as counts.
//
// Each run checks up to 20 high-fit accounts (a model fit score of 7 or more, or, unscored, a
// prescore of 70 or more) not checked in the last 7 days, through a HiringBoardSource (the
// data-jobboards adapter, which reads only the vendors' documented public board endpoints):
//   - boards already found for the account (account_job_boards) are read again; an account with
//     none has one board token guessed from its domain (the registrable domain's first label) and
//     tried on each vendor. A board that answers is recorded (found_by guessed), one that stops
//     answering is marked gone;
//   - postings come back as counts per role kind (an enum). A posting title is never returned by
//     the adapter and never stored: account_hiring_roles keeps one row per board and role kind;
//   - hiring becomes a signal once per 90 days per account, when at least 3 postings are in the
//     role kinds the deployment cares about (roleKinds; every kind but "other" by default) and the
//     board reports a posting date. No date, no signal. Severity 0.60, expiry 30 days, the board's
//     public page as the source URL, and the counts as evidence.
// The calls are free public reads, bounded by the per-run account ceiling.
import type { JobLogger } from "../jobs/registry.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import { JOB_BOARDS, ROLE_KINDS, type BoardOpenings, type HiringBoardSource, type JobBoard, type RoleKind } from "./ports.ts";
import { expiryAfter, recordSignal, validEventDate } from "./record.ts";

const DAY_MS = 86_400_000;
export const BOARD_TOKEN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const DEFAULT_ROLE_KINDS: readonly RoleKind[] = Object.freeze(ROLE_KINDS.filter((k) => k !== "other"));

/** The board token guessed from an account key: its first label, when it is a valid token. Pure. */
export function guessBoardToken(account: string): string | null {
  const label = account.split(".")[0]?.toLowerCase() ?? "";
  return BOARD_TOKEN.test(label) ? label : null;
}

/** Postings in the given role kinds. Pure. */
export function relevantRoles(counts: Partial<Record<RoleKind, number>>, kinds: readonly RoleKind[]): number {
  return kinds.reduce((sum, k) => sum + (Number.isInteger(counts[k]) ? (counts[k] ?? 0) : 0), 0);
}

export interface HiringStats {
  accounts: number;
  boards: number;
  signals: number;
  errors: number;
}

export interface HiringRunInput {
  db: D1Database;
  source: HiringBoardSource;
  now: Date;
  roleKinds?: readonly RoleKind[];
  log: JobLogger;
  signal?: AbortSignal;
}

/** High-fit accounts due a board check. */
export async function hiringAccounts(db: D1Database, now: Date, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT af.account_key FROM account_fit af LEFT JOIN account_board_checks b ON b.account_key = af.account_key
        WHERE ((af.status = 'scored' AND af.fit_score >= ?1) OR (af.fit_score IS NULL AND af.prescore >= ?2))
          AND (b.checked_at IS NULL OR b.checked_at < ?3)
        ORDER BY (b.checked_at IS NOT NULL), b.checked_at, COALESCE(af.fit_score, 0) DESC, af.prescore DESC, af.account_key LIMIT ?4`,
    )
    .bind(SIGNAL_LIMITS.hiringMinFit, SIGNAL_LIMITS.hiringMinPrescore, new Date(now.getTime() - SIGNAL_LIMITS.hiringRecheckDays * DAY_MS).toISOString(), limit)
    .all<{ account_key: string }>();
  return results.map((r) => r.account_key);
}

export async function runHiringBoards(input: HiringRunInput): Promise<HiringStats> {
  const stats: HiringStats = { accounts: 0, boards: 0, signals: 0, errors: 0 };
  const { db, now } = input;
  const stamp = now.toISOString();
  const kinds = (input.roleKinds ?? DEFAULT_ROLE_KINDS).filter((k) => (ROLE_KINDS as readonly string[]).includes(k));
  for (const account of await hiringAccounts(db, now, SIGNAL_LIMITS.hiringAccountsPerRun)) {
    if (input.signal?.aborted) break;
    stats.accounts += 1;
    const { results: known } = await db.prepare("SELECT board, token FROM account_job_boards WHERE account_key = ?1 AND status = 'active'").bind(account).all<{ board: string; token: string }>();
    const guessed = guessBoardToken(account);
    const targets: Array<{ board: JobBoard; token: string; guessed: boolean }> =
      known.length > 0
        ? known.filter((k) => (JOB_BOARDS as readonly string[]).includes(k.board) && BOARD_TOKEN.test(k.token)).map((k) => ({ board: k.board as JobBoard, token: k.token, guessed: false }))
        : guessed
          ? JOB_BOARDS.map((board) => ({ board, token: guessed, guessed: true }))
          : [];
    const totals: Partial<Record<RoleKind, number>> = {};
    let latest: string | null = null;
    let boardUrl: string | null = null;
    let found = 0;
    for (const target of targets) {
      let openings: BoardOpenings;
      try {
        openings = await input.source.openings(target.board, target.token);
      } catch (error) {
        stats.errors += 1;
        input.log.warn("job board read failed", { board: target.board, error: sanitizeErrorMessage(error) });
        continue;
      }
      if (openings.status === "not_found") {
        if (!target.guessed) await db.prepare("UPDATE account_job_boards SET status = 'gone' WHERE account_key = ?1 AND board = ?2 AND token = ?3").bind(account, target.board, target.token).run();
        continue;
      }
      found += 1;
      if (target.guessed) {
        await db
          .prepare("INSERT OR IGNORE INTO account_job_boards (account_key, board, token, found_by, status, first_seen_at, created_at) VALUES (?1, ?2, ?3, 'guessed', 'active', ?4, ?4)")
          .bind(account, target.board, target.token, stamp)
          .run();
      }
      const writes: D1PreparedStatement[] = [];
      for (const kind of ROLE_KINDS) {
        const count = openings.counts[kind];
        if (!Number.isInteger(count) || (count ?? 0) <= 0) continue;
        totals[kind] = (totals[kind] ?? 0) + (count ?? 0);
        writes.push(
          db
            .prepare(
              `INSERT INTO account_hiring_roles (account_key, board, role, open_count, first_seen_at, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
               ON CONFLICT(account_key, board, role) DO UPDATE SET open_count = excluded.open_count, last_seen_at = excluded.last_seen_at`,
            )
            .bind(account, target.board, kind, count, stamp),
        );
      }
      // Kinds no longer open on this board drop to zero.
      writes.push(db.prepare("UPDATE account_hiring_roles SET open_count = 0 WHERE account_key = ?1 AND board = ?2 AND last_seen_at < ?3").bind(account, target.board, stamp));
      await db.batch(writes);
      const date = validEventDate(openings.latestPostedAt, now);
      if (date && (!latest || date > latest)) {
        latest = date;
        boardUrl = openings.boardUrl ?? boardUrl;
      }
      boardUrl = boardUrl ?? openings.boardUrl ?? null;
    }
    stats.boards += found;
    await db
      .prepare("INSERT INTO account_board_checks (account_key, boards, checked_at, created_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(account_key) DO UPDATE SET boards = excluded.boards, checked_at = excluded.checked_at")
      .bind(account, found, stamp)
      .run();

    const relevant = relevantRoles(totals, kinds);
    if (relevant < SIGNAL_LIMITS.hiringMinRoles || !latest || !boardUrl) continue;
    const last = await db.prepare("SELECT MAX(signalled_at) AS at FROM account_hiring_roles WHERE account_key = ?1").bind(account).first<{ at: string | null }>();
    if (last?.at && now.getTime() - Date.parse(last.at) < SIGNAL_LIMITS.hiringSignalEveryDays * DAY_MS) continue;
    const counts: Record<string, number> = {};
    for (const k of kinds) if (totals[k]) counts[k] = totals[k] ?? 0;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const outcome = await recordSignal(
      db,
      {
        type: "hiring",
        source: "hiring_board",
        accountKey: account,
        headline: `${relevant} open roles${top ? `, most in ${top[0].replace(/_/g, " ")}` : ""}`,
        url: boardUrl,
        eventDate: latest,
        severity: SIGNAL_LIMITS.sourcedSeverity,
        expiresAt: expiryAfter(now, SIGNAL_LIMITS.hiringExpiryDays),
        evidence: { role_counts: counts, relevant, provider: input.source.name },
        eventKey: `hiring:${account}:${stamp.slice(0, 10)}`,
      },
      now,
    );
    if (outcome.status !== "recorded") continue;
    await db.prepare("UPDATE account_hiring_roles SET signalled_at = ?2 WHERE account_key = ?1").bind(account, stamp).run();
    stats.signals += 1;
  }
  return stats;
}
