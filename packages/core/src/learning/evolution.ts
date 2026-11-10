// GTM-agents: evolution: weekly, for the fitness dimension that is declining, generate candidate
// edits to the instruction behind it, benchmark each, and propose the best.
//
// The instructions loops may evolve are brain components (the brain is the instruction set every
// prompt reads): a declining outreach, pipeline, activation or revenue dimension maps to the
// message-pillars component and the outreach benchmark. A run:
//   1. skips while any evolution ran in the last COOLDOWN_DAYS (7);
//   2. picks the declining dimension with the steepest weighted slope over the last 14 days;
//   3. benchmarks the served component (the baseline), then asks the strategist for up to
//      CANDIDATES (3) edits; the current file, the approved writing and template learnings and the
//      numbers are its input, and past judge notes and the relevant agent memory are fenced as data
//      in the user turn, each under its byte budget (context.ts). A memory read that fails is
//      skipped and the run goes on without it;
//   4. drops any candidate that breaks the mutation constraints (editProblems: at most 3 items
//      changed, no link, no dash, no figure the brain does not hold, no injection pattern) or would
//      not validate with the rest of the brain, benchmarks the rest, and keeps the best when it beats
//      the baseline by MIN_GAIN;
//   5. proposes it as a brain edit with the exact diff. Below brain_edit level 2 that is all. At
//      level 2 or above (read through the autonomy reader, never a flag) it applies the edit, which
//      re-locks the brain, benchmarks again, and rolls the edit back when the result is incomplete or
//      falls more than REGRESSION_DROP under the baseline, or when verifying fails. A rollback is an
//      incident that demotes brain_edit to level 1. An edit is marked unverified before it applies,
//      so the next run rolls back one whose run died before it was verified.
// Every model call is budget-gated; every run leaves an evolution_runs row.
import { writeIncident } from "../autonomy/incidents.ts";
import { claimEffect, hasEffect } from "../events/effects.ts";
import { sha256Hex } from "../brain/lock.ts";
import type { ComponentId } from "../brain/components.ts";
import { validateBrain } from "../brain/validate.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { DAY_MS } from "../metrics/index.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { ReviewSpend } from "../quality/reviewer.ts";
import { callModel, jsonCandidates } from "../replies/model.ts";
import { fenceUntrusted } from "../security/fence.ts";
import { autoApplyLearningProposal } from "./apply.ts";
import { applyBrainEdit, editProblems, fileMeta, itemsOf, readServedBrain, renderBrainFile, type BrainItemInput, type BrainKv } from "./brain-edit.ts";
import { REGRESSION_DROP, runBenchmark, type BenchDimension, type BenchmarkRun } from "./benchmark.ts";
import { MEMORY_NOTICE, writerContext } from "./context.ts";
import { dimensionTrends, FITNESS_WEIGHTS, fitnessTrend, type FitnessDimension } from "./fitness.ts";
import { createLearningProposal } from "./proposals.ts";

export const COOLDOWN_DAYS = 7;
export const CANDIDATES = 3;
export const MIN_GAIN = 0.02;
export const EVOLUTION_SOURCE = "evolution";

/** The instruction behind each dimension evolution can work on. */
export const EVOLUTION_TARGETS: Readonly<Partial<Record<FitnessDimension, { component: ComponentId; bench: BenchDimension }>>> = Object.freeze({
  outreach: { component: "message-pillars", bench: "outreach" },
  pipeline: { component: "message-pillars", bench: "outreach" },
  activation: { component: "message-pillars", bench: "outreach" },
  revenue: { component: "message-pillars", bench: "outreach" },
});

export interface EvolutionDeps {
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
  perDimension?: number;
}

export interface EvolutionResult {
  summary: string;
  proposal?: string;
  applied?: boolean;
  rolledBack?: boolean;
}

const CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: CANDIDATES,
      items: {
        type: "object",
        properties: {
          rationale: { type: "string" },
          items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] } },
        },
        required: ["rationale", "items"],
      },
    },
  },
  required: ["candidates"],
};

/** The candidates in a strategist answer, at most CANDIDATES. Unparseable gives none. Pure. */
export function parseCandidates(text: string): Array<{ rationale: string; items: BrainItemInput[] }> {
  for (const c of jsonCandidates(text)) {
    const list = (c as { candidates?: unknown } | null)?.candidates;
    if (!Array.isArray(list)) continue;
    const out: Array<{ rationale: string; items: BrainItemInput[] }> = [];
    for (const raw of list.slice(0, CANDIDATES)) {
      const r = raw as { rationale?: unknown; items?: unknown };
      if (typeof r.rationale !== "string" || !Array.isArray(r.items)) continue;
      const items: BrainItemInput[] = [];
      let ok = true;
      for (const it of r.items) {
        const i = it as { id?: unknown; fields?: unknown };
        if (typeof i.id !== "string" || !i.fields || typeof i.fields !== "object" || Array.isArray(i.fields)) {
          ok = false;
          break;
        }
        const fields = Object.entries(i.fields as Record<string, unknown>);
        if (!fields.every(([, v]) => typeof v === "string")) {
          ok = false;
          break;
        }
        items.push({ id: i.id, fields: Object.fromEntries(fields) as Record<string, string> });
      }
      if (ok) out.push({ rationale: r.rationale.replace(/\s+/g, " ").trim().slice(0, 300), items });
    }
    return out;
  }
  return [];
}

async function tell(deps: EvolutionDeps, text: string): Promise<void> {
  try {
    await deps.operator?.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
  } catch {
    // A notice is bookkeeping; the run's row records what happened.
  }
}

async function record(deps: EvolutionDeps, row: { artifact: string; reason: string; generated: number; winner: number | null; pre: number | null; post: number | null; delta: number | null; applied: boolean; traces: unknown }): Promise<void> {
  try {
    await deps.db
      .prepare(
        `INSERT INTO evolution_runs (id, artifact_key, trigger_reason, candidates_generated, winner_index, pre_score, post_score, fitness_delta, applied, failure_traces, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(`ev_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, row.artifact, row.reason.slice(0, 200), row.generated, row.winner, row.pre, row.post, row.delta, row.applied ? 1 : 0, JSON.stringify(row.traces ?? null), deps.now.toISOString())
      .run();
  } catch {
    deps.log?.warn("the evolution run row could not be written");
  }
}

/** One weekly evolution run. Throws on a database error before anything is applied. */
export async function runEvolution(deps: EvolutionDeps): Promise<EvolutionResult> {
  const swept = await sweepUnverified(deps);
  if (swept > 0) return { summary: `rolled back ${swept} unverified automatic edit(s)`, rolledBack: true };
  const recent = await deps.db.prepare("SELECT COUNT(*) AS n FROM evolution_runs WHERE created_at >= ?1").bind(new Date(deps.now.getTime() - COOLDOWN_DAYS * DAY_MS).toISOString()).first<{ n: number }>();
  if (Number(recent?.n ?? 0) > 0) return { summary: `cooling down: an evolution ran in the last ${COOLDOWN_DAYS} days` };
  const trends = dimensionTrends(await fitnessTrend(deps.db, deps.now, 14));
  const declining = trends
    .filter((t) => t.direction === "declining" && EVOLUTION_TARGETS[t.dimension])
    .sort((a, b) => a.slope * FITNESS_WEIGHTS[a.dimension] - b.slope * FITNESS_WEIGHTS[b.dimension]);
  const target = declining[0];
  if (!target) return { summary: "no evolvable dimension is declining" };
  const { component, bench } = EVOLUTION_TARGETS[target.dimension] as { component: ComponentId; bench: BenchDimension };
  if (!deps.kv) return { summary: "the brain's KV namespace is not bound" };
  const served = await readServedBrain(deps.kv);
  const current = served.files.get(`${component}.md`);
  if (!current) return { summary: `${component} is not served, so there is nothing to evolve` };
  const artifact = `brain:${component}`;
  const reason = `${target.dimension} declining (slope ${target.slope} per day over ${target.points} days)`;
  const bench0 = { db: deps.db, kv: deps.kv, model: deps.model, config: deps.config, spend: deps.spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), now: deps.now, ...(deps.log ? { log: deps.log } : {}) };
  const per = deps.perDimension;
  const baseline = await runBenchmark(bench0, { trigger: "evolution:baseline", dimensions: [bench], fenceBrain: true, ...(per ? { perDimension: per } : {}) });
  if (!baseline.complete || baseline.aggregate === null) {
    await record(deps, { artifact, reason, generated: 0, winner: null, pre: baseline.aggregate, post: null, delta: target.slope, applied: false, traces: { stopped: "the baseline benchmark was incomplete" } });
    return { summary: "the baseline benchmark was incomplete; nothing proposed" };
  }
  const before = itemsOf(current, component);
  const knownText = [...served.files.values()].join("\n");
  const notes = baseline.scenarios.map((s) => `${s.id}: ${s.score ?? "unscored"} ${s.note}`).join("\n");
  const read = await writerContext(deps.db, "evolution", deps.now, deps.log);
  const system = [
    `You improve one component of a B2B company's brain: ${component}. The current file is below; it is operator-approved.`,
    `The ${target.dimension} fitness dimension is declining. Propose up to ${CANDIDATES} alternative versions of the component's items.`,
    "Each version changes at most 3 items (added, removed or rewritten) and keeps every other item exactly as it is.",
    "Use only the fields the current items use. Write plain sentences: no links, no em or en dashes, no figures, customers or claims the current brain does not hold.",
    'Answer with JSON: {"candidates": [{"rationale": "<one sentence>", "items": [{"id": "<item id>", "fields": {"<field>": "<value>"}}]}]}.',
    MEMORY_NOTICE,
    "",
    current,
    "",
    read.learnings,
  ].join("\n");
  const user = [fenceUntrusted({ source: "benchmark_notes", text: `${reason}\nbaseline ${baseline.aggregate}\n${notes}` }), read.memory].filter((part) => part.length > 0).join("\n\n");
  const answer = await callModel(
    { model: deps.model, config: deps.config, spend: deps.spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), timeoutMs: 60_000, ...(deps.log ? { log: deps.log } : {}) },
    { role: "strategist", system, user, jsonSchema: CANDIDATE_SCHEMA, maxTokens: 3000 },
  );
  const candidates = answer.ok ? parseCandidates(answer.text) : [];
  const meta = fileMeta(current, component);
  const others = [...served.files.entries()].filter(([n]) => n !== `${component}.md`).map(([name, content]) => ({ name, content }));
  const traces: Array<{ index: number; problems?: string[]; score?: number | null }> = [];
  let best: { index: number; content: string; rationale: string; run: BenchmarkRun } | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const problems = editProblems({ component, before, after: candidate.items, knownText });
    const content = renderBrainFile({ component, version: meta.version + 1, updated: deps.now.toISOString().slice(0, 10), owner: meta.owner, items: candidate.items });
    if (problems.length === 0) {
      const validation = await validateBrain([...others, { name: `${component}.md`, content }]);
      if (!validation.ok) problems.push(...validation.issues.filter((i) => i.severity === "error").map((i) => i.message).slice(0, 3));
    }
    if (problems.length > 0) {
      traces.push({ index, problems });
      continue;
    }
    const run = await runBenchmark(bench0, { trigger: "evolution:candidate", dimensions: [bench], override: { component, content }, fenceBrain: true, ...(per ? { perDimension: per } : {}) });
    traces.push({ index, score: run.aggregate });
    if (run.complete && run.aggregate !== null && (!best || run.aggregate > (best.run.aggregate ?? 0))) best = { index, content, rationale: candidate.rationale, run };
  }
  if (!best || (best.run.aggregate ?? 0) < baseline.aggregate + MIN_GAIN) {
    await record(deps, { artifact, reason, generated: candidates.length, winner: null, pre: baseline.aggregate, post: best?.run.aggregate ?? null, delta: target.slope, applied: false, traces: { candidates: traces, model: answer.ok ? "ok" : answer.reason } });
    return { summary: `${candidates.length} candidates; none beat the baseline ${baseline.aggregate} by ${MIN_GAIN}` };
  }
  const created = await createLearningProposal(
    deps.db,
    {
      kind: "brain",
      payload: { component, baseSha256: await sha256Hex(current), content: best.content, previousContent: current },
      rationale: `${reason}. Benchmark ${baseline.aggregate} to ${best.run.aggregate}. ${best.rationale}`,
      proposedBy: EVOLUTION_SOURCE,
      sourceRunId: deps.runId ?? null,
    },
    deps.now,
  );
  if (!created.ok) {
    await record(deps, { artifact, reason, generated: candidates.length, winner: best.index, pre: baseline.aggregate, post: best.run.aggregate, delta: target.slope, applied: false, traces: { candidates: traces, refused: created.problems } });
    return { summary: `the best candidate could not be proposed: ${created.problems.join("; ")}` };
  }
  const shortId = created.proposal.shortId;
  // Mark the edit unverified before it can be applied, so a run that dies after applying is rolled
  // back by the next one.
  await claimEffect(deps.db, shortId, UNVERIFIED_EFFECT);
  const auto = await autoApplyLearningProposal({ db: deps.db, kv: deps.kv, flags: deps.flags, config: deps.config, now: deps.now }, shortId);
  if (auto.status !== "applied") {
    await record(deps, { artifact, reason, generated: candidates.length, winner: best.index, pre: baseline.aggregate, post: best.run.aggregate, delta: target.slope, applied: false, traces: { candidates: traces, proposal: shortId } });
    await tell(deps, `Evolution proposes an edit to ${component} (${reason}); the benchmark went from ${baseline.aggregate} to ${best.run.aggregate}. Review it with learning-show ${shortId}.`);
    return { summary: `proposed ${shortId}`, proposal: shortId, applied: false };
  }
  // Applied at an earned level: verify on the served brain, and roll back unless it holds up. Any
  // failure while verifying counts as a regression.
  let post: BenchmarkRun | null;
  try {
    post = await runBenchmark(bench0, { trigger: "evolution:post_apply", dimensions: [bench], fenceBrain: true, ...(per ? { perDimension: per } : {}) });
  } catch {
    post = null;
  }
  const regressed = !post || !post.complete || post.aggregate === null || post.aggregate < baseline.aggregate - REGRESSION_DROP;
  if (regressed) {
    const restored = await rollBack(deps, { shortId, component, applied: best.content, previous: current, why: `the benchmark after it scored ${post?.aggregate ?? "incomplete"} against ${baseline.aggregate}` });
    await record(deps, { artifact, reason, generated: candidates.length, winner: best.index, pre: baseline.aggregate, post: post?.aggregate ?? null, delta: target.slope, applied: !restored, traces: { candidates: traces, proposal: shortId, rolledBack: restored } });
    return { summary: restored ? `applied ${shortId} and rolled it back` : `applied ${shortId}; roll back failed`, proposal: shortId, applied: !restored, rolledBack: restored };
  }
  await claimEffect(deps.db, shortId, VERIFIED_EFFECT);
  await record(deps, { artifact, reason, generated: candidates.length, winner: best.index, pre: baseline.aggregate, post: post?.aggregate ?? null, delta: target.slope, applied: true, traces: { candidates: traces, proposal: shortId } });
  await tell(deps, `Evolution applied an edit to ${component} at brain_edit level ${auto.level} (${reason}); the benchmark went from ${baseline.aggregate} to ${post?.aggregate ?? "?"}. See it with learning-show ${shortId}.`);
  return { summary: `applied ${shortId}`, proposal: shortId, applied: true };
}

const UNVERIFIED_EFFECT = "learning_evolution_unverified";
const VERIFIED_EFFECT = "learning_evolution_verified";

/**
 * Restore the component an automatic edit replaced. Either way the harm is an incident for
 * brain_edit, which demotes it to level 1, so nothing more applies on its own until a person raises it
 * again. On success the proposal is marked rolled back; on failure it stays applied with the reason,
 * so the record matches what is served, and you are told to restore it by hand. Never throws.
 */
async function rollBack(deps: EvolutionDeps, edit: { shortId: string; component: ComponentId; applied: string; previous: string; why: string }): Promise<boolean> {
  let restored = false;
  let failure = "";
  try {
    const r = await applyBrainEdit({ db: deps.db, kv: deps.kv, now: deps.now }, { component: edit.component, baseSha256: await sha256Hex(edit.applied), content: edit.previous });
    restored = r.ok;
    if (!r.ok) failure = r.reason;
  } catch {
    failure = "the brain could not be written";
  }
  try {
    await deps.db
      .prepare("UPDATE learnings_proposals SET status = ?2, status_reason = ?3, updated_at = ?4 WHERE short_id = ?1")
      .bind(edit.shortId, restored ? "expired" : "applied", restored ? `rolled back: ${edit.why}`.slice(0, 300) : `applied; roll back failed: ${failure}`.slice(0, 300), deps.now.toISOString())
      .run();
    if (restored) await claimEffect(deps.db, edit.shortId, VERIFIED_EFFECT);
  } catch {
    deps.log?.warn("the rolled back proposal could not be updated");
  }
  await writeIncident(deps.db, { actionClass: "brain_edit", onceKey: `evolution:${edit.shortId}`, subjectId: edit.shortId, detail: `an automatic brain edit regressed (${edit.why}); ${restored ? "rolled back" : "roll back failed"}`, at: deps.now, now: deps.now });
  await tell(
    deps,
    restored
      ? `Evolution applied an edit to ${edit.component} on its own, but ${edit.why}, so it was rolled back and brain_edit is back at level 1.`
      : `Evolution applied an edit to ${edit.component} on its own and ${edit.why}, but rolling it back failed (${failure}). Restore ${edit.component} by hand; brain_edit is back at level 1.`,
  );
  return restored;
}

/** Roll back any automatic edit a previous run applied but never verified. Never throws. */
async function sweepUnverified(deps: EvolutionDeps): Promise<number> {
  let n = 0;
  try {
    const { results } = await deps.db
      .prepare("SELECT short_id, payload FROM learnings_proposals WHERE proposed_by = ?1 AND kind = 'brain' AND status = 'applied' AND created_at >= ?2")
      .bind(EVOLUTION_SOURCE, new Date(deps.now.getTime() - 30 * DAY_MS).toISOString())
      .all<{ short_id: string; payload: string }>();
    for (const row of results) {
      if (!(await hasEffect(deps.db, row.short_id, UNVERIFIED_EFFECT)) || (await hasEffect(deps.db, row.short_id, VERIFIED_EFFECT))) continue;
      const p = JSON.parse(row.payload) as { component: ComponentId; content: string; previousContent: string | null };
      if (!p.previousContent) continue;
      if (await rollBack(deps, { shortId: row.short_id, component: p.component, applied: p.content, previous: p.previousContent, why: "it was never verified by a benchmark" })) n++;
    }
  } catch {
    deps.log?.warn("unverified evolution edits could not be checked");
  }
  return n;
}
