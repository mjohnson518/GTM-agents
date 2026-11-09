// GTM-agents: the outreach metrics, each one function over the send ledger (outreach_sends) for a
// window. Reports call these and never count sends or replies themselves.
//
//   - countSends: outreach (the cold and sequence paths) by when it was sent: first touches (step 1),
//     follow-ups (later steps) and unnumbered sends (no step recorded). The three add up to delivery
//     health's sends. Replies and lifecycle mail are not outreach and are never counted.
//   - countReplies: human replies and positive replies by when they arrived (replied_at and
//     positive_reply_at, which the reply track sets from each reply's own timestamp). One ledger row
//     is one conversation: a second reply to the same first touch is not counted again.
//   - replyDepth: those replies by how deep the sequence was when they came (reply_after_step).
//   - firstTouchOutcomes and firstTouchOutcomesBy: the first touches sent in the window and what
//     came of them by now: hard bounces, human replies, positive replies. This is the basis of every
//     rate (reply rate, positive rate) and of the conversion report's slices. Sends that bounced stay
//     in the denominator; bounces are counted beside them.
//   - maturedSamples: what an experiment may judge a template on. First touches only, not bounced,
//     sent at least MATURITY_DAYS ago (follow-ups land on days 3 and 10, so a younger send has not
//     had its whole sequence yet), and only sends of the template's current copy: the ledger's
//     template_sha256 must equal templates.body_sha256 (refreshed by every cold batch run), so
//     editing a template starts its sample afresh. maturedTotals adds the same rows up over every
//     template.
//   - replyRate: the one definition of a rate, replies over the sends they came from.
//
// Every function throws on a database error. A report shows that section as unreadable instead of
// a zero that looks like a measurement.
import { firstTouchSql, followUpSql, humanReplySql, n, outreachSql, positiveReplySql } from "./sql.ts";
import { DAY_MS, type MetricWindow } from "./window.ts";

/** A first touch is old enough to judge after this many days. */
export const MATURITY_DAYS = 10;

export interface SendCounts {
  /** Step 1 of an outreach sequence. */
  firstTouches: number;
  /** Later steps. */
  followUps: number;
  /**
   * Cold or sequence sends recorded with no step (for example a message the send function sent on
   * the cold path without a sequence step). They are outreach, so delivery health counts them, but
   * they are neither a first touch nor a follow-up, and no reply is credited to them. The three
   * fields always add up to deliveryHealth's sends for the same window.
   */
  unnumbered: number;
}

/** First touches and follow-ups sent in the window. */
export async function countSends(db: D1Database, window: MetricWindow): Promise<SendCounts> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN ${firstTouchSql("os")} THEN 1 ELSE 0 END) AS first_touches,
              SUM(CASE WHEN ${followUpSql("os")} THEN 1 ELSE 0 END) AS follow_ups,
              SUM(CASE WHEN os.sequence_step IS NULL OR os.sequence_step < 1 THEN 1 ELSE 0 END) AS unnumbered
         FROM outreach_sends os
        WHERE ${outreachSql("os")} AND os.sent_at >= ?1 AND os.sent_at < ?2`,
    )
    .bind(window.from, window.to)
    .first<{ first_touches: number | null; follow_ups: number | null; unnumbered: number | null }>();
  return { firstTouches: n(row?.first_touches), followUps: n(row?.follow_ups), unnumbered: n(row?.unnumbered) };
}

export interface ReplyCounts {
  /** Conversations whose first human reply arrived in the window. */
  humanReplies: number;
  /** Conversations whose first positive reply arrived in the window. */
  positiveReplies: number;
}

/** Human and positive replies that arrived in the window. */
export async function countReplies(db: D1Database, window: MetricWindow): Promise<ReplyCounts> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN ${humanReplySql("os")} AND os.replied_at >= ?1 AND os.replied_at < ?2 THEN 1 ELSE 0 END) AS human,
              SUM(CASE WHEN ${positiveReplySql("os")} AND os.positive_reply_at >= ?1 AND os.positive_reply_at < ?2 THEN 1 ELSE 0 END) AS positive
         FROM outreach_sends os
        WHERE ${firstTouchSql("os")}
          AND ((os.replied_at >= ?1 AND os.replied_at < ?2) OR (os.positive_reply_at >= ?1 AND os.positive_reply_at < ?2))`,
    )
    .bind(window.from, window.to)
    .first<{ human: number | null; positive: number | null }>();
  return { humanReplies: n(row?.human), positiveReplies: n(row?.positive) };
}

export interface ReplyDepth {
  /** The step the sequence had reached when the reply came. */
  step: number;
  humanReplies: number;
}

/** Human replies that arrived in the window, by reply_after_step, lowest step first. */
export async function replyDepth(db: D1Database, window: MetricWindow): Promise<ReplyDepth[]> {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(os.reply_after_step, 1) AS step, COUNT(*) AS replies
         FROM outreach_sends os
        WHERE ${firstTouchSql("os")} AND ${humanReplySql("os")} AND os.replied_at >= ?1 AND os.replied_at < ?2
        GROUP BY COALESCE(os.reply_after_step, 1)
        ORDER BY step ASC`,
    )
    .bind(window.from, window.to)
    .all<{ step: number; replies: number }>();
  return results.map((r) => ({ step: n(r.step), humanReplies: n(r.replies) }));
}

export interface OutcomeCounts {
  /** First touches sent in the window. */
  sends: number;
  /** Of those, how many hard bounced. */
  bounced: number;
  /** Of those, how many earned a human reply (by now). */
  humanReplies: number;
  /** Of those, how many earned a positive reply (by now). */
  positiveReplies: number;
}

export interface OutcomeSlice extends OutcomeCounts {
  /** The slice's value: a template id, a subject line as written, a cohort, a segment or a persona. */
  key: string;
}

/** The dimensions first-touch outcomes can be sliced by. */
export const OUTCOME_DIMENSIONS = ["template", "subject", "cohort", "segment", "persona"] as const;
export type OutcomeDimension = (typeof OUTCOME_DIMENSIONS)[number];

export function isOutcomeDimension(value: unknown): value is OutcomeDimension {
  return typeof value === "string" && (OUTCOME_DIMENSIONS as readonly string[]).includes(value);
}

/** What a slice is keyed by when its value is unknown. */
export const UNKNOWN_SLICE = "(unknown)";

// The subject slice is the subject line as the operator wrote it (the template's subject, or a
// subject test's variant id), never the rendered subject, which carries names from outside.
const SLICE_KEY: Record<OutcomeDimension, string> = {
  template: "os.template_id",
  subject: "COALESCE(os.subject_variant_id, t.subject)",
  cohort: "os.cohort",
  segment: "COALESCE(af.segment, a.segment)",
  persona: "ac.persona",
};

const SLICE_JOINS = `LEFT JOIN templates t ON t.id = os.template_id
  LEFT JOIN accounts a ON a.account_key = os.account_key
  LEFT JOIN account_fit af ON af.account_key = os.account_key
  LEFT JOIN account_contacts ac ON ac.contact_id = os.contact_id AND ac.account_key = os.account_key`;

const OUTCOME_COLUMNS = `COUNT(*) AS sends,
  SUM(CASE WHEN os.bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
  SUM(CASE WHEN ${humanReplySql("os")} THEN 1 ELSE 0 END) AS human,
  SUM(CASE WHEN ${positiveReplySql("os")} THEN 1 ELSE 0 END) AS positive`;

interface OutcomeRow {
  sends: number | null;
  bounced: number | null;
  human: number | null;
  positive: number | null;
}

const toCounts = (r: OutcomeRow | null | undefined): OutcomeCounts => ({ sends: n(r?.sends), bounced: n(r?.bounced), humanReplies: n(r?.human), positiveReplies: n(r?.positive) });

/** The first touches sent in the window, and what came of them. */
export async function firstTouchOutcomes(db: D1Database, window: MetricWindow): Promise<OutcomeCounts> {
  const row = await db
    .prepare(`SELECT ${OUTCOME_COLUMNS} FROM outreach_sends os WHERE ${firstTouchSql("os")} AND os.sent_at >= ?1 AND os.sent_at < ?2`)
    .bind(window.from, window.to)
    .first<OutcomeRow>();
  return toCounts(row);
}

/**
 * The same first touches, one slice per value of `dimension`, ordered by key. Every first touch is
 * in exactly one slice, so the slices add up to firstTouchOutcomes for the same window.
 */
export async function firstTouchOutcomesBy(db: D1Database, window: MetricWindow, dimension: OutcomeDimension): Promise<OutcomeSlice[]> {
  if (!isOutcomeDimension(dimension)) throw new Error(`unknown outcome dimension: ${String(dimension)}`);
  const key = `COALESCE(${SLICE_KEY[dimension]}, '${UNKNOWN_SLICE}')`;
  const { results } = await db
    .prepare(
      `SELECT ${key} AS slice, ${OUTCOME_COLUMNS}
         FROM outreach_sends os ${SLICE_JOINS}
        WHERE ${firstTouchSql("os")} AND os.sent_at >= ?1 AND os.sent_at < ?2
        GROUP BY ${key}
        ORDER BY slice ASC`,
    )
    .bind(window.from, window.to)
    .all<OutcomeRow & { slice: string }>();
  return results.map((r) => ({ key: String(r.slice), ...toCounts(r) }));
}

export interface MaturedSample {
  templateId: string;
  /** Matured first touches of the template's current copy. */
  sends: number;
  humanReplies: number;
  positiveReplies: number;
}

/** The latest send time that is matured at `now`. */
export function maturedBefore(now: Date): string {
  return new Date(now.getTime() - MATURITY_DAYS * DAY_MS).toISOString();
}

const MATURED_FROM = `FROM outreach_sends os
         JOIN templates t ON t.id = os.template_id AND os.template_sha256 = t.body_sha256
        WHERE ${firstTouchSql("os")} AND os.bounced_at IS NULL AND os.sent_at >= ?1 AND os.sent_at < ?2`;

const MATURED_COLUMNS = `COUNT(*) AS sends,
              SUM(CASE WHEN ${humanReplySql("os")} THEN 1 ELSE 0 END) AS human,
              SUM(CASE WHEN ${positiveReplySql("os")} THEN 1 ELSE 0 END) AS positive`;

/** The window's end, cut back to what is matured at `now`. */
const maturedEnd = (window: MetricWindow, now: Date): string => {
  const cutoff = maturedBefore(now);
  return cutoff < window.to ? cutoff : window.to;
};

/**
 * Matured samples per template, from first touches sent in the window: not bounced, at least
 * MATURITY_DAYS old at `now`, and sent from the template's current copy. Ordered by template id.
 */
export async function maturedSamples(db: D1Database, window: MetricWindow, now: Date): Promise<MaturedSample[]> {
  const { results } = await db
    .prepare(`SELECT os.template_id AS template_id, ${MATURED_COLUMNS} ${MATURED_FROM} GROUP BY os.template_id ORDER BY os.template_id ASC`)
    .bind(window.from, maturedEnd(window, now))
    .all<{ template_id: string; sends: number; human: number | null; positive: number | null }>();
  return results.map((r) => ({ templateId: r.template_id, sends: n(r.sends), humanReplies: n(r.human), positiveReplies: n(r.positive) }));
}

export interface MaturedTotals {
  /** Matured first touches, every template together. */
  sends: number;
  humanReplies: number;
  positiveReplies: number;
}

/** maturedSamples added up over every template: the same rows, so the two always agree. */
export async function maturedTotals(db: D1Database, window: MetricWindow, now: Date): Promise<MaturedTotals> {
  const row = await db
    .prepare(`SELECT ${MATURED_COLUMNS} ${MATURED_FROM}`)
    .bind(window.from, maturedEnd(window, now))
    .first<{ sends: number | null; human: number | null; positive: number | null }>();
  return { sends: n(row?.sends), humanReplies: n(row?.human), positiveReplies: n(row?.positive) };
}

/**
 * The one definition of a rate over sends: human or positive replies over the sends they came
 * from, or null when there were no sends. Every report that prints or compares a rate uses it.
 */
export function replyRate(replies: number, sends: number): number | null {
  return sends > 0 ? replies / sends : null;
}
