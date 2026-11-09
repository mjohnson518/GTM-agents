// GTM-agents: the experiment metrics: what each arm, cell, subject variant and send slot earned,
// counted over the send ledger with the one definition of a reply and a positive reply.
//
// Every count is a matured sample, the same rows maturedSamples (outreach.ts) counts: first touches
// only, not bounced, sent at least MATURITY_DAYS before `now`, and sent from the template's current
// copy (the ledger's template_sha256 equals templates.body_sha256), so editing a template's copy
// starts its sample afresh. On top of that:
//   - experimentArmSamples: one experiment's control and treatment, from the arm the send function
//     recorded on each ledger row (experiment_id, experiment_arm). For a reply metric the success is
//     a positive reply (positive_reply) or any human reply (conversation_started). For a product
//     metric (signed_up, activated, paid) the denominator is the same matured first touches and the
//     success is the product outcome (product.ts) whose funnel row credits that experiment and arm:
//     the lifecycle module credits the last arm the person received within the attribution window,
//     once per contact and outcome;
//   - templateCellSamples: each template's matured sends by segment, team size and persona, the
//     cells Thompson allocation decides in;
//   - subjectVariantSamples: each subject variant's matured sends, joined from the draft the
//     variant was assigned to; plus every send of the test at any age, for the zero-reply tripwire;
//   - sendSlotSamples: the send-time test's slots, joined from the slot each draft was scheduled in;
//   - verifiedReadyContacts: contacts the cold batch could still select (cold, never contacted,
//     kept by fit, deliverable), the numerator of verified runway.
// Every function throws on a database error, so a caller shows unreadable instead of a zero.
import { PRODUCT_OUTCOME_SOURCES, type ProductOutcome } from "./product.ts";
import { maturedBefore } from "./outreach.ts";
import { firstTouchSql, humanReplySql, n, positiveReplySql, sqlList } from "./sql.ts";
import type { MetricWindow } from "./window.ts";

/** The metrics an experiment may be pre-registered on. */
export const EXPERIMENT_METRICS = ["positive_reply", "conversation_started", "signed_up", "activated", "paid"] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

/** The metrics whose outcome comes from the product, not from mail. */
export const PRODUCT_EXPERIMENT_METRICS: readonly ExperimentMetric[] = Object.freeze(["signed_up", "activated", "paid"]);

export function isExperimentMetric(value: unknown): value is ExperimentMetric {
  return typeof value === "string" && (EXPERIMENT_METRICS as readonly string[]).includes(value);
}

export function isProductMetric(metric: ExperimentMetric): boolean {
  return PRODUCT_EXPERIMENT_METRICS.includes(metric);
}

const PRODUCT_EVENT: Record<"signed_up" | "activated" | "paid", ProductOutcome> = { signed_up: "signed_up", activated: "activated", paid: "subscribed" };

export const EXPERIMENT_ARMS = ["control", "treatment"] as const;
export type ExperimentArm = (typeof EXPERIMENT_ARMS)[number];

export interface ArmSample {
  sends: number;
  successes: number;
}

export interface ExperimentSamples {
  control: ArmSample;
  treatment: ArmSample;
}

// The matured-sample condition, the same as maturedSamples: first touch, not bounced, current copy.
const MATURED = (a: string) => `${firstTouchSql(a)} AND ${a}.bounced_at IS NULL AND ${a}.sent_at < ?1 AND ${a}.template_sha256 = t.body_sha256`;

/** One experiment's matured samples per arm on its metric, at `now`. */
export async function experimentArmSamples(db: D1Database, experimentId: string, metric: ExperimentMetric, now: Date): Promise<ExperimentSamples> {
  const cutoff = maturedBefore(now);
  let success: string;
  if (metric === "positive_reply") success = positiveReplySql("os");
  else if (metric === "conversation_started") success = humanReplySql("os");
  else {
    const event = PRODUCT_EVENT[metric];
    // The outcome's funnel row names this experiment and arm; os.contact_id ties it to the send.
    success = `EXISTS (SELECT 1 FROM funnel_events f
                 WHERE f.contact_id = os.contact_id AND f.event_type = '${event}' AND f.source IN (${sqlList(PRODUCT_OUTCOME_SOURCES)})
                   AND f.experiment_id = os.experiment_id AND json_valid(f.metadata) AND json_extract(f.metadata, '$.arm') = os.experiment_arm)`;
  }
  const { results } = await db
    .prepare(
      `SELECT os.experiment_arm AS arm, COUNT(*) AS sends, SUM(CASE WHEN ${success} THEN 1 ELSE 0 END) AS successes
         FROM outreach_sends os
         JOIN templates t ON t.id = os.template_id
        WHERE ${MATURED("os")} AND os.experiment_id = ?2 AND os.experiment_arm IN (${sqlList(EXPERIMENT_ARMS)})
        GROUP BY os.experiment_arm`,
    )
    .bind(cutoff, experimentId)
    .all<{ arm: string; sends: number | null; successes: number | null }>();
  const out: ExperimentSamples = { control: { sends: 0, successes: 0 }, treatment: { sends: 0, successes: 0 } };
  for (const r of results) if (r.arm === "control" || r.arm === "treatment") out[r.arm] = { sends: n(r.sends), successes: n(r.successes) };
  return out;
}

export interface CellSample {
  templateId: string;
  segment: string | null;
  teamSize: string | null;
  persona: string | null;
  sends: number;
  positives: number;
}

/** Matured samples per template and cell (segment, team size, persona), first touches sent in the window. */
export async function templateCellSamples(db: D1Database, window: MetricWindow, now: Date): Promise<CellSample[]> {
  const cutoff = maturedBefore(now);
  const end = cutoff < window.to ? cutoff : window.to;
  const { results } = await db
    .prepare(
      `SELECT os.template_id AS template_id, COALESCE(af.segment, a.segment) AS segment, af.team_size AS team_size, ac.persona AS persona,
              COUNT(*) AS sends, SUM(CASE WHEN ${positiveReplySql("os")} THEN 1 ELSE 0 END) AS positives
         FROM outreach_sends os
         JOIN templates t ON t.id = os.template_id
         LEFT JOIN accounts a ON a.account_key = os.account_key
         LEFT JOIN account_fit af ON af.account_key = os.account_key
         LEFT JOIN account_contacts ac ON ac.contact_id = os.contact_id AND ac.account_key = os.account_key
        WHERE ${MATURED("os")} AND os.sent_at >= ?2
        GROUP BY os.template_id, COALESCE(af.segment, a.segment), af.team_size, ac.persona
        ORDER BY os.template_id`,
    )
    .bind(end, window.from)
    .all<{ template_id: string; segment: string | null; team_size: string | null; persona: string | null; sends: number | null; positives: number | null }>();
  return results.map((r) => ({ templateId: r.template_id, segment: r.segment, teamSize: r.team_size, persona: r.persona, sends: n(r.sends), positives: n(r.positives) }));
}

export interface VariantSample {
  variantId: string;
  sends: number;
  humanReplies: number;
  positives: number;
}

export interface SubjectTestSamples {
  /** Matured samples per variant, in variant id order. Variants with no matured send are absent. */
  variants: VariantSample[];
  /** Every first touch of the test at any age, and the human replies to them: the tripwire's input. */
  allSends: number;
  allHumanReplies: number;
}

/** A subject test's samples, from the drafts its variants were assigned to. */
export async function subjectVariantSamples(db: D1Database, testId: string, now: Date): Promise<SubjectTestSamples> {
  const cutoff = maturedBefore(now);
  const [matured, all] = await db.batch<{ variant_id?: string; sends: number | null; human: number | null; positives?: number | null }>([
    db
      .prepare(
        `SELECT sa.variant_id AS variant_id, COUNT(*) AS sends,
                SUM(CASE WHEN ${humanReplySql("os")} THEN 1 ELSE 0 END) AS human,
                SUM(CASE WHEN ${positiveReplySql("os")} THEN 1 ELSE 0 END) AS positives
           FROM subject_assignments sa
           JOIN outreach_sends os ON os.draft_id = sa.draft_id
           JOIN templates t ON t.id = os.template_id
          WHERE sa.test_id = ?2 AND ${MATURED("os")}
          GROUP BY sa.variant_id ORDER BY sa.variant_id`,
      )
      .bind(cutoff, testId),
    db
      .prepare(
        `SELECT COUNT(*) AS sends, SUM(CASE WHEN ${humanReplySql("os")} THEN 1 ELSE 0 END) AS human
           FROM subject_assignments sa JOIN outreach_sends os ON os.draft_id = sa.draft_id
          WHERE sa.test_id = ?1 AND ${firstTouchSql("os")}`,
      )
      .bind(testId),
  ]);
  const variants = (matured?.results ?? []).map((r) => ({ variantId: String(r.variant_id), sends: n(r.sends), humanReplies: n(r.human), positives: n(r.positives) }));
  const totals = all?.results[0];
  return { variants, allSends: n(totals?.sends), allHumanReplies: n(totals?.human) };
}

export interface SlotSample {
  slot: string;
  sends: number;
  positives: number;
}

/** The send-time test's matured samples per slot, first touches sent in the window. */
export async function sendSlotSamples(db: D1Database, window: MetricWindow, now: Date): Promise<SlotSample[]> {
  const cutoff = maturedBefore(now);
  const end = cutoff < window.to ? cutoff : window.to;
  const { results } = await db
    .prepare(
      `SELECT ss.slot AS slot, COUNT(*) AS sends, SUM(CASE WHEN ${positiveReplySql("os")} THEN 1 ELSE 0 END) AS positives
         FROM send_slot_schedules ss
         JOIN outreach_sends os ON os.draft_id = ss.draft_id
         JOIN templates t ON t.id = os.template_id
        WHERE ${MATURED("os")} AND os.sent_at >= ?2
        GROUP BY ss.slot ORDER BY ss.slot`,
    )
    .bind(end, window.from)
    .all<{ slot: string; sends: number | null; positives: number | null }>();
  return results.map((r) => ({ slot: r.slot, sends: n(r.sends), positives: n(r.positives) }));
}

/** Contacts the cold batch could still select: cold, never contacted, kept by fit, deliverable. */
export async function verifiedReadyContacts(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM contacts c
         JOIN contact_fit cf ON cf.contact_id = c.id AND cf.decision = 'keep'
        WHERE c.warmth = 'cold' AND c.last_contacted_at IS NULL AND c.verification_status = 'deliverable'
          AND NOT EXISTS (SELECT 1 FROM outreach_sends os WHERE os.contact_id = c.id)`,
    )
    .first<{ n: number | null }>();
  return n(row?.n);
}
