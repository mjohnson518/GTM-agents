// GTM-agents: one run of the spec writer (the ship_specs job, planning.ts).
//
// In order:
//   1. the open themes of the repository at or above the score threshold, highest first, that have
//      had fewer than MAX_SPEC_ATTEMPTS unusable answers, at most maxSpecs a run. The engineering
//      contract is read once; without it no spec is written this run;
//   2. for each, one strategist call (spec.ts); a call that cannot be made or fails stops the run
//      without counting against the theme. A usable spec is stored with its digest: the theme
//      becomes spec_ready, or declined when the spec declines it automatically. The operator is
//      told about each (bookkeeping: a lost notice changes nothing; ship-themes lists them);
//   3. while ship_spec is at level 2 or above, the highest-scoring low-risk specs waiting for review
//      are approved automatically, at most MAX_AUTO_APPROVALS_PER_RUN a run (approval.ts). Medium
//      risk waits for a person.
import type { Env } from "@gtm-agents/core";
import { readAutonomyLevel } from "@gtm-agents/core/autonomy/runtime";
import type { GtmConfig } from "@gtm-agents/core/config";
import type { FlagReader, JobLogger } from "@gtm-agents/core/jobs";
import type { ModelGateway, OperatorChannel } from "@gtm-agents/core/ports";
import { sanitizeErrorMessage } from "@gtm-agents/core/security";
import type { SpendGate } from "@gtm-agents/core/sourcing";
import { MAX_AUTO_APPROVALS_PER_RUN, approveSpec } from "./approval.ts";
import type { StartShipBuild } from "./contract.ts";
import { complete } from "./model-call.ts";
import { oneLine } from "./planning-shared.ts";
import {
  MAX_SPEC_ATTEMPTS,
  MAX_SUMMARIES,
  SPEC_SCHEMA,
  SPEC_TIMEOUT_MS,
  declineReason,
  impliedRisk,
  parseSpec,
  specDigest,
  specSystem,
  specUserTurn,
  storedSpec,
  unusableSpec,
} from "./spec.ts";

export interface SpecJobDeps<E extends Env> {
  env: E;
  db: D1Database;
  flags: FlagReader;
  config: Pick<GtmConfig, "models" | "autonomy">;
  model: ModelGateway | undefined;
  spend: Pick<SpendGate, "allow" | "record" | "recordModel">;
  operator: OperatorChannel | undefined;
  chatId: string | undefined;
  readEngineeringContract: (env: E) => Promise<string | null>;
  startBuild: StartShipBuild<E>;
  repo: string;
  baseBranch: string;
  deniedPaths: readonly string[];
  threshold: number;
  maxSpecs: number;
  maxAutoApprovals: number;
  job: string;
  runId?: string;
  now: Date;
  log: JobLogger;
  signal?: AbortSignal;
}

export interface SpecJobResult {
  candidates: number;
  ready: number;
  declined: number;
  unusable: number;
  autoApproved: number;
  failed: number;
  stopped: string[];
}

interface CandidateRow {
  id: string;
  category: string;
  affected_area: string | null;
  demand_count: number;
  paying_requesters: number;
  requester_mrr_cents: number;
  priority_score: number;
  max_priority: string | null;
  spec_attempts: number;
}

async function tell(deps: { operator: OperatorChannel | undefined; chatId: string | undefined; log: JobLogger }, text: string): Promise<void> {
  try {
    await deps.operator?.notify({ text, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
  } catch (error) {
    deps.log.warn("a ship notice could not be delivered", { error: sanitizeErrorMessage(error) });
  }
}

async function readContract<E extends Env>(deps: SpecJobDeps<E>): Promise<string | null> {
  try {
    const text = await deps.readEngineeringContract(deps.env);
    return typeof text === "string" && text.trim() !== "" ? text : null;
  } catch (error) {
    deps.log.warn("the engineering contract could not be read", { error: sanitizeErrorMessage(error) });
    return null;
  }
}

async function countAttempt(db: D1Database, id: string, at: string): Promise<void> {
  await db.prepare("UPDATE themes SET spec_attempts = spec_attempts + 1, updated_at = ?2 WHERE id = ?1 AND status = 'open'").bind(id, at).run();
}

async function writeOne<E extends Env>(deps: SpecJobDeps<E>, theme: CandidateRow, contract: string, result: SpecJobResult): Promise<"stop" | void> {
  const { db, now } = deps;
  const at = now.toISOString();
  const { results: items } = await db
    .prepare("SELECT triage_summary, text FROM feedback_items WHERE theme_id = ?1 AND status IN ('themed', 'shipped') AND triage_summary IS NOT NULL ORDER BY created_at DESC LIMIT ?2")
    .bind(theme.id, MAX_SUMMARIES * 2)
    .all<{ triage_summary: string; text: string }>();
  const summaries = [...new Set(items.map((i) => i.triage_summary))].slice(0, MAX_SUMMARIES);
  if (summaries.length === 0) return;
  const answer = await complete(
    { model: deps.model, config: deps.config, spend: deps.spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), log: deps.log },
    {
      role: "strategist",
      system: specSystem(deps.deniedPaths),
      user: specUserTurn({
        themeId: theme.id,
        category: theme.category,
        affectedArea: theme.affected_area,
        demand: Number(theme.demand_count),
        payingRequesters: Number(theme.paying_requesters),
        requesterMrrCents: Number(theme.requester_mrr_cents),
        score: Number(theme.priority_score),
        maxPriority: theme.max_priority,
        summaries,
        contract,
      }),
      jsonSchema: SPEC_SCHEMA,
      maxTokens: 3_000,
      timeoutMs: SPEC_TIMEOUT_MS,
      metadata: { theme_id: theme.id },
    },
  );
  if (!answer.ok) {
    // A refusal before the call, or a call that failed: nothing is counted against the theme, and
    // the run stops rather than wait out the next time-out.
    if (answer.called) result.failed += 1;
    result.stopped.push(answer.reason);
    return "stop";
  }
  const spec = parseSpec(answer.text);
  // The raw text is read only for this check, and never sent anywhere.
  const unusable = spec ? unusableSpec(spec, items.map((i) => i.text)) : "the answer is not a spec";
  if (!spec || unusable) {
    await countAttempt(db, theme.id, at);
    result.unusable += 1;
    deps.log.warn("a spec could not be used", { themeId: theme.id, why: unusable ?? "unknown" });
    return;
  }
  const risked = { ...spec, risk: impliedRisk(spec) };
  const digest = await specDigest(theme.id, risked);
  const decline = declineReason(risked, deps.deniedPaths);
  const changed = await db
    .prepare(
      `UPDATE themes SET status = ?2, title = ?3, spec = ?4, spec_digest = ?5, spec_risk = ?6, spec_generated_at = ?7, adoption_event = ?8, declined_reason = ?9, updated_at = ?7
        WHERE id = ?1 AND status = 'open'`,
    )
    .bind(theme.id, decline ? "declined" : "spec_ready", risked.title, storedSpec(risked), digest, risked.risk, at, risked.adoptionEvent, decline)
    .run();
  if ((changed.meta.changes ?? 0) === 0) return;
  if (decline) {
    result.declined += 1;
    await tell(deps, `Ship theme ${theme.id} was declined automatically: ${decline}. Its spec: ${oneLine(risked.title, 100)}. See it with ship-spec-${theme.id}.`);
    return;
  }
  result.ready += 1;
  await tell(
    deps,
    `A ship spec is ready for review: ${oneLine(risked.title, 100)} [theme ${theme.id}, risk ${risked.risk}, score ${theme.priority_score}]. Read it with ship-spec-${theme.id}, which shows the command that approves exactly that spec.`,
  );
}

/** One spec run. Throws only when the candidates cannot be read. */
export async function runShipSpecs<E extends Env>(deps: SpecJobDeps<E>): Promise<SpecJobResult> {
  const { db } = deps;
  const result: SpecJobResult = { candidates: 0, ready: 0, declined: 0, unusable: 0, autoApproved: 0, failed: 0, stopped: [] };
  const { results: candidates } = await db
    .prepare(
      `SELECT id, category, affected_area, demand_count, paying_requesters, requester_mrr_cents, priority_score, max_priority, spec_attempts
         FROM themes WHERE repo = ?1 AND status = 'open' AND priority_score >= ?2 AND spec_attempts < ?3
        ORDER BY priority_score DESC, created_at ASC LIMIT ?4`,
    )
    .bind(deps.repo, deps.threshold, MAX_SPEC_ATTEMPTS, deps.maxSpecs)
    .all<CandidateRow>();
  result.candidates = candidates.length;
  if (candidates.length > 0) {
    const contract = await readContract(deps);
    if (!contract) result.stopped.push("no engineering contract could be read, so no spec was written");
    else {
      for (const theme of candidates) {
        if (deps.signal?.aborted) {
          result.stopped.push("the run's time ran out");
          break;
        }
        try {
          if ((await writeOne(deps, theme, contract, result)) === "stop") break;
        } catch (error) {
          result.failed += 1;
          deps.log.warn("a spec could not be written; the next run tries again", { themeId: theme.id, error: sanitizeErrorMessage(error) });
        }
      }
    }
  }

  // Automatic approval, at an earned level only, low risk only, a bounded number a run.
  const limit = Math.max(0, Math.min(MAX_AUTO_APPROVALS_PER_RUN, Math.floor(deps.maxAutoApprovals)));
  if (limit === 0) return result;
  const reading = await readAutonomyLevel({ flags: deps.flags, db, config: deps.config }, "ship_spec");
  if (reading.level < 2) return result;
  const { results: waiting } = await db
    .prepare("SELECT id FROM themes WHERE repo = ?1 AND status = 'spec_ready' AND spec_risk = 'low' ORDER BY priority_score DESC, spec_generated_at ASC LIMIT ?2")
    .bind(deps.repo, limit)
    .all<{ id: string }>();
  for (const theme of waiting) {
    if (deps.signal?.aborted) break;
    try {
      const outcome = await approveSpec(
        { env: deps.env, db, flags: deps.flags, config: deps.config, startBuild: deps.startBuild, baseBranch: deps.baseBranch, now: deps.now, log: deps.log, deniedPaths: deps.deniedPaths },
        theme.id,
        { actor: `auto:ship_spec:L${reading.level}`, code: null, automatic: true },
      );
      if (outcome.status === "started" || outcome.status === "queued") {
        result.autoApproved += 1;
        if (reading.level === 2) await tell(deps, outcome.message);
      }
    } catch (error) {
      result.failed += 1;
      deps.log.warn("a spec could not be approved automatically", { themeId: theme.id, error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}

/** One line for the run row. Pure. */
export function specsSummary(r: SpecJobResult): string {
  const parts = [`${r.candidates} candidates`, `${r.ready} ready for review`, `${r.declined} declined`, `${r.unusable} unusable`, `${r.autoApproved} approved automatically`];
  if (r.failed) parts.push(`${r.failed} failed`);
  return `${parts.join(", ")}${r.stopped.length ? `; stopped: ${r.stopped.join("; ")}` : ""}`;
}
