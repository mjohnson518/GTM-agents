// GTM-agents: template experiments: the pre-registered record, its states, and the checks that
// stand between a draft and a running experiment.
//
// An experiment compares a control template with a treatment template on one primary metric. It
// is created as a draft (status draft) and can be amended while it is one. It cannot start until
// its pre-registration is complete (missingForStart): hypothesis, population, exclusions, primary
// metric, metric window, baseline rate, minimum detectable effect, max sample per arm (at least
// MIN_SAMPLE_PER_ARM), max duration, stopping rule and both templates. Starting is two steps
// (commands.ts): the first shows the record and both templates' copy with a code; the code is the
// start of a SHA-256 over the record and both template files, so the second step starts it only if
// nothing changed in between. Once running, the record is locked (prereg_locked_at) and no command
// edits it; it ends concluded (evaluate.ts), stopped by the operator, or promoted after a person
// approves the copy change (proposals.ts). At most MAX_RUNNING run at once, checked inside the
// write that starts one.
import { z } from "zod";
import { EXPERIMENT_METRICS, isProductMetric, sampleSizePerArm, type ExperimentMetric } from "../metrics/index.ts";
import { sha256Hex } from "../shared/hash.ts";

export const MAX_RUNNING = 2;
export const MIN_SAMPLE_PER_ARM = 20;
export const MAX_SAMPLE_PER_ARM = 100_000;
export const MAX_DURATION_DAYS = 365;
const TEXT_MAX = 2000;

export type ExperimentStatus = "draft" | "registered" | "running" | "concluded" | "stopped" | "promoted";

export interface ExperimentRecord {
  id: string;
  name: string;
  hypothesis: string;
  variable: string;
  controlTemplateId: string | null;
  treatmentTemplateId: string | null;
  primaryMetric: ExperimentMetric;
  status: ExperimentStatus;
  population: string | null;
  exclusions: string | null;
  metricWindowDays: number | null;
  baselineRate: number | null;
  minDetectableEffect: number | null;
  /** The sends per arm the experiment aims for, fixed when it starts. */
  targetPerArm: number | null;
  maxSamplePerArm: number | null;
  maxDurationDays: number;
  stoppingRule: string | null;
  /** The SHA-256 of each template file when the experiment started; null before it starts. */
  controlSha: string | null;
  treatmentSha: string | null;
  approver: string | null;
  startedAt: string | null;
  concludedAt: string | null;
  promotedAt: string | null;
  confidence: number | null;
  conclusionNotes: string | null;
  createdAt: string;
}

interface ExperimentRow {
  id: string;
  name: string;
  hypothesis: string;
  variable: string;
  control_template_id: string | null;
  treatment_template_id: string | null;
  primary_metric: string;
  status: string;
  population: string | null;
  exclusions: string | null;
  metric_window_days: number | null;
  baseline_rate: number | null;
  min_detectable_effect: number | null;
  target_cohort_size: number | null;
  max_sample_per_arm: number | null;
  max_duration_days: number;
  stopping_rule: string | null;
  control_template_sha256: string | null;
  treatment_template_sha256: string | null;
  approver: string | null;
  started_at: string | null;
  concluded_at: string | null;
  promoted_at: string | null;
  confidence: number | null;
  conclusion_notes: string | null;
  created_at: string;
}

const COLUMNS =
  "id, name, hypothesis, variable, control_template_id, treatment_template_id, primary_metric, status, population, exclusions, metric_window_days, baseline_rate, min_detectable_effect, target_cohort_size, max_sample_per_arm, max_duration_days, stopping_rule, control_template_sha256, treatment_template_sha256, approver, started_at, concluded_at, promoted_at, confidence, conclusion_notes, created_at";

function toRecord(r: ExperimentRow): ExperimentRecord | null {
  if (!(EXPERIMENT_METRICS as readonly string[]).includes(r.primary_metric)) return null;
  return {
    id: r.id,
    name: r.name,
    hypothesis: r.hypothesis,
    variable: r.variable,
    controlTemplateId: r.control_template_id,
    treatmentTemplateId: r.treatment_template_id,
    primaryMetric: r.primary_metric as ExperimentMetric,
    status: r.status as ExperimentStatus,
    population: r.population,
    exclusions: r.exclusions,
    metricWindowDays: r.metric_window_days,
    baselineRate: r.baseline_rate,
    minDetectableEffect: r.min_detectable_effect,
    targetPerArm: r.target_cohort_size,
    maxSamplePerArm: r.max_sample_per_arm,
    maxDurationDays: r.max_duration_days,
    stoppingRule: r.stopping_rule,
    controlSha: r.control_template_sha256,
    treatmentSha: r.treatment_template_sha256,
    approver: r.approver,
    startedAt: r.started_at,
    concludedAt: r.concluded_at,
    promotedAt: r.promoted_at,
    confidence: r.confidence,
    conclusionNotes: r.conclusion_notes,
    createdAt: r.created_at,
  };
}

const text = z.string().trim().min(1).max(TEXT_MAX);
const templateId = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "a template id is lowercase letters, digits, - and _");

/** The fields an operator may give when creating or amending a draft. Unknown keys are refused. */
export const experimentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    hypothesis: text,
    population: text,
    exclusions: text,
    primary_metric: z.enum(EXPERIMENT_METRICS),
    metric_window_days: z.number().int().min(1).max(365),
    baseline_rate: z.number().gt(0).lt(1),
    min_detectable_effect: z.number().gt(0).lt(1),
    max_sample_per_arm: z.number().int().min(MIN_SAMPLE_PER_ARM).max(MAX_SAMPLE_PER_ARM),
    max_duration_days: z.number().int().min(1).max(MAX_DURATION_DAYS),
    stopping_rule: text,
    control_template: templateId,
    treatment_template: templateId,
  })
  .partial()
  .strict();
export type ExperimentInput = z.infer<typeof experimentInputSchema>;

/** The pre-registration fields still missing before the experiment can start. Pure. */
export function missingForStart(r: ExperimentRecord): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, field: string) => {
    if (!ok) missing.push(field);
  };
  need(r.hypothesis.trim() !== "", "hypothesis");
  need(Boolean(r.population?.trim()), "population");
  need(Boolean(r.exclusions?.trim()), "exclusions");
  need(r.metricWindowDays !== null && r.metricWindowDays > 0, "metric_window_days");
  need(r.baselineRate !== null && r.baselineRate > 0 && r.baselineRate < 1, "baseline_rate");
  need(r.minDetectableEffect !== null && r.minDetectableEffect > 0, "min_detectable_effect");
  need(r.maxSamplePerArm !== null && r.maxSamplePerArm >= MIN_SAMPLE_PER_ARM, "max_sample_per_arm");
  need(r.maxDurationDays > 0, "max_duration_days");
  need(Boolean(r.stoppingRule?.trim()), "stopping_rule");
  need(Boolean(r.controlTemplateId), "control_template");
  need(Boolean(r.treatmentTemplateId), "treatment_template");
  if (r.controlTemplateId && r.controlTemplateId === r.treatmentTemplateId) missing.push("two different templates");
  return missing;
}

/** The sends per arm the experiment aims for: the sample-size helper, capped by the max sample. Pure. */
export function targetPerArm(r: Pick<ExperimentRecord, "baselineRate" | "minDetectableEffect" | "maxSamplePerArm">): number | null {
  if (r.maxSamplePerArm === null) return null;
  const helper = r.baselineRate !== null && r.minDetectableEffect !== null ? sampleSizePerArm(r.baselineRate, r.minDetectableEffect) : null;
  return helper === null ? r.maxSamplePerArm : Math.min(helper, r.maxSamplePerArm);
}

/** The minimum age before an experiment may conclude early, in days. Pure. */
export function minimumAgeDays(metric: ExperimentMetric): number {
  return isProductMetric(metric) ? 45 : 10;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export async function loadExperiment(db: D1Database, id: string): Promise<ExperimentRecord | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM experiments WHERE id = ?1`).bind(id).first<ExperimentRow>();
  return row ? toRecord(row) : null;
}

/** Experiments by status, newest first. Throws on a database error. */
export async function listExperiments(db: D1Database, statuses: readonly ExperimentStatus[], limit = 50): Promise<ExperimentRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM experiments WHERE status IN (${statuses.map((_, i) => `?${i + 1}`).join(", ")}) ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`)
    .bind(...statuses)
    .all<ExperimentRow>();
  return results.map(toRecord).filter((r): r is ExperimentRecord => r !== null);
}

/** Running experiments, oldest start first: the order the batch enrolls in. */
export async function runningExperiments(db: D1Database): Promise<ExperimentRecord[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM experiments WHERE status = 'running' ORDER BY started_at ASC, id ASC LIMIT ${MAX_RUNNING + 2}`).all<ExperimentRow>();
  return results.map(toRecord).filter((r): r is ExperimentRecord => r !== null);
}

/** Create a draft. The name and hypothesis are required; the rest may come later. */
export async function createExperiment(db: D1Database, input: ExperimentInput, now: Date): Promise<ExperimentRecord> {
  if (!input.name || !input.hypothesis) throw new Error("an experiment needs at least a name and a hypothesis");
  const id = newId();
  await db
    .prepare(
      `INSERT INTO experiments (id, name, hypothesis, variable, control_template_id, treatment_template_id, primary_metric, status, population, exclusions,
         metric_window_days, baseline_rate, min_detectable_effect, max_sample_per_arm, max_duration_days, stopping_rule, created_at)
       VALUES (?1, ?2, ?3, 'template', ?4, ?5, ?6, 'draft', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      id,
      input.name,
      input.hypothesis,
      input.control_template ?? null,
      input.treatment_template ?? null,
      input.primary_metric ?? "positive_reply",
      input.population ?? null,
      input.exclusions ?? null,
      input.metric_window_days ?? null,
      input.baseline_rate ?? null,
      input.min_detectable_effect ?? null,
      input.max_sample_per_arm ?? null,
      input.max_duration_days ?? 42,
      input.stopping_rule ?? null,
      now.toISOString(),
    )
    .run();
  const created = await loadExperiment(db, id);
  if (!created) throw new Error("the experiment could not be read back");
  return created;
}

/** Amend a draft. Refused (null) once the experiment has left draft. */
export async function amendExperiment(db: D1Database, id: string, input: ExperimentInput): Promise<ExperimentRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    if (value === undefined) return;
    values.push(value);
    sets.push(`${column} = ?${values.length + 1}`);
  };
  set("name", input.name);
  set("hypothesis", input.hypothesis);
  set("population", input.population);
  set("exclusions", input.exclusions);
  set("primary_metric", input.primary_metric);
  set("metric_window_days", input.metric_window_days);
  set("baseline_rate", input.baseline_rate);
  set("min_detectable_effect", input.min_detectable_effect);
  set("max_sample_per_arm", input.max_sample_per_arm);
  set("max_duration_days", input.max_duration_days);
  set("stopping_rule", input.stopping_rule);
  set("control_template_id", input.control_template);
  set("treatment_template_id", input.treatment_template);
  if (sets.length === 0) return loadExperiment(db, id);
  const result = await db
    .prepare(`UPDATE experiments SET ${sets.join(", ")} WHERE id = ?1 AND status = 'draft'`)
    .bind(id, ...values)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return loadExperiment(db, id);
}

/**
 * The fingerprint the two-step start binds to: the pre-registered fields and both template files'
 * SHA-256. Any change to either gives a different code.
 */
export async function startFingerprint(r: ExperimentRecord, controlSha: string, treatmentSha: string): Promise<string> {
  const canonical = JSON.stringify([
    r.id,
    r.status,
    r.name,
    r.hypothesis,
    r.population,
    r.exclusions,
    r.primaryMetric,
    r.metricWindowDays,
    r.baselineRate,
    r.minDetectableEffect,
    r.maxSamplePerArm,
    r.maxDurationDays,
    r.stoppingRule,
    r.controlTemplateId,
    r.treatmentTemplateId,
    controlSha,
    treatmentSha,
  ]);
  return (await sha256Hex(canonical)).slice(0, 6);
}

/**
 * Start a draft: draft to running, only while fewer than MAX_RUNNING run and only if every
 * pre-registered field still holds the value `r` was checked with, in one write. Records both
 * template files' SHA-256, the copy the operator was shown. Returns false when the experiment was
 * not a draft, was amended since, or the running limit was reached.
 */
export async function markStarted(db: D1Database, r: ExperimentRecord, approver: string, now: Date, copy: { controlSha: string; treatmentSha: string }): Promise<boolean> {
  const at = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE experiments SET status = 'running', approver = ?2, approved_at = ?3, prereg_locked_at = ?3, started_at = ?3, target_cohort_size = ?4,
              control_template_sha256 = ?5, treatment_template_sha256 = ?6
        WHERE id = ?1 AND status = 'draft' AND (SELECT COUNT(*) FROM experiments WHERE status = 'running') < ${MAX_RUNNING}
          AND name IS ?7 AND hypothesis IS ?8 AND population IS ?9 AND exclusions IS ?10 AND primary_metric IS ?11 AND metric_window_days IS ?12
          AND baseline_rate IS ?13 AND min_detectable_effect IS ?14 AND max_sample_per_arm IS ?15 AND max_duration_days IS ?16 AND stopping_rule IS ?17
          AND control_template_id IS ?18 AND treatment_template_id IS ?19`,
    )
    .bind(
      r.id,
      approver,
      at,
      targetPerArm(r),
      copy.controlSha,
      copy.treatmentSha,
      r.name,
      r.hypothesis,
      r.population,
      r.exclusions,
      r.primaryMetric,
      r.metricWindowDays,
      r.baselineRate,
      r.minDetectableEffect,
      r.maxSamplePerArm,
      r.maxDurationDays,
      r.stoppingRule,
      r.controlTemplateId,
      r.treatmentTemplateId,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Why an experiment's copy no longer matches what it started with, or null when it does (or it
 * started before copy was recorded). Pure.
 */
export function copyChanged(r: Pick<ExperimentRecord, "controlTemplateId" | "treatmentTemplateId" | "controlSha" | "treatmentSha">, served: ReadonlyMap<string, { sha256: string }>): string | null {
  const changed: string[] = [];
  if (r.controlSha && served.get(r.controlTemplateId ?? "")?.sha256 !== r.controlSha) changed.push(`control ${r.controlTemplateId}`);
  if (r.treatmentSha && served.get(r.treatmentTemplateId ?? "")?.sha256 !== r.treatmentSha) changed.push(`treatment ${r.treatmentTemplateId}`);
  return changed.length > 0 ? `the copy of ${changed.join(" and ")} changed or is no longer served since the experiment started` : null;
}

/** Stop a draft or running experiment. Returns false when it was in neither state. */
export async function markStopped(db: D1Database, id: string, notes: string, now: Date): Promise<boolean> {
  const result = await db
    .prepare("UPDATE experiments SET status = 'stopped', concluded_at = ?2, conclusion_notes = ?3 WHERE id = ?1 AND status IN ('draft', 'running')")
    .bind(id, now.toISOString(), notes)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Conclude a running experiment with its confidence and notes. Returns false when it was not running. */
export async function markConcluded(db: D1Database, id: string, confidence: number | null, notes: string, now: Date): Promise<boolean> {
  const result = await db
    .prepare("UPDATE experiments SET status = 'concluded', concluded_at = ?2, confidence = ?3, conclusion_notes = ?4 WHERE id = ?1 AND status = 'running'")
    .bind(id, now.toISOString(), confidence, notes)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** The verdict a concluded experiment recorded, from its notes. Pure. */
export function recordedVerdict(r: Pick<ExperimentRecord, "conclusionNotes">): "keep" | "discard" | "inconclusive" | null {
  const m = /^(keep|discard|inconclusive)\b/.exec(r.conclusionNotes ?? "");
  return m ? (m[1] as "keep" | "discard" | "inconclusive") : null;
}

/** Days from `from` to `now`, fractional. Pure. */
export function ageDays(from: string | null, now: Date): number {
  if (!from) return 0;
  const t = Date.parse(from);
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : 0;
}
