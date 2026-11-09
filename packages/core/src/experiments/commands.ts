// GTM-agents: the operator's experiment commands. They never reach the model, and only an
// allowlisted operator can send them (the chat consumer checks before routing here, and runs each
// once per message).
//
//   experiment-create <fields>          create a draft experiment (JSON, or one "key: value" per line)
//   experiment-update <id> <fields>     amend a draft
//   experiment-show <id>                the record, its arms and what it still needs
//   experiment-start <id>               step one: the record, both templates' numbered copy, and the
//                                       command that starts it; nothing starts yet
//   experiment-start-<id>-<code>        step two: starts it only if nothing changed since step one
//   experiment-stop <id>                stop a draft or running experiment; nothing is promoted
//   experiment-list                     every experiment that is not stopped, newest first
//   exp-list                            pending proposals
//   exp-approve-<id> / exp-reject-<id>  apply or decline a proposal (proposals.ts)
//   subject-test-create <fields>        a subject test: name, template, and two to five variants
//   subject-test-stop <id>              stop a subject test without a winner
//   ab-dashboard                        the A/B dashboard (reports/ab.ts)
//   sample-size <baseline> <mde>        sends per arm for a two-sided 95%, 80% power test
// Fields are the pre-registration: name, hypothesis, population, exclusions, primary_metric
// (positive_reply, conversation_started, signed_up, activated or paid; positive_reply when
// omitted), metric_window_days, baseline_rate, min_detectable_effect (absolute), max_sample_per_arm
// (at least 20), max_duration_days, stopping_rule, control_template, treatment_template.
import type { FlagReader } from "../jobs/registry.ts";
import { measurementHealth, isProductMetric, sampleSizePerArm, unreadableHealth } from "../metrics/index.ts";
import { batchTemplates } from "../outreach/allocate.ts";
import { loadAbDashboard, renderAbDashboard } from "../reports/ab.ts";
import type { KvStore } from "../shared/kv.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { GATE_MIN_PER_ARM } from "./gate.ts";
import { EXPERIMENT_FLAGS, readSwitch } from "./flags.ts";
import { approveProposal, pendingProposals, proposalText, rejectProposal, trackRecord } from "./proposals.ts";
import {
  MAX_RUNNING,
  amendExperiment,
  createExperiment,
  experimentInputSchema,
  listExperiments,
  loadExperiment,
  markStarted,
  markStopped,
  minimumAgeDays,
  missingForStart,
  startFingerprint,
  targetPerArm,
  type ExperimentInput,
  type ExperimentRecord,
} from "./store.ts";
import { createSubjectTest, stopSubjectTest, subjectTestInputSchema } from "./subject.ts";

export type ExperimentCommand =
  | { kind: "create"; body: string }
  | { kind: "update"; id: string; body: string }
  | { kind: "show"; id: string }
  | { kind: "start"; id: string }
  | { kind: "confirm_start"; id: string; code: string }
  | { kind: "stop"; id: string }
  | { kind: "list" }
  | { kind: "proposals" }
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string }
  | { kind: "subject_create"; body: string }
  | { kind: "subject_stop"; id: string }
  | { kind: "dashboard" }
  | { kind: "sample_size"; baseline: string; mde: string };

const ID = "([0-9a-f]{10})";
const PATTERNS: Array<[RegExp, (m: RegExpExecArray) => ExperimentCommand]> = [
  [new RegExp(`^experiment[-_]start[-_]${ID}[-_]([0-9a-f]{6})$`, "i"), (m) => ({ kind: "confirm_start", id: (m[1] ?? "").toLowerCase(), code: (m[2] ?? "").toLowerCase() })],
  [new RegExp(`^experiment[-_]start\\s+${ID}$`, "i"), (m) => ({ kind: "start", id: (m[1] ?? "").toLowerCase() })],
  [new RegExp(`^experiment[-_]show\\s+${ID}$`, "i"), (m) => ({ kind: "show", id: (m[1] ?? "").toLowerCase() })],
  [new RegExp(`^experiment[-_]stop\\s+${ID}$`, "i"), (m) => ({ kind: "stop", id: (m[1] ?? "").toLowerCase() })],
  [new RegExp(`^experiment[-_]update\\s+${ID}\\s+([\\s\\S]+)$`, "i"), (m) => ({ kind: "update", id: (m[1] ?? "").toLowerCase(), body: m[2] ?? "" })],
  [/^experiment[-_]create\s+([\s\S]+)$/i, (m) => ({ kind: "create", body: m[1] ?? "" })],
  [/^experiment[-_]create$/i, () => ({ kind: "create", body: "" })],
  [/^experiments?(?:[-_]list)?$/i, () => ({ kind: "list" })],
  [/^exp[-_]list$/i, () => ({ kind: "proposals" })],
  [new RegExp(`^exp[-_]approve[-_]${ID}$`, "i"), (m) => ({ kind: "approve", id: (m[1] ?? "").toLowerCase() })],
  [new RegExp(`^exp[-_]reject[-_]${ID}$`, "i"), (m) => ({ kind: "reject", id: (m[1] ?? "").toLowerCase() })],
  [/^subject[-_]test[-_]create\s+([\s\S]+)$/i, (m) => ({ kind: "subject_create", body: m[1] ?? "" })],
  [new RegExp(`^subject[-_]test[-_]stop\\s+${ID}$`, "i"), (m) => ({ kind: "subject_stop", id: (m[1] ?? "").toLowerCase() })],
  [/^ab[-_]dashboard$/i, () => ({ kind: "dashboard" })],
  [/^sample[-_]size\s+(\S+)\s+(\S+)$/i, (m) => ({ kind: "sample_size", baseline: m[1] ?? "", mde: m[2] ?? "" })],
];

/** The experiment command in a message, or null when it is not one. A leading "/" is allowed. */
export function parseExperimentCommand(text: string): ExperimentCommand | null {
  const trimmed = text.trim().replace(/^\//, "");
  for (const [re, build] of PATTERNS) {
    const m = re.exec(trimmed);
    if (m) return build(m);
  }
  return null;
}

export const EXPERIMENT_HELP_LINES: readonly string[] = Object.freeze([
  "experiment-create <fields>  create a draft experiment (JSON, or one key: value per line)",
  "experiment-update <id> <fields> / experiment-show <id> / experiment-list  amend, show or list experiments",
  "experiment-start <id>  show the record and both templates, with the command that starts it if nothing changes",
  "experiment-stop <id>  stop an experiment; nothing is promoted",
  "exp-list / exp-approve-<id> / exp-reject-<id>  pending proposals, and apply or decline one",
  "subject-test-create <fields> / subject-test-stop <id>  a subject-line test on one template",
  "ab-dashboard  running tests and recent conclusions",
  "sample-size <baseline> <mde>  sends per arm for a two-sided 95%, 80% power test",
]);

const NUMERIC = new Set(["metric_window_days", "baseline_rate", "min_detectable_effect", "max_sample_per_arm", "max_duration_days"]);

/**
 * Fields from a message: a JSON object, or one "key: value" per line (repeated variant lines
 * collect into variants). Keys are lowercased with spaces as underscores. Pure.
 */
export function parseFields(body: string): Record<string, unknown> | { error: string } {
  const text = body.trim();
  if (text === "") return {};
  if (text.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { error: "the JSON is not an object" };
    } catch {
      return { error: "the JSON could not be parsed" };
    }
  }
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = /^\s*([A-Za-z][A-Za-z _-]{0,40}?)\s*:\s*(.*)$/.exec(line);
    if (!m) return { error: `"${line.slice(0, 60)}" is not a key: value line` };
    const key = (m[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const value = (m[2] ?? "").trim();
    if (key === "variant" || key === "variants") out.variants = [...((out.variants as string[] | undefined) ?? []), value];
    else out[key] = NUMERIC.has(key) && value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
  }
  return out;
}

function inputFrom(body: string): ExperimentInput | { error: string } {
  const fields = parseFields(body);
  if ("error" in fields && typeof fields.error === "string") return { error: fields.error };
  const parsed = experimentInputSchema.safeParse(fields);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "fields"}: ${i.message}`).join("; ") };
  return parsed.data;
}

export interface ExperimentCommandDeps {
  db: D1Database;
  /** The flag store approved proposals are written to. */
  kv: Pick<KvStore, "put"> | undefined;
  flags: FlagReader;
  /** The templates as the batch serves them now (weight overrides applied). */
  templates: () => Promise<readonly ServedTemplate[]>;
  /** The allowlisted operator who sent the command. */
  userId: string;
  now?: () => Date;
}

function recordLines(e: ExperimentRecord): string[] {
  const target = targetPerArm(e);
  return [
    `Experiment ${e.id}: ${e.name} (${e.status})`,
    `Hypothesis: ${e.hypothesis}`,
    `Population: ${e.population ?? "(missing)"}`,
    `Exclusions: ${e.exclusions ?? "(missing)"}`,
    `Primary metric: ${e.primaryMetric} over ${e.metricWindowDays ?? "(missing)"} days`,
    `Baseline rate ${e.baselineRate ?? "(missing)"}, minimum detectable effect ${e.minDetectableEffect ?? "(missing)"} (absolute)`,
    `Target ${target ?? "(missing)"} matured sends per arm; max sample ${e.maxSamplePerArm ?? "(missing)"} per arm; max duration ${e.maxDurationDays} days; minimum age ${minimumAgeDays(e.primaryMetric)} days`,
    `Stopping rule: ${e.stoppingRule ?? "(missing)"}`,
    `Control: ${e.controlTemplateId ?? "(missing)"}; treatment: ${e.treatmentTemplateId ?? "(missing)"}`,
    ...(e.startedAt ? [`Started ${e.startedAt.slice(0, 16).replace("T", " ")} UTC by ${e.approver ?? "unknown"}`] : []),
    ...(e.conclusionNotes ? [`Notes: ${e.conclusionNotes}`] : []),
  ];
}

function numbered(t: ServedTemplate): string[] {
  return [`Subject: ${t.subject}`, ...t.body.split("\n").map((line, i) => `${String(i + 1).padStart(2, " ")}  ${line}`)];
}

/** What stands between a draft and starting it, or the two templates when nothing does. */
async function startChecks(deps: ExperimentCommandDeps, e: ExperimentRecord, now: Date): Promise<{ problems: string[]; control?: ServedTemplate; treatment?: ServedTemplate }> {
  const problems: string[] = [];
  if (e.status !== "draft") problems.push(`it is ${e.status}, not a draft`);
  const missing = missingForStart(e);
  if (missing.length > 0) problems.push(`its pre-registration is missing: ${missing.join(", ")}`);
  let active: ServedTemplate[] = [];
  try {
    active = batchTemplates([...(await deps.templates())]);
  } catch {
    problems.push("the templates could not be read");
  }
  const control = active.find((t) => t.id === e.controlTemplateId);
  const treatment = active.find((t) => t.id === e.treatmentTemplateId);
  if (e.controlTemplateId && !control) problems.push(`control template ${e.controlTemplateId} is not an active cold first touch with weight above 0`);
  if (e.treatmentTemplateId && !treatment) problems.push(`treatment template ${e.treatmentTemplateId} is not an active cold first touch with weight above 0`);
  let health;
  try {
    health = await measurementHealth(deps.db, now);
  } catch {
    health = unreadableHealth();
  }
  const blocked = isProductMetric(e.primaryMetric) ? health.blocksProductConclusions : health.blocksReplyConclusions;
  if (blocked) problems.push(`measurement health blocks it (${health.reasons.join("; ") || "unreadable"})`);
  const running = await listExperiments(deps.db, ["running"], MAX_RUNNING + 1);
  if (running.length >= MAX_RUNNING) problems.push(`${running.length} experiments are already running (at most ${MAX_RUNNING})`);
  // A running subject test would change the copy the experiment is judged on.
  const subject = await deps.db
    .prepare("SELECT id, template_id FROM subject_tests WHERE status = 'running' AND template_id IN (?1, ?2) LIMIT 1")
    .bind(e.controlTemplateId ?? "", e.treatmentTemplateId ?? "")
    .first<{ id: string; template_id: string }>();
  if (subject) problems.push(`subject test ${subject.id} is running on ${subject.template_id}; stop it first`);
  return { problems, ...(control ? { control } : {}), ...(treatment ? { treatment } : {}) };
}

/** Run an experiment command and return the reply text. Throws on a database error; the caller reports it. */
export async function runExperimentCommand(deps: ExperimentCommandDeps, command: ExperimentCommand): Promise<string> {
  const now = deps.now?.() ?? new Date();
  switch (command.kind) {
    case "create": {
      const input = inputFrom(command.body);
      if ("error" in input) return `Not created: ${input.error}.`;
      if (!input.name || !input.hypothesis) return "Not created: an experiment needs at least a name and a hypothesis.";
      const e = await createExperiment(deps.db, input, now);
      const missing = missingForStart(e);
      return [...recordLines(e), "", missing.length ? `Before it can start it needs: ${missing.join(", ")}. Add them with experiment-update ${e.id} <fields>.` : `Ready to review: experiment-start ${e.id}`].join("\n");
    }
    case "update": {
      const input = inputFrom(command.body);
      if ("error" in input) return `Not changed: ${input.error}.`;
      const e = await amendExperiment(deps.db, command.id, input);
      if (!e) return `Experiment ${command.id} is not a draft (or does not exist), so it cannot be changed. Its pre-registration is locked once it starts.`;
      const missing = missingForStart(e);
      return [...recordLines(e), "", missing.length ? `Still needed: ${missing.join(", ")}.` : `Ready to review: experiment-start ${e.id}`].join("\n");
    }
    case "show": {
      const e = await loadExperiment(deps.db, command.id);
      return e ? recordLines(e).join("\n") : `No experiment ${command.id}.`;
    }
    case "start":
    case "confirm_start": {
      const e = await loadExperiment(deps.db, command.id);
      if (!e) return `No experiment ${command.id}.`;
      const checks = await startChecks(deps, e, now);
      if (checks.problems.length > 0 || !checks.control || !checks.treatment) return `Experiment ${e.id} cannot start: ${checks.problems.join("; ") || "a template is missing"}. Nothing changed.`;
      const code = await startFingerprint(e, checks.control.sha256, checks.treatment.sha256);
      if (command.kind === "start") {
        const target = targetPerArm(e) ?? 0;
        const enrolling = await readSwitch(deps.flags, EXPERIMENT_FLAGS.enabled);
        return [
          ...recordLines(e),
          "",
          `Control ${checks.control.id}:`,
          ...numbered(checks.control),
          "",
          `Treatment ${checks.treatment.id}:`,
          ...numbered(checks.treatment),
          "",
          ...(target < GATE_MIN_PER_ARM ? [`Note: the target is ${target} per arm, under the ${GATE_MIN_PER_ARM} needed for keep or discard, so it can only conclude inconclusive.`] : []),
          ...(enrolling ? [] : [`Note: ${EXPERIMENT_FLAGS.enabled} is off, so nobody enrolls until you turn it on.`]),
          `To start it exactly as shown, send: experiment-start-${e.id}-${code}`,
          "It starts only if the record and both templates are unchanged then.",
        ].join("\n");
      }
      if (command.code !== code) return `Experiment ${e.id} or one of its templates changed since that code was given, so it did not start. Send experiment-start ${e.id} to review it again.`;
      if (!(await markStarted(deps.db, e, `operator:${deps.userId}`, now, { controlSha: checks.control.sha256, treatmentSha: checks.treatment.sha256 }))) {
        return `Experiment ${e.id} did not start: it was amended since, is no longer a draft, or ${MAX_RUNNING} experiments are running. Send experiment-start ${e.id} to review it again.`;
      }
      return `Experiment ${e.id} is running. Its pre-registration is locked. It is evaluated twice a day and concludes only by its rules; a keep becomes a proposal you approve.`;
    }
    case "stop":
      return (await markStopped(deps.db, command.id, `stopped by operator:${deps.userId}`, now))
        ? `Experiment ${command.id} is stopped. Nothing was promoted; accounts keep their recorded arms for the ledger.`
        : `Experiment ${command.id} is not a draft or running experiment.`;
    case "list": {
      const all = await listExperiments(deps.db, ["draft", "running", "concluded", "promoted"], 20);
      if (all.length === 0) return "No experiments yet. Create one with experiment-create.";
      return ["Experiments:", ...all.map((e) => `- ${e.id} ${e.name}: ${e.status}${e.conclusionNotes ? ` (${e.conclusionNotes.slice(0, 80)})` : ""}`)].join("\n");
    }
    case "proposals": {
      const pending = await pendingProposals(deps.db);
      if (pending.length === 0) return "No pending proposals.";
      const track = await trackRecord(deps.db, ["template_weight", "holdout_rate", "signal_source", "send_time_experiment", "copy_change"]).catch(() => null);
      return pending.map((p) => proposalText(p, track)).join("\n\n");
    }
    case "approve":
      return (await approveProposal({ db: deps.db, kv: deps.kv, flags: deps.flags, templates: deps.templates, userId: `operator:${deps.userId}`, now }, command.id)).text;
    case "reject":
      return (await rejectProposal(deps.db, command.id, `operator:${deps.userId}`, now)).text;
    case "subject_create": {
      const fields = parseFields(command.body);
      if ("error" in fields && typeof fields.error === "string") return `Not created: ${fields.error}.`;
      const parsed = subjectTestInputSchema.safeParse(fields);
      if (!parsed.success) return `Not created: ${parsed.error.issues.map((i) => `${i.path.join(".") || "fields"}: ${i.message}`).join("; ")}.`;
      const served = batchTemplates([...(await deps.templates())]);
      if (!served.some((t) => t.id === parsed.data.template)) return `Not created: ${parsed.data.template} is not an active cold first touch.`;
      const test = await createSubjectTest(deps.db, parsed.data, now);
      if ("error" in test) return `Not created: ${test.error}.`;
      return [`Subject test ${test.id} is running on ${test.templateId}:`, ...test.variants.map((v) => `- ${v.id}: ${v.text}`), "Variants split evenly until each has 50 matured sends. A winner is only ever proposed; you approve it."].join("\n");
    }
    case "subject_stop":
      return (await stopSubjectTest(deps.db, command.id, now)) ? `Subject test ${command.id} is stopped without a winner.` : `No running subject test ${command.id}.`;
    case "dashboard":
      return renderAbDashboard(await loadAbDashboard(deps.db, now));
    case "sample_size": {
      const n = sampleSizePerArm(Number(command.baseline), Number(command.mde));
      return n === null ? "Usage: sample-size <baseline rate> <absolute minimum detectable effect>, for example sample-size 0.04 0.02." : `${n} sends per arm detect a lift from ${command.baseline} to ${Number(command.baseline) + Number(command.mde)} (two-sided 95%, 80% power).`;
    }
  }
}
