// GTM-agents: the SQL conditions the metric functions share, generated from the one definition of a
// reply and a positive reply (positive-reply.ts), so a query can never drift from it.
//
// Only the metrics module uses these. Every value interpolated here is a constant from this
// repository, checked against a strict pattern, never anything read from a request or a row.
import { NON_REPLY_CLASSIFICATIONS, POSITIVE_INTENTS, REPLY_INTENTS, countsAsReply, isPositiveReply } from "./positive-reply.ts";

const SAFE = /^[a-z_]+$/;

/** A quoted SQL list of constant identifiers. Throws on anything that is not one. */
export function sqlList(values: readonly string[]): string {
  if (values.length === 0) throw new Error("an SQL list needs at least one value");
  for (const v of values) if (!SAFE.test(v)) throw new Error(`"${v}" is not a constant this module may interpolate`);
  return values.map((v) => `'${v}'`).join(", ");
}

function alias(a: string): string {
  if (!/^[a-z]{1,8}$/.test(a)) throw new Error(`"${a}" is not a table alias`);
  return a;
}

/** The send paths that are outreach: the cold first touch and the sequence's steps. Replies and lifecycle mail are not. */
export const OUTREACH_PATHS: readonly string[] = Object.freeze(["cold", "sequence"]);

/** The triage intents a credited reply may carry and still be a reply: every intent countsAsReply accepts. */
export const LEDGER_REPLY_INTENTS: readonly string[] = Object.freeze(REPLY_INTENTS.filter((intent) => countsAsReply({ intent })));

/** The triage intents that make a reply positive by themselves (the meeting half is not measured yet). */
export const LEDGER_POSITIVE_INTENTS: readonly string[] = Object.freeze(REPLY_INTENTS.filter((intent) => isPositiveReply({ intent })));

/** An outreach send on the ledger (alias `a`). */
export const outreachSql = (a: string): string => `${alias(a)}.send_path IN (${sqlList(OUTREACH_PATHS)})`;

/** A first touch: step 1 of an outreach sequence. Replies are credited only to these. */
export const firstTouchSql = (a: string): string => `${outreachSql(a)} AND ${alias(a)}.sequence_step = 1`;

/** A follow-up: a later step of an outreach sequence. */
export const followUpSql = (a: string): string => `${outreachSql(a)} AND ${alias(a)}.sequence_step > 1`;

/**
 * A ledger row credited with a human reply. The reply track credits only messages countsAsReply
 * accepts and always records the intent, so this is replied_at set with an intent that is a reply.
 */
export const humanReplySql = (a: string): string => `(${alias(a)}.replied_at IS NOT NULL AND ${alias(a)}.reply_intent IN (${sqlList(LEDGER_REPLY_INTENTS)}))`;

/** A ledger row credited with a positive reply: positive_reply_at, which only isPositiveReply sets. */
export const positiveReplySql = (a: string): string => `${alias(a)}.positive_reply_at IS NOT NULL`;

/**
 * An inbound message that is a positive reply by its triage intent: a positive intent, on a message
 * whose structural classification does not rule it out as a reply. The same rule as isPositiveReply
 * for a message with no meeting.
 */
export const inboundPositiveSql = (a: string): string =>
  `(${alias(a)}.intent IN (${sqlList(POSITIVE_INTENTS)}) AND (${alias(a)}.classification IS NULL OR ${alias(a)}.classification NOT IN (${sqlList(NON_REPLY_CLASSIFICATIONS)})))`;

/** A number from an aggregate row: SUM over no rows is NULL, which counts as zero. */
export const n = (value: unknown): number => {
  const v = Number(value ?? 0);
  return Number.isFinite(v) ? v : 0;
};
