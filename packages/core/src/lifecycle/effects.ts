// GTM-agents: what a lifecycle transition does besides moving the state (docs/LIFECYCLE.md).
//
// Each side effect is claimed in the effects ledger under the transition's id before it runs and
// released if it fails (runOnce), so a transition that is routed again repeats only what did not
// finish. They are, in order:
//   - stop: entering a product state from before sign-up, or opting out, ends the contact's cold
//     sequences (stopSequences), cancels their queued cold and sequence sends and rejects their open
//     cold and follow-up drafts. A product user is not a prospect;
//   - deal: the deal mirror. signed_up calls for trial, at_wall for proposal, paying and expanding
//     for closed_won, churned for closed_lost (loss reason "churned"). The contact's open deal steps
//     one stage at a time through transitionDeal, never backwards. With no open deal, one is
//     created for every target but a loss, claimed per contact so two transitions racing cannot
//     create two. A contact who already has a won deal never gets another, and a churn does not
//     close their other deals: the sale happened, and churn lives in the lifecycle;
//   - funnel: the funnel event the conversion report and the product metrics read
//     (metrics/product.ts). signed_up, activated and the first paying state are written at most once
//     per contact, ever; limit reached and churned once per transition. Each row records the first
//     touch it is credited to and the experiment arm the contact last received, if any;
//   - warmth: the state's warmth summary, forward only (advanceWarmth);
//   - erase: entering deleted runs the erasure (data/erasure.ts) last, after the tombstone the
//     caller wrote first.
import { advanceWarmth } from "../data/contacts.ts";
import { canTransitionDeal, transitionDeal } from "../data/deals.ts";
import { DEAL_STAGES, type DealStage, type LifecycleState } from "../data/enums.ts";
import { eraseContact, type ErasureSource } from "../data/erasure.ts";
import { runOnce } from "../events/effects.ts";
import { experimentArmForOutcome, firstTouchForOutcome } from "../metrics/product.ts";
import { stopSequences } from "../sequences/state.ts";
import { dealStageFor, isPreSignup, isProductState, warmthFor } from "./states.ts";

export const TRANSITION_EFFECTS = ["stop", "deal", "funnel", "warmth", "erase"] as const;
export type TransitionEffect = (typeof TRANSITION_EFFECTS)[number];

/** Where a transition came from, as funnel_events.source records it. */
export type LifecycleSource = "product" | "billing" | "agent";
const FUNNEL_SOURCE: Record<LifecycleSource, string> = { product: "product", billing: "webhook", agent: "agent" };

/** Cancellation reasons kept on a churned deal. Anything else is "unspecified"; free text is never kept. */
export const CANCEL_REASONS = ["too_expensive", "missing_features", "switched_service", "unused", "customer_service", "too_complex", "low_quality", "other"] as const;

export function cancelReason(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (CANCEL_REASONS as readonly string[]).includes(value) ? value : "unspecified";
}

export interface TransitionRecord {
  id: string;
  contactId: string;
  from: LifecycleState | null;
  to: LifecycleState;
  occurredAt: string;
}

export interface EffectDeps {
  db: D1Database;
  now: Date;
  source: LifecycleSource;
  /** churned: why, already reduced to a CANCEL_REASONS value. */
  reason?: string;
  /** deleted: the erasure needs these. */
  erasure?: { source: ErasureSource; productUserId?: string; bucket?: Pick<R2Bucket, "delete"> | null };
}

const OPEN = DEAL_STAGES.filter((s) => s !== "closed_won" && s !== "closed_lost");
const FORWARD: readonly DealStage[] = [...OPEN, "closed_won"];

/** The stages to step through from `current` to `target`, in order; empty when the target is not ahead. Pure. */
export function dealPath(current: DealStage, target: DealStage): DealStage[] {
  if (current === "closed_won" || current === "closed_lost") return [];
  if (target === "closed_lost") return ["closed_lost"];
  const from = FORWARD.indexOf(current);
  const to = FORWARD.indexOf(target);
  if (from < 0 || to <= from) return [];
  return FORWARD.slice(from + 1, to + 1);
}

/** End cold outreach to one contact. Throws on a database error. */
export async function stopColdOutreach(db: D1Database, contactId: string, to: LifecycleState, now: Date): Promise<void> {
  const reason = `lifecycle ${to}`;
  await stopSequences(db, { contactIds: [contactId] }, { reason, status: to === "opted_out" ? "opted_out" : "converted", now });
  await db.batch([
    db
      .prepare("UPDATE deferred_sends SET status = 'cancelled', last_error = ?2 WHERE contact_id = ?1 AND status = 'queued' AND send_path IN ('cold', 'sequence')")
      .bind(contactId, `cancelled: ${reason}`),
    db
      .prepare("UPDATE drafts SET status = 'rejected', updated_at = ?2 WHERE contact_id = ?1 AND kind IN ('cold_intro', 'follow_up', 'breakup') AND status IN ('draft', 'pending_approval', 'approved')")
      .bind(contactId, now.toISOString()),
  ]);
}

/** Step the contact's deal toward what `to` calls for. Returns what happened, for the audit row. Throws on a database error. */
export async function mirrorDeal(db: D1Database, contactId: string, to: LifecycleState, options: { now: Date; reason?: string }): Promise<string> {
  const target = dealStageFor(to);
  if (!target) return "no stage";
  const won = await db.prepare("SELECT id FROM deals WHERE contact_id = ?1 AND stage = 'closed_won' LIMIT 1").bind(contactId).first<{ id: string }>();
  if (won) return "already won";
  const findOpen = () =>
    db.prepare("SELECT id, stage FROM deals WHERE contact_id = ?1 AND stage NOT IN ('closed_won', 'closed_lost') ORDER BY updated_at DESC, id LIMIT 1").bind(contactId).first<{ id: string; stage: DealStage }>();
  let deal = await findOpen();
  if (!deal) {
    if (target === "closed_lost") return "no open deal";
    // One creation per contact, ever: a second transition racing this one finds the claim and the
    // deal it made. The claim is released if the insert fails, so the next attempt can create it.
    const created = await runOnce(db, `deal_mirror:${contactId}`, "create", async () => {
      const contact = await db
        .prepare("SELECT c.account_key, a.name AS account_name FROM contacts c LEFT JOIN accounts a ON a.account_key = c.account_key WHERE c.id = ?1")
        .bind(contactId)
        .first<{ account_key: string | null; account_name: string | null }>();
      if (!contact) throw new Error("the contact is gone");
      const at = options.now.toISOString();
      const name = (contact.account_name ?? contact.account_key ?? "Product user").slice(0, 80);
      // One statement checks and inserts, so a deal another writer (calendar sync) opened for this
      // contact in the meantime is used instead of a second one.
      await db
        .prepare(
          `INSERT INTO deals (id, account_key, contact_id, name, stage, source, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, 'prospecting', 'lifecycle', ?5, ?5
            WHERE NOT EXISTS (SELECT 1 FROM deals WHERE contact_id = ?3 AND stage NOT IN ('closed_won', 'closed_lost'))`,
        )
        .bind(`deal_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, contact.account_key, contactId, name, at)
        .run();
    });
    deal = await findOpen();
    if (!deal) return created.ran ? "no deal" : "creation claimed elsewhere";
  }
  // One stage at a time, reading the stage again before each step: another writer may move the
  // deal meanwhile (a booked meeting to demo_scheduled), and the path then starts from there.
  let stage = deal.stage;
  for (let guard = 0; guard <= DEAL_STAGES.length; guard++) {
    const next = dealPath(stage, target)[0];
    if (!next || !canTransitionDeal(stage, next)) break;
    const reason = next === "closed_lost" ? `lifecycle churned (${options.reason ?? "unspecified"})` : `lifecycle ${to}`;
    const moved = await transitionDeal(db, deal.id, next, { reason, actor: "lifecycle", now: options.now });
    stage = moved.changed ? next : (moved.current ?? stage);
    if (!moved.changed && moved.reason === "not_found") break;
  }
  if (stage === "closed_lost") await db.prepare("UPDATE deals SET loss_reason = 'churned' WHERE id = ?1 AND stage = 'closed_lost' AND loss_reason IS NULL").bind(deal.id).run();
  return `deal at ${stage}`;
}

/** The funnel event type a transition writes, and whether it is once per contact. */
function funnelFor(from: LifecycleState | null, to: LifecycleState): { type: string; perContact: boolean } | null {
  if (to === "signed_up") return { type: "signed_up", perContact: true };
  if (to === "activated") return { type: "activated", perContact: true };
  if ((to === "paying" || to === "expanding") && from !== "paying" && from !== "expanding" && from !== "at_risk") return { type: "subscribed", perContact: true };
  if (to === "at_wall") return { type: "limit_reached", perContact: false };
  if (to === "churned") return { type: "churned", perContact: false };
  return null;
}

async function recordFunnel(db: D1Database, t: TransitionRecord, source: LifecycleSource, now: Date): Promise<void> {
  const funnel = funnelFor(t.from, t.to);
  if (!funnel) return;
  const key = funnel.perContact ? `funnel:${t.contactId}` : `funnel:${t.id}`;
  await runOnce(db, key, funnel.type, async () => {
    const [touch, arm, attribution] = await Promise.all([
      firstTouchForOutcome(db, t.contactId, t.occurredAt),
      experimentArmForOutcome(db, t.contactId, t.occurredAt),
      db.prepare("SELECT attributed_campaign_id, attribution_method FROM contact_lifecycle WHERE contact_id = ?1").bind(t.contactId).first<{ attributed_campaign_id: string | null; attribution_method: string | null }>(),
    ]);
    const metadata = {
      ...(touch ? { first_touch: touch.sendId, template_id: touch.templateId } : {}),
      ...(arm ? { arm: arm.arm } : {}),
      ...(attribution?.attribution_method ? { attribution: attribution.attribution_method } : {}),
    };
    await db
      .prepare("INSERT INTO funnel_events (id, event_type, contact_id, source, campaign_id, experiment_id, metadata, occurred_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
      .bind(
        `fe_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        funnel.type,
        t.contactId,
        FUNNEL_SOURCE[source],
        touch?.campaignId ?? attribution?.attributed_campaign_id ?? null,
        arm?.experimentId ?? null,
        JSON.stringify(metadata),
        t.occurredAt,
        now.toISOString(),
      )
      .run();
  });
}

/**
 * Run a transition's side effects, each at most once. Returns the effects that failed (their claims
 * are released, so running this again for the same transition retries exactly those). Never throws.
 */
export async function runTransitionEffects(deps: EffectDeps, t: TransitionRecord): Promise<TransitionEffect[]> {
  const failed: TransitionEffect[] = [];
  const key = `lifecycle:${t.id}`;
  const step = async (name: TransitionEffect, applies: boolean, fn: () => Promise<unknown>) => {
    if (!applies) return;
    try {
      await runOnce(deps.db, key, name, fn);
    } catch {
      failed.push(name);
    }
  };
  await step("stop", (isPreSignup(t.from) && isProductState(t.to)) || t.to === "opted_out" || t.to === "deleted", () => stopColdOutreach(deps.db, t.contactId, t.to, deps.now));
  await step("deal", dealStageFor(t.to) !== null, () => mirrorDeal(deps.db, t.contactId, t.to, { now: deps.now, ...(deps.reason ? { reason: deps.reason } : {}) }));
  await step("funnel", t.to !== "deleted", () => recordFunnel(deps.db, t, deps.source, deps.now));
  const warmth = warmthFor(t.to);
  await step("warmth", warmth !== null, () => advanceWarmth(deps.db, t.contactId, warmth ?? "cold", deps.now));
  await step("erase", t.to === "deleted", async () => {
    const contact = await deps.db.prepare("SELECT email FROM contacts WHERE id = ?1").bind(t.contactId).first<{ email: string }>();
    if (!contact) return;
    const erasure = deps.erasure ?? { source: "product" as ErasureSource };
    await eraseContact(deps.db, contact.email, {
      source: erasure.source,
      now: deps.now,
      ...(erasure.productUserId ? { productUserId: erasure.productUserId } : {}),
      ...(erasure.bucket !== undefined ? { bucket: erasure.bucket } : {}),
    });
  });
  return failed;
}
