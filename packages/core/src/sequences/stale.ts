// GTM-agents: the weekend check for stale sequences.
//
// A sequence is stale when it is active and either paused (waiting for an operator's
// `sequence-resume-<contact id>`) or due for more than 3 days without its step going out (a template
// problem, a reviewer outage, a Message-ID that cannot be found, a step waiting for a release). The
// check tells the operator once per row and state: each row is claimed in the effects ledger under
// its pause time or due time, so the same stale row is not reported again until its state changes.
// It changes nothing about the sequences themselves and calls no model.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { SEQUENCE_LIMITS } from "./flags.ts";

export const STALE_EFFECT = "sequence_stale";
const DAY_MS = 86_400_000;

export interface StaleDeps {
  db: D1Database;
  operator?: OperatorChannel | undefined;
  now: Date;
  log?: JobLogger;
  /** Rows read per run, at most. */
  maxRows: number;
}

export interface StaleResult {
  stale: number;
  paused: number;
  /** Rows reported for the first time in this run. */
  reported: number;
}

interface StaleRow {
  campaign_id: string;
  contact_id: string;
  email: string;
  sequence_step: number | null;
  next_send_at: string | null;
  sequence_paused_at: string | null;
  sequence_pause_reason: string | null;
}

/** Find stale sequences and report the new ones once. Throws on a database error reading them. */
export async function runStaleCheck(deps: StaleDeps): Promise<StaleResult> {
  const before = new Date(deps.now.getTime() - SEQUENCE_LIMITS.staleAfterDays * DAY_MS).toISOString();
  const { results } = await deps.db
    .prepare(
      `SELECT cc.campaign_id, cc.contact_id, c.email, cc.sequence_step, cc.next_send_at, cc.sequence_paused_at, cc.sequence_pause_reason
         FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
        WHERE cc.sequence_active = 1 AND (cc.sequence_paused_at IS NOT NULL OR (cc.next_send_at IS NOT NULL AND cc.next_send_at <= ?1))
        ORDER BY COALESCE(cc.sequence_paused_at, cc.next_send_at) ASC
        LIMIT ?2`,
    )
    .bind(before, Math.max(1, Math.floor(deps.maxRows)))
    .all<StaleRow>();
  const result: StaleResult = { stale: results.length, paused: results.filter((r) => r.sequence_paused_at !== null).length, reported: 0 };
  if (results.length === 0 || !deps.operator) return result;

  const fresh: Array<{ row: StaleRow; key: string }> = [];
  for (const row of results) {
    const key = `seq_stale:${row.campaign_id}:${row.contact_id}:${row.sequence_paused_at ?? row.next_send_at ?? ""}`;
    try {
      if (await claimEffect(deps.db, key, STALE_EFFECT)) fresh.push({ row, key });
    } catch {
      // Unclaimable now: it is reported on a later run instead.
    }
  }
  if (fresh.length === 0) return result;

  const describe = (r: StaleRow) => {
    const next = r.sequence_step === null ? "the next step" : `step ${r.sequence_step + 1}`;
    return r.sequence_paused_at
      ? `- ${r.email}: ${next} paused since ${r.sequence_paused_at.slice(0, 10)} (${r.sequence_pause_reason ?? "no reason recorded"}). Resume: sequence-resume-${r.contact_id}`
      : `- ${r.email}: ${next} due since ${(r.next_send_at ?? "").slice(0, 10)} and not sent${r.sequence_pause_reason ? ` (${r.sequence_pause_reason})` : ""}`;
  };
  const shown = fresh.slice(0, SEQUENCE_LIMITS.listed).map((f) => describe(f.row));
  const text = [
    `${fresh.length} follow-up sequence(s) look stuck:`,
    ...shown,
    ...(fresh.length > shown.length ? [`- and ${fresh.length - shown.length} more`] : []),
    "Due steps usually wait on a template, the model reviewer, a Message-ID or your release; the follow-up sweep's daily notices say which.",
  ].join("\n");
  try {
    await deps.operator.notify({ text });
    result.reported = fresh.length;
  } catch (error) {
    deps.log?.warn("the stale-sequence report could not be sent; it is tried again on the next run", { error: sanitizeErrorMessage(error) });
    for (const f of fresh) await releaseEffect(deps.db, f.key, STALE_EFFECT);
  }
  return result;
}
