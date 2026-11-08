// GTM-agents: deal stage transitions.
//
// The allowed moves are defined here and nowhere else: an open deal may move to any later stage
// (so a fast deal can close from "engaged"), or to closed_lost from any open stage. Closed stages
// are terminal, and a deal never moves backwards. Every move is a compare-and-set on the current
// stage, written in one batch with its deal_stage_history row.
import { CLOSED_DEAL_STAGES, DEAL_STAGES, type DealStage } from "./enums.ts";

const isStage = (value: unknown): value is DealStage => typeof value === "string" && (DEAL_STAGES as readonly string[]).includes(value);

export function canTransitionDeal(from: DealStage, to: DealStage): boolean {
  if (!isStage(from) || !isStage(to) || from === to) return false;
  if (CLOSED_DEAL_STAGES.includes(from)) return false;
  if (to === "closed_lost") return true;
  return DEAL_STAGES.indexOf(to) > DEAL_STAGES.indexOf(from);
}

/** Every allowed (from, to) pair, for documentation and tests. */
export const DEAL_TRANSITIONS: ReadonlyArray<readonly [DealStage, DealStage]> = DEAL_STAGES.flatMap((from) =>
  DEAL_STAGES.filter((to) => canTransitionDeal(from, to)).map((to) => [from, to] as const),
);

export type DealTransitionResult =
  | { changed: true; from: DealStage; to: DealStage }
  | { changed: false; reason: "not_found" | "not_allowed" | "raced"; current?: DealStage };

/** Move a deal to `to`, recording why. Throws on a database error. */
export async function transitionDeal(
  db: D1Database,
  dealId: string,
  to: DealStage,
  options: { reason?: string; actor?: string; now?: Date } = {},
): Promise<DealTransitionResult> {
  if (!isStage(to)) throw new TypeError(`unknown deal stage "${String(to)}"`);
  const row = await db.prepare("SELECT stage FROM deals WHERE id = ?1").bind(dealId).first<{ stage: DealStage }>();
  if (!row) return { changed: false, reason: "not_found" };
  if (!canTransitionDeal(row.stage, to)) return { changed: false, reason: "not_allowed", current: row.stage };
  const now = (options.now ?? new Date()).toISOString();
  // The history row is inserted only if the compare-and-set update changed the deal.
  const [update] = await db.batch([
    db.prepare("UPDATE deals SET stage = ?3, updated_at = ?4 WHERE id = ?1 AND stage = ?2").bind(dealId, row.stage, to, now),
    db
      .prepare(
        `INSERT INTO deal_stage_history (id, deal_id, from_stage, to_stage, reason, actor, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() > 0`,
      )
      .bind(crypto.randomUUID(), dealId, row.stage, to, options.reason ?? null, options.actor ?? null, now),
  ]);
  if ((update?.meta.changes ?? 0) === 0) return { changed: false, reason: "raced" };
  return { changed: true, from: row.stage, to };
}
