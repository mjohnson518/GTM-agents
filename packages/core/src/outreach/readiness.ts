// GTM-agents: campaign readiness: a pre-flight scorecard over the drafts a batch is about to send.
//
// Six dimensions, each pass, warn or block; the worst one decides (block is RED, warn is YELLOW,
// otherwise GREEN):
//   - send cap: today's room under the sending domain's daily cap. Block at the cap, warn when the
//     batch is larger than the room left;
//   - bounce rate: cold and sequence hard bounces over 1 and 7 days. Block at 5% or more, warn from
//     2%; under 20 sends in a window is too few to judge;
//   - suppression overlap: the canonical suppression check over the recipients. Block on any
//     overlap, and block when the check fails;
//   - verification coverage: block on any cached undeliverable address, warn when half or more have
//     no cached result or any is risky;
//   - content lint: a sample of up to five drafts. Block on any lint block, warn on any warning;
//   - account cap: cold and sequence messages per account over 7 days, counting the batch. Block over
//     the cap, warn at it.
// Every read fails closed: a dimension whose data cannot be read blocks.
//
// Salvage: when RED comes only from suppression overlap or the account cap, the offending drafts are
// dropped and the rest scored once more. Anything else that is RED holds the whole batch.
import { checkSuppression } from "../sending/suppression.ts";
import { lintOutbound } from "../quality/lint.ts";
import { sha256Hex } from "../shared/hash.ts";
import { inChunks, placeholders } from "../data/d1.ts";

export type DimensionStatus = "pass" | "warn" | "block";
export type ReadinessLevel = "green" | "yellow" | "red";
export const READINESS_DIMENSIONS = ["sendCap", "bounceRate", "suppression", "verification", "contentLint", "accountCap"] as const;
export type ReadinessDimension = (typeof READINESS_DIMENSIONS)[number];

export const BOUNCE_WARN = 0.02;
export const BOUNCE_CRITICAL = 0.05;
export const BOUNCE_MIN_SENDS = 20;
export const LINT_SAMPLE = 5;

export interface ReadinessItem {
  draftId: string;
  to: string;
  accountKey: string | null;
  subject: string;
  body: string;
}

export interface DimensionResult {
  status: DimensionStatus;
  detail: string;
}

export interface ReadinessReport {
  overall: ReadinessLevel;
  intended: number;
  dimensions: Record<ReadinessDimension, DimensionResult>;
  /** Drafts whose recipient is suppressed (empty when the check failed). */
  suppressedDrafts: string[];
  /** Set when the suppression check itself failed: overlap cannot be salvaged then. */
  suppressionUnreadable: boolean;
  /** Accounts the batch would take over the weekly cap. */
  overCapAccounts: string[];
}

export interface ReadinessOptions {
  now: Date;
  domainDailyCap: number;
  accountWeeklyCap: number;
}

const DAY_MS = 86_400_000;
const STATUS_RANK: Record<DimensionStatus, number> = { pass: 0, warn: 1, block: 2 };

function overall(dimensions: Record<ReadinessDimension, DimensionResult>): ReadinessLevel {
  const worst = Math.max(...Object.values(dimensions).map((d) => STATUS_RANK[d.status]));
  return worst === 2 ? "red" : worst === 1 ? "yellow" : "green";
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const unreadable = (what: string): DimensionResult => ({ status: "block", detail: `${what} could not be read` });

async function sendCap(db: D1Database, items: readonly ReadinessItem[], options: ReadinessOptions): Promise<DimensionResult> {
  try {
    const today = `${options.now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = await db.prepare("SELECT COUNT(*) AS n FROM outreach_sends WHERE sent_at >= ?1").bind(today).first<{ n: number }>();
    const sent = Number(row?.n ?? 0);
    const room = Math.max(0, options.domainDailyCap - sent);
    if (room === 0) return { status: "block", detail: `the sending domain is at its daily cap (${sent} of ${options.domainDailyCap})` };
    if (items.length > room) return { status: "warn", detail: `${room} of ${options.domainDailyCap} left today for ${items.length} drafts` };
    return { status: "pass", detail: `${room} of ${options.domainDailyCap} left today` };
  } catch {
    return unreadable("today's send count");
  }
}

async function bounceRate(db: D1Database, options: ReadinessOptions): Promise<DimensionResult> {
  try {
    const window = async (days: number) => {
      const since = new Date(options.now.getTime() - days * DAY_MS).toISOString();
      const row = await db
        .prepare("SELECT COUNT(*) AS sends, COUNT(bounced_at) AS bounces FROM outreach_sends WHERE send_path IN ('cold', 'sequence') AND sent_at >= ?1")
        .bind(since)
        .first<{ sends: number; bounces: number }>();
      const sends = Number(row?.sends ?? 0);
      return { sends, rate: sends > 0 ? Number(row?.bounces ?? 0) / sends : 0 };
    };
    const [day, week] = [await window(1), await window(7)];
    const level = (w: { sends: number; rate: number }): DimensionStatus => (w.sends < BOUNCE_MIN_SENDS ? "pass" : w.rate >= BOUNCE_CRITICAL ? "block" : w.rate >= BOUNCE_WARN ? "warn" : "pass");
    const status = [level(day), level(week)].sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? "pass";
    return { status, detail: `bounces ${pct(day.rate)} over 1 day (${day.sends} sends), ${pct(week.rate)} over 7 days (${week.sends} sends)` };
  } catch {
    return unreadable("the bounce rate");
  }
}

async function verification(db: D1Database, items: readonly ReadinessItem[]): Promise<DimensionResult> {
  if (items.length === 0) return { status: "pass", detail: "no drafts" };
  try {
    const hashes = await Promise.all(items.map((i) => sha256Hex(i.to.trim().toLowerCase())));
    const statuses = new Map<string, string>();
    for (const chunk of inChunks(hashes)) {
      const { results } = await db
        .prepare(`SELECT email_sha256, status FROM email_verifications WHERE email_sha256 IN (${placeholders(chunk.length)})`)
        .bind(...chunk)
        .all<{ email_sha256: string; status: string }>();
      for (const r of results) statuses.set(r.email_sha256, r.status);
    }
    const counts = { undeliverable: 0, risky: 0, missing: 0 };
    for (const h of hashes) {
      const s = statuses.get(h);
      if (!s) counts.missing++;
      else if (s === "undeliverable") counts.undeliverable++;
      else if (s === "risky") counts.risky++;
    }
    const detail = `${hashes.length - counts.missing} of ${hashes.length} cached; ${counts.undeliverable} undeliverable, ${counts.risky} risky`;
    if (counts.undeliverable > 0) return { status: "block", detail };
    if (counts.missing * 2 >= hashes.length || counts.risky > 0) return { status: "warn", detail };
    return { status: "pass", detail };
  } catch {
    return unreadable("the verification cache");
  }
}

/** Up to LINT_SAMPLE drafts spread across the batch: the first, the last and evenly between. Pure. */
export function lintSample<T>(items: readonly T[]): T[] {
  if (items.length <= LINT_SAMPLE) return [...items];
  const picks = new Set<number>();
  for (let i = 0; i < LINT_SAMPLE; i++) picks.add(Math.round((i * (items.length - 1)) / (LINT_SAMPLE - 1)));
  return [...picks].map((i) => items[i]).filter((x): x is T => x !== undefined);
}

function contentLint(items: readonly ReadinessItem[]): DimensionResult {
  const sample = lintSample(items);
  let blocks = 0;
  let warnings = 0;
  for (const item of sample) {
    const lint = lintOutbound(item);
    if (lint.blocks.length > 0) blocks++;
    else if (lint.warnings.length > 0) warnings++;
  }
  const detail = `${sample.length} sampled; ${blocks} with a block, ${warnings} with a warning`;
  return { status: blocks > 0 ? "block" : warnings > 0 ? "warn" : "pass", detail };
}

async function accountCap(db: D1Database, items: readonly ReadinessItem[], options: ReadinessOptions): Promise<{ result: DimensionResult; over: string[] }> {
  try {
    const since = new Date(options.now.getTime() - 7 * DAY_MS).toISOString();
    const planned = new Map<string, number>();
    for (const i of items) if (i.accountKey) planned.set(i.accountKey, (planned.get(i.accountKey) ?? 0) + 1);
    const sent = new Map<string, number>();
    for (const chunk of inChunks([...planned.keys()], { reserved: 1 })) {
      const { results } = await db
        .prepare(
          `SELECT account_key, COUNT(*) AS n FROM outreach_sends WHERE send_path IN ('cold', 'sequence') AND sent_at >= ?1
            AND account_key IN (${placeholders(chunk.length, 2)}) GROUP BY account_key`,
        )
        .bind(since, ...chunk)
        .all<{ account_key: string; n: number }>();
      for (const r of results) sent.set(r.account_key, Number(r.n));
    }
    const over: string[] = [];
    let atCap = 0;
    for (const [key, n] of planned) {
      const total = n + (sent.get(key) ?? 0);
      if (total > options.accountWeeklyCap) over.push(key);
      else if (total === options.accountWeeklyCap) atCap++;
    }
    const detail = `${planned.size} accounts; ${over.length} over the weekly cap of ${options.accountWeeklyCap}, ${atCap} at it`;
    return { result: { status: over.length > 0 ? "block" : atCap > 0 ? "warn" : "pass", detail }, over };
  } catch {
    return { result: unreadable("the account send counts"), over: [] };
  }
}

/** Score a batch. Never throws: anything unreadable blocks its dimension. */
export async function assessReadiness(db: D1Database, items: readonly ReadinessItem[], options: ReadinessOptions): Promise<ReadinessReport> {
  let suppressedDrafts: string[] = [];
  let suppressionUnreadable = false;
  let suppression: DimensionResult;
  try {
    const check = await checkSuppression(db, items.map((i) => i.to));
    if (check.blocked.some((b) => b.reason === "check_failed")) {
      suppressionUnreadable = true;
      suppression = unreadable("the suppression list");
    } else {
      const blocked = new Set(check.blocked.map((b) => b.recipient));
      suppressedDrafts = items.filter((i) => blocked.has(i.to)).map((i) => i.draftId);
      suppression = suppressedDrafts.length > 0 ? { status: "block", detail: `${suppressedDrafts.length} recipient(s) may not be emailed` } : { status: "pass", detail: "no overlap" };
    }
  } catch {
    suppressionUnreadable = true;
    suppression = unreadable("the suppression list");
  }
  const [cap, bounce, verify, accounts] = await Promise.all([sendCap(db, items, options), bounceRate(db, options), verification(db, items), accountCap(db, items, options)]);
  const dimensions: Record<ReadinessDimension, DimensionResult> = {
    sendCap: cap,
    bounceRate: bounce,
    suppression,
    verification: verify,
    contentLint: contentLint(items),
    accountCap: accounts.result,
  };
  return { overall: overall(dimensions), intended: items.length, dimensions, suppressedDrafts, suppressionUnreadable, overCapAccounts: accounts.over };
}

/** True when RED comes only from suppression overlap or the account cap, which salvage can remove. */
export function salvageable(report: ReadinessReport): boolean {
  if (report.overall !== "red") return false;
  const blocking = READINESS_DIMENSIONS.filter((d) => report.dimensions[d].status === "block");
  if (blocking.some((d) => d !== "suppression" && d !== "accountCap")) return false;
  if (blocking.includes("suppression") && report.suppressionUnreadable) return false;
  return true;
}

export interface ReadinessDecision<T extends ReadinessItem> {
  report: ReadinessReport;
  items: T[];
  /** Drafts salvage dropped. */
  dropped: T[];
  salvaged: boolean;
}

/** Score, and salvage once when RED comes only from suppression overlap or the account cap. */
export async function readinessWithSalvage<T extends ReadinessItem>(db: D1Database, items: readonly T[], options: ReadinessOptions): Promise<ReadinessDecision<T>> {
  const first = await assessReadiness(db, items, options);
  if (!salvageable(first)) return { report: first, items: [...items], dropped: [], salvaged: false };
  const suppressed = new Set(first.suppressedDrafts);
  const over = new Set(first.overCapAccounts);
  const keep = items.filter((i) => !suppressed.has(i.draftId) && !(i.accountKey && over.has(i.accountKey)));
  const dropped = items.filter((i) => !keep.includes(i));
  const second = await assessReadiness(db, keep, options);
  return { report: second, items: keep, dropped, salvaged: true };
}

/** One line for operator messages. */
export function readinessLine(report: ReadinessReport): string {
  const parts = READINESS_DIMENSIONS.filter((d) => report.dimensions[d].status !== "pass").map((d) => `${d} ${report.dimensions[d].status}: ${report.dimensions[d].detail}`);
  return `Readiness ${report.overall.toUpperCase()}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}
