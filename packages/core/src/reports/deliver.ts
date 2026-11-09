// GTM-agents: putting a scheduled report in front of the operator once per period.
//
// The report's key (for example "report:scorecard:2026-11-06") is claimed in the effects ledger
// before the message goes, and released when the channel fails, so a rerun or the next run tries
// again instead of losing the report, and two runs never send it twice. A claim that cannot be
// written still sends: a duplicate report beats a missing one.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";

export const REPORT_EFFECT = "report_sent";

export type DeliveryStatus = "sent" | "already_sent" | "no_channel" | "failed";

export interface DeliverDeps {
  db: D1Database;
  operator: OperatorChannel | undefined;
  /** The chat to send to; the channel's default chat when omitted. */
  chatId?: string;
  log: JobLogger;
}

/** Send `text` once for `key`. Never throws. */
export async function deliverOnce(deps: DeliverDeps, key: string, text: string): Promise<DeliveryStatus> {
  if (!deps.operator) return "no_channel";
  let claimed = true;
  let claimWritten = true;
  try {
    claimed = await claimEffect(deps.db, key, REPORT_EFFECT);
  } catch (error) {
    claimWritten = false;
    deps.log.warn("a report's claim could not be written; it is sent anyway", { key, error: sanitizeErrorMessage(error) });
  }
  if (!claimed) return "already_sent";
  try {
    await deps.operator.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    return "sent";
  } catch (error) {
    deps.log.warn("a report could not be sent; it is tried again on the next run", { key, error: sanitizeErrorMessage(error) });
    if (claimWritten) await releaseEffect(deps.db, key, REPORT_EFFECT).catch(() => false);
    return "failed";
  }
}
