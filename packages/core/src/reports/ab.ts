// GTM-agents: the A/B dashboard: running tests and recent conclusions, with lift over the second best.
//
// Every number comes from the metrics module: experiment arms (experimentArmSamples), template arms
// (maturedSamples), subject variants (subjectVariantSamples) and send slots (sendSlotSamples), all
// matured samples on the one definition of a positive reply, and rates through replyRate. The
// confidence shown for a running experiment is the deterministic normal approximation of P(treatment
// beats control), so the dashboard never depends on a random draw; the conclusion itself is decided
// by the cycle (experiments/evaluate.ts). Lift is the best arm's rate minus the second best's, in
// points. A slice with fewer than MIN_SLICE_SENDS matured sends is labelled directional and never
// named a leader. Nothing here changes anything.
import {
  daysBefore,
  experimentArmSamples,
  maturedSamples,
  measurementHealth,
  probabilityBetterNormal,
  replyRate,
  sendSlotSamples,
  subjectVariantSamples,
  unreadableHealth,
  type ExperimentSamples,
  type MeasurementHealth,
} from "../metrics/index.ts";
import { listExperiments, recordedVerdict, type ExperimentRecord } from "../experiments/store.ts";
import { activeSubjectTests } from "../experiments/subject.ts";
import { MIN_SLICE_SENDS } from "./conversion.ts";
import { pct, ratio, UNREADABLE } from "./format.ts";
import { points } from "./holdout.ts";
import { healthLine } from "./scorecard.ts";

/** Conclusions this recent are shown. */
export const AB_RECENT_DAYS = 30;
const LOOKBACK_DAYS = 90;

export interface AbArm {
  id: string;
  sends: number;
  successes: number;
}

export interface AbTest {
  kind: "experiment" | "subject test" | "templates" | "send time";
  id: string;
  name: string;
  arms: AbArm[];
  /** P(treatment beats control) for an experiment, else null. */
  confidence: number | null;
  note: string;
}

export interface AbDashboardData {
  health: MeasurementHealth;
  running: AbTest[];
  recent: ExperimentRecord[];
  unreadable: string[];
}

/** The best arm's rate minus the second best's, or null without two arms with sends. Pure. */
export function liftOverSecondBest(arms: readonly AbArm[]): { leader: string; lift: number } | null {
  const rated = arms
    .map((a) => ({ id: a.id, rate: replyRate(a.successes, a.sends), sends: a.sends }))
    .filter((a): a is { id: string; rate: number; sends: number } => a.rate !== null)
    .sort((a, b) => b.rate - a.rate || b.sends - a.sends);
  const [first, second] = rated;
  return first && second ? { leader: first.id, lift: first.rate - second.rate } : null;
}

const armsOf = (s: ExperimentSamples): AbArm[] => [
  { id: "control", ...s.control },
  { id: "treatment", ...s.treatment },
];

/** Load the dashboard. Each section that cannot be read is named, never shown as zero. */
export async function loadAbDashboard(db: D1Database, now: Date): Promise<AbDashboardData> {
  const unreadable: string[] = [];
  let health: MeasurementHealth;
  try {
    health = await measurementHealth(db, now);
  } catch {
    health = unreadableHealth();
  }
  const running: AbTest[] = [];
  try {
    for (const e of await listExperiments(db, ["running"], 10)) {
      const s = await experimentArmSamples(db, e.id, e.primaryMetric, now);
      running.push({
        kind: "experiment",
        id: e.id,
        name: e.name,
        arms: armsOf(s),
        confidence: probabilityBetterNormal({ sends: s.treatment.sends, successes: s.treatment.successes }, { sends: s.control.sends, successes: s.control.successes }),
        note: `${e.primaryMetric}, control ${e.controlTemplateId}, treatment ${e.treatmentTemplateId}, target ${e.targetPerArm ?? "n/a"} per arm, started ${e.startedAt?.slice(0, 10) ?? "n/a"}`,
      });
    }
  } catch {
    unreadable.push("experiments");
  }
  try {
    for (const t of (await activeSubjectTests(db)).filter((x) => x.status === "running").slice(0, 10)) {
      const s = await subjectVariantSamples(db, t.id, now);
      running.push({ kind: "subject test", id: t.id, name: t.name, arms: s.variants.map((v) => ({ id: v.variantId, sends: v.sends, successes: v.positives })), confidence: null, note: `template ${t.templateId}, ${s.allSends} sends in all` });
    }
  } catch {
    unreadable.push("subject tests");
  }
  try {
    const samples = await maturedSamples(db, daysBefore(now, LOOKBACK_DAYS), now);
    if (samples.length > 1) running.push({ kind: "templates", id: "allocation", name: "cold templates", arms: samples.map((s) => ({ id: s.templateId, sends: s.sends, successes: s.positiveReplies })), confidence: null, note: `matured first touches, last ${LOOKBACK_DAYS} days` });
  } catch {
    unreadable.push("templates");
  }
  try {
    const slots = await sendSlotSamples(db, daysBefore(now, LOOKBACK_DAYS), now);
    if (slots.length > 0) running.push({ kind: "send time", id: "send_time", name: "send-time test", arms: slots.map((s) => ({ id: s.slot, sends: s.sends, successes: s.positives })), confidence: null, note: "recipient-local slots" });
  } catch {
    unreadable.push("send-time test");
  }
  let recent: ExperimentRecord[] = [];
  try {
    const since = new Date(now.getTime() - AB_RECENT_DAYS * 86_400_000).toISOString();
    recent = (await listExperiments(db, ["concluded", "promoted", "stopped"], 20)).filter((e) => (e.concludedAt ?? "") >= since);
  } catch {
    unreadable.push("recent conclusions");
  }
  return { health, running, recent, unreadable };
}

/** Render the dashboard. Pure. */
export function renderAbDashboard(d: AbDashboardData): string {
  const lines = ["A/B dashboard", healthLine(d.health), ""];
  if (d.running.length === 0) lines.push("No tests are running.");
  for (const t of d.running) {
    lines.push(`${t.kind} ${t.id} (${t.name}): ${t.note}`);
    for (const a of t.arms) lines.push(`  ${a.id}: ${ratio(a.successes, a.sends)} positive${a.sends < MIN_SLICE_SENDS ? " (directional)" : ""}`);
    const lift = liftOverSecondBest(t.arms.filter((a) => a.sends >= MIN_SLICE_SENDS));
    lines.push(`  ${lift ? `leader ${lift.leader}, ${points(lift.lift)} over the second best` : "no leader: fewer than two arms with enough matured sends"}${t.confidence !== null ? `; P(treatment better) ${pct(t.confidence)}` : ""}`);
  }
  lines.push("", `Concluded in the last ${AB_RECENT_DAYS} days:`);
  if (d.recent.length === 0) lines.push("  none");
  for (const e of d.recent) lines.push(`  ${e.id} (${e.name}): ${e.status === "stopped" ? "stopped" : (recordedVerdict(e) ?? e.status)}${e.status === "promoted" ? ", promoted" : ""}${e.confidence !== null ? `, confidence ${pct(e.confidence)}` : ""}`);
  for (const section of d.unreadable) lines.push(`The ${section} section ${UNREADABLE}.`);
  return lines.join("\n");
}
