// GTM-agents: the deal handoff brief: when a deal reaches proposal or negotiation, the operator gets
// a static brief of the deal, its stage history, the meetings and the contact (brief.ts).
//
// Hourly (convert:handoff_enabled). Each deal and stage is handled once: the brief is claimed in the
// effects ledger first, stored as a deal_handoffs row (trigger `stage:<stage>`), then sent; a failed
// notice releases the claim and the next run sends it. No model call, and nothing about pricing,
// offers or discounts is decided or sent: those stay with the operator.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { loadContactBrief, renderHandoffBrief, type HandoffDeal } from "./brief.ts";

export const HANDOFF_STAGES = ["proposal", "negotiation"] as const;
const EFFECT = "deal_handoff_brief";

export interface HandoffDeps {
  db: D1Database;
  operator?: OperatorChannel | undefined;
  chatId?: string | undefined;
  now: Date;
  log: JobLogger;
  maxRows: number;
}

export interface HandoffResult {
  due: number;
  written: number;
  failed: number;
}

/** Write and send the briefs that are due. Throws only when the deals cannot be read. */
export async function runDealHandoffs(deps: HandoffDeps): Promise<HandoffResult> {
  const { db, now, log } = deps;
  const result: HandoffResult = { due: 0, written: 0, failed: 0 };
  const { results: deals } = await db
    .prepare(
      `SELECT d.id, d.name, d.stage, d.value_cents, d.currency, d.created_at, d.contact_id FROM deals d
        WHERE d.stage IN ('proposal', 'negotiation')
          AND NOT EXISTS (SELECT 1 FROM deal_handoffs h WHERE h.deal_id = d.id AND h.trigger = 'stage:' || d.stage)
        ORDER BY d.updated_at ASC LIMIT ?1`,
    )
    .bind(deps.maxRows)
    .all<HandoffDeal>();
  result.due = deals.length;
  for (const deal of deals) {
    const key = `deal:${deal.id}:${deal.stage}`;
    try {
      if (!(await claimEffect(db, key, EFFECT))) continue;
      try {
        const { results: history } = await db
          .prepare("SELECT from_stage, to_stage, created_at FROM deal_stage_history WHERE deal_id = ?1 ORDER BY created_at ASC LIMIT 12")
          .bind(deal.id)
          .all<{ from_stage: string; to_stage: string; created_at: string }>();
        const contact = deal.contact_id ? await loadContactBrief(db, deal.contact_id) : null;
        const brief = renderHandoffBrief(deal, history, contact);
        const id = `ho_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
        await db
          .prepare("INSERT INTO deal_handoffs (id, deal_id, trigger, brief_markdown, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)")
          .bind(id, deal.id, `stage:${deal.stage}`, brief, now.toISOString())
          .run();
        if (deps.operator) {
          try {
            await deps.operator.notify({ text: brief, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
            await db.prepare("UPDATE deal_handoffs SET notified_at = ?2 WHERE id = ?1").bind(id, now.toISOString()).run();
          } catch (error) {
            // The brief is stored; the notice is retried: release the claim and drop the row, so the
            // next run writes and sends it again.
            await db.prepare("DELETE FROM deal_handoffs WHERE id = ?1").bind(id).run();
            throw error;
          }
        }
        result.written += 1;
      } catch (error) {
        await releaseEffect(db, key, EFFECT);
        throw error;
      }
    } catch (error) {
      result.failed += 1;
      log.warn("a deal handoff brief failed; the next run tries again", { dealId: deal.id, error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}
