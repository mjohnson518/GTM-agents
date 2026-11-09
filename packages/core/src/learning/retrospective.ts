// GTM-agents: the daily retrospective: the strategist reads yesterday's numbers and picks exactly one
// improvement.
//
// Guardrails:
//   - one change, structurally: the answer schema holds a single choice, and the run is claimed
//     once per UTC day in the effects ledger, so a rerun never makes a second;
//   - the choices are bounded: a learnings snippet (proposed), a memory note (stored, bookkeeping),
//     a template candidate (proposed for the copy-change gate; it ships only as an experiment), an
//     inactive discovery query, or one persona playbook field. Every text meets the mutation
//     constraints (no link, no dash, nothing the content lint blocks, no injection pattern);
//   - only a discovery query or a playbook field no writer reads may apply without a person, and
//     only at retrospective_actuation level 2 or above (apply.ts reads the level); everything else is
//     a proposal a person approves;
//   - the model's input is numbers, ids and operator-approved text; the data block is fenced anyway;
//   - the call is budget-gated through the spend gate, role strategist.
import type { GtmConfig } from "../config/schema.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { firstTouchOutcomes, firstTouchOutcomesBy, maturedBefore, metricWindow, DAY_MS, UNKNOWN_SLICE } from "../metrics/index.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { ReviewSpend } from "../quality/reviewer.ts";
import { callModel, jsonCandidates } from "../replies/model.ts";
import { fenceUntrusted } from "../security/fence.ts";
import { autoApplyLearningProposal } from "./apply.ts";
import { itemsOf, readServedBrain, type BrainKv } from "./brain-edit.ts";
import { dimensionTrends, fitnessTrend } from "./fitness.ts";
import { isLearningSection, learningsText } from "./learnings.ts";
import { storeMemory } from "./memory.ts";
import { createLearningProposal, PLAYBOOK_FIELDS, type NewProposal, type PlaybookField } from "./proposals.ts";
import { snippetProblems } from "./text.ts";

export const RETROSPECTIVE_SOURCE = "retrospective";
export const RETROSPECTIVE_EFFECT = "learning_retrospective";
export const RETROSPECTIVE_CHOICES = ["learning", "memory", "template_change", "discovery_query", "playbook_field", "none"] as const;
export type RetrospectiveChoice = (typeof RETROSPECTIVE_CHOICES)[number];

const SCHEMA = {
  type: "object",
  properties: {
    choice: { type: "string", enum: [...RETROSPECTIVE_CHOICES] },
    rationale: { type: "string" },
    section: { type: "string" },
    text: { type: "string" },
    template: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    hypothesis: { type: "string" },
    query: { type: "string" },
    source: { type: "string" },
    persona: { type: "string" },
    field: { type: "string" },
    value: { type: "string" },
  },
  required: ["choice", "rationale"],
};

export interface RetrospectiveAnswer {
  choice: RetrospectiveChoice;
  rationale: string;
  fields: Record<string, string>;
}

/** The single choice in a strategist answer, or null when it cannot be parsed. Pure. */
export function parseRetrospective(text: string): RetrospectiveAnswer | null {
  for (const c of jsonCandidates(text)) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.choice !== "string" || !(RETROSPECTIVE_CHOICES as readonly string[]).includes(o.choice) || typeof o.rationale !== "string") continue;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (k !== "choice" && k !== "rationale" && typeof v === "string") fields[k] = v.trim();
    return { choice: o.choice as RetrospectiveChoice, rationale: o.rationale.replace(/\s+/g, " ").trim().slice(0, 300), fields };
  }
  return null;
}

export interface RetrospectiveDeps {
  db: D1Database;
  kv: BrainKv | undefined;
  flags: FlagReader;
  model: ModelGateway | undefined;
  config: Pick<GtmConfig, "models" | "autonomy">;
  spend: ReviewSpend;
  operator?: OperatorChannel;
  chatId?: string;
  job: string;
  runId?: string;
  now: Date;
  log?: JobLogger;
}

export interface RetrospectiveResult {
  summary: string;
  choice?: RetrospectiveChoice;
  proposal?: string;
  applied?: boolean;
}

async function context(deps: RetrospectiveDeps): Promise<{ data: string; templates: string[]; personas: string[] }> {
  const matured = new Date(maturedBefore(deps.now));
  const window = metricWindow(new Date(matured.getTime() - 30 * DAY_MS), matured);
  const lines: string[] = [];
  const [totals, byTemplate, trend, pending, queries] = await Promise.all([
    firstTouchOutcomes(deps.db, window).catch(() => null),
    firstTouchOutcomesBy(deps.db, window, "template").catch(() => []),
    fitnessTrend(deps.db, deps.now, 14).catch(() => []),
    deps.db.prepare("SELECT kind, COUNT(*) AS n FROM learnings_proposals WHERE status = 'pending' GROUP BY kind").all<{ kind: string; n: number }>().then((r) => r.results).catch(() => []),
    deps.db
      .prepare("SELECT source, substr(query, 1, 80) AS query, total_results, total_promoted, is_active FROM discovery_queries ORDER BY total_promoted DESC, created_at DESC LIMIT 5")
      .all<{ source: string; query: string; total_results: number; total_promoted: number; is_active: number }>()
      .then((r) => r.results)
      .catch(() => []),
  ]);
  if (totals) lines.push(`Matured first touches (30 days): ${totals.sends} sent, ${totals.humanReplies} human replies, ${totals.positiveReplies} positive, ${totals.bounced} bounced.`);
  const templates = byTemplate.filter((t) => t.key !== UNKNOWN_SLICE).map((t) => t.key);
  for (const t of byTemplate.slice(0, 10)) lines.push(`Template ${t.key}: ${t.sends} sent, ${t.positiveReplies} positive.`);
  for (const d of dimensionTrends(trend)) lines.push(`Fitness ${d.dimension}: ${d.direction}${d.direction === "insufficient" ? "" : ` (slope ${d.slope} per day)`}.`);
  for (const p of pending) lines.push(`Pending proposals of kind ${p.kind}: ${p.n}.`);
  for (const q of queries) lines.push(`Discovery query (${q.source}, ${q.is_active ? "active" : "inactive"}): ${q.query} [${q.total_results} results, ${q.total_promoted} promoted]`);
  let personas: string[];
  try {
    const served = deps.kv ? await readServedBrain(deps.kv) : null;
    const file = served?.files.get("personas.md");
    personas = file ? itemsOf(file, "personas").map((i) => i.id) : [];
  } catch {
    personas = [];
  }
  if (personas.length) {
    const { results } = await deps.db
      .prepare("SELECT persona, tone, opener, value_frame, cta FROM persona_playbooks LIMIT 50")
      .all<Record<string, string | null>>()
      .catch(() => ({ results: [] as Array<Record<string, string | null>> }));
    for (const persona of personas) {
      const row = results.find((r) => r.persona === persona);
      lines.push(`Persona ${persona} playbook: ${PLAYBOOK_FIELDS.map((f) => `${f}=${row?.[f] ? "set" : "unset"}`).join(", ")}.`);
    }
  }
  return { data: lines.join("\n") || "No data yet.", templates, personas };
}

async function tell(deps: RetrospectiveDeps, text: string): Promise<void> {
  try {
    await deps.operator?.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
  } catch {
    // Bookkeeping; the proposal is listed by learning-list.
  }
}

/** Turn the choice into one proposal input, or say why it cannot be. Pure apart from the playbook read. */
async function toProposal(deps: RetrospectiveDeps, answer: RetrospectiveAnswer, templates: readonly string[], personas: readonly string[]): Promise<NewProposal | string> {
  const f = answer.fields;
  const base = { rationale: answer.rationale, proposedBy: RETROSPECTIVE_SOURCE, sourceRunId: deps.runId ?? null };
  switch (answer.choice) {
    case "learning":
      if (!isLearningSection(f.section)) return `unknown learnings section ${f.section ?? "(none)"}`;
      return { ...base, kind: "learning", payload: { section: f.section, text: f.text ?? "" } };
    case "template_change":
      if (!f.template || !templates.includes(f.template)) return `template ${f.template ?? "(none)"} has no sends to compare against`;
      return { ...base, kind: "template", payload: { template: f.template, subject: f.subject ?? "", body: f.body ?? "", hypothesis: f.hypothesis ?? "" } };
    case "discovery_query":
      return { ...base, kind: "discovery_query", payload: { query: f.query ?? "", source: f.source ?? "" } };
    case "playbook_field": {
      if (!f.persona || !personas.includes(f.persona)) return `persona ${f.persona ?? "(none)"} is not in the brain`;
      if (!(PLAYBOOK_FIELDS as readonly string[]).includes(f.field ?? "")) return `field ${f.field ?? "(none)"} is not a playbook field`;
      const field = f.field as PlaybookField;
      const row = await deps.db.prepare(`SELECT ${field} AS value FROM persona_playbooks WHERE persona = ?1`).bind(f.persona).first<{ value: string | null }>();
      return { ...base, kind: "playbook_field", payload: { persona: f.persona, field, value: f.value ?? "", previous: row?.value ?? null } };
    }
    default:
      return "not a proposal";
  }
}

/** One daily retrospective. Throws on a database error. */
export async function runRetrospective(deps: RetrospectiveDeps): Promise<RetrospectiveResult> {
  const day = deps.now.toISOString().slice(0, 10);
  if (!(await claimEffect(deps.db, day, RETROSPECTIVE_EFFECT))) return { summary: `the retrospective for ${day} already ran` };
  const { data, templates, personas } = await context(deps);
  const system = [
    "You run the daily retrospective of a B2B outreach system. Pick exactly one improvement, or none.",
    "Choices:",
    "- learning: a snippet for one section of the learnings document (sections: writing_rules, objection_handling, template_performance, process, general); fields section, text.",
    "- memory: a short note for the agent's long-term memory; field text.",
    "- template_change: a candidate to test against one template that has sends; fields template, subject, body, hypothesis. It ships only through an experiment.",
    "- discovery_query: a new discovery query, added inactive; fields query, source.",
    "- playbook_field: one field (tone, opener, value_frame, cta) of one persona's playbook; fields persona, field, value.",
    "- none: nothing is worth changing today.",
    "Base the choice on the numbers. Write plain sentences: under 400 characters, no links, no em or en dashes, no figures you were not given, no names of people.",
    'Answer with JSON: {"choice": "...", "rationale": "<one sentence>", ...the fields of that choice}.',
    "",
    await learningsText(deps.db),
  ].join("\n");
  const answer = await callModel(
    { model: deps.model, config: deps.config, spend: deps.spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), timeoutMs: 60_000, ...(deps.log ? { log: deps.log } : {}) },
    { role: "strategist", system, user: fenceUntrusted({ source: "retrospective_numbers", text: data }), jsonSchema: SCHEMA, maxTokens: 1200 },
  );
  if (!answer.ok) {
    if (!answer.called) await releaseEffect(deps.db, day, RETROSPECTIVE_EFFECT);
    return { summary: `no retrospective: ${answer.reason}` };
  }
  const parsed = parseRetrospective(answer.text);
  if (!parsed) return { summary: "the strategist's answer could not be parsed; nothing was changed" };
  if (parsed.choice === "none") return { summary: "the retrospective found nothing to change", choice: "none" };
  if (parsed.choice === "memory") {
    const problems = snippetProblems(parsed.fields.text ?? "");
    if (problems.length) return { summary: `the memory note was dropped: ${problems.join("; ")}`, choice: "memory" };
    const id = await storeMemory(deps.db, { kind: "strategy_learning", text: parsed.fields.text ?? "", importance: 0.4, source: RETROSPECTIVE_SOURCE, ...(deps.runId ? { runId: deps.runId } : {}), now: deps.now });
    return { summary: id ? "stored one memory note" : "the memory note could not be stored", choice: "memory" };
  }
  const input = await toProposal(deps, parsed, templates, personas);
  if (typeof input === "string") return { summary: `the retrospective's ${parsed.choice} was dropped: ${input}`, choice: parsed.choice };
  const created = await createLearningProposal(deps.db, input, deps.now);
  if (!created.ok) return { summary: `the retrospective's ${parsed.choice} was dropped: ${created.problems.join("; ")}`, choice: parsed.choice };
  const shortId = created.proposal.shortId;
  const auto = await autoApplyLearningProposal({ db: deps.db, kv: deps.kv, flags: deps.flags, config: deps.config, now: deps.now }, shortId);
  if (auto.status === "applied") {
    await tell(deps, `The retrospective applied ${shortId} at retrospective_actuation level ${auto.level}: ${auto.message} See it with learning-show ${shortId}.`);
    return { summary: `applied ${shortId}`, choice: parsed.choice, proposal: shortId, applied: true };
  }
  await tell(deps, `The retrospective proposes one change (${parsed.choice}): ${parsed.rationale} Review it with learning-show ${shortId}.`);
  return { summary: `proposed ${shortId}`, choice: parsed.choice, proposal: shortId, applied: false };
}
