// GTM-agents: experiment proposals: every change the experiments module wants, waiting for a person.
//
// Nothing in this module changes a setting or a template on its own. The evaluation cycle and the
// weekly self-review write proposals (experiment_proposals); only `exp-approve-<id>` from an
// allowlisted operator applies one, and only when, in order:
//   1. the proposal exists and is pending (not applied, rejected, expired or stale);
//   2. its target is one this module may write: a template weight override, the holdout rate, a
//      signal source switch, the send-time test switch, or a copy change;
//   3. nothing changed since it was made: a setting must still hold the value the proposal was
//      made against (current); a copy change re-checks the experiment's or test's state, both
//      templates' file hashes and both weights. Anything different marks it stale and applies
//      nothing;
//   4. the settings it writes are locked (a claim in the effects ledger) while it is checked and
//      applied, so two approvals that touch the same setting never interleave; then the proposal
//      is claimed (pending to applied, compare-and-set) before anything is written, so one proposal
//      never applies twice; a write that fails puts it back to pending;
//   5. it is younger than PROPOSAL_TTL_DAYS; an older one expires instead.
// Proposals are deduplicated: the same kind, target and proposed value is not proposed again within
// PROPOSAL_DEDUPE_DAYS. A pending proposal expires after PROPOSAL_TTL_DAYS. Each carries a
// prediction; once judged (self-review.ts) it records hit or miss, and new proposals show the
// track record of the ones before them.
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { DAY_MS } from "../metrics/index.ts";
import type { KvStore } from "../shared/kv.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { MAX_TEMPLATE_WEIGHT, parseWeight, templateWeightKey } from "./flags.ts";
import { HOLDOUT_RATE_MAX } from "../outreach/flags.ts";
import { loadExperiment, recordedVerdict } from "./store.ts";

export const PROPOSAL_DEDUPE_DAYS = 7;
export const PROPOSAL_TTL_DAYS = 14;
/** A promoted loser keeps this weight, so it is never switched off by a promotion. */
export const LOSER_WEIGHT_FLOOR = 0.1;

export const PROPOSAL_KINDS = ["template_weight", "holdout_rate", "signal_source", "send_time_experiment", "copy_change"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type ProposalStatus = "pending" | "applied" | "rejected" | "expired" | "superseded" | "stale";

export interface ExperimentProposal {
  id: string;
  kind: ProposalKind;
  target: string;
  /** The value the setting held when the proposal was made; empty for unset. */
  current: string;
  proposed: string;
  reason: string;
  prediction: string;
  predictedEffect: number | null;
  neededSample: number | null;
  evidence: Record<string, unknown>;
  status: ProposalStatus;
  outcome: "hit" | "miss" | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

interface ProposalRow {
  id: string;
  kind: string;
  target: string;
  current: string | null;
  proposed: string;
  reason: string | null;
  prediction: string | null;
  predicted_effect: number | null;
  needed_sample: number | null;
  evidence: string | null;
  status: string;
  outcome: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const COLUMNS = "id, kind, target, current, proposed, reason, prediction, predicted_effect, needed_sample, evidence, status, outcome, created_at, decided_at, decided_by";

function toProposal(r: ProposalRow): ExperimentProposal | null {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(r.kind)) return null;
  let evidence: Record<string, unknown> = {};
  try {
    const parsed: unknown = r.evidence ? JSON.parse(r.evidence) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) evidence = parsed as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  return {
    id: r.id,
    kind: r.kind as ProposalKind,
    target: r.target,
    current: r.current ?? "",
    proposed: r.proposed,
    reason: r.reason ?? "",
    prediction: r.prediction ?? "",
    predictedEffect: r.predicted_effect,
    neededSample: r.needed_sample,
    evidence,
    status: r.status as ProposalStatus,
    outcome: r.outcome === "hit" || r.outcome === "miss" ? r.outcome : null,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  };
}

export interface ProposalInput {
  kind: ProposalKind;
  target: string;
  current: string;
  proposed: string;
  reason: string;
  prediction: string;
  predictedEffect?: number | null;
  neededSample?: number | null;
  evidence?: Record<string, unknown>;
}

export async function loadProposal(db: D1Database, id: string): Promise<ExperimentProposal | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM experiment_proposals WHERE id = ?1`).bind(id).first<ProposalRow>();
  return row ? toProposal(row) : null;
}

/** Pending proposals, oldest first. Throws on a database error. */
export async function pendingProposals(db: D1Database, limit = 20): Promise<ExperimentProposal[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM experiment_proposals WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?1`).bind(limit).all<ProposalRow>();
  return results.map(toProposal).filter((p): p is ExperimentProposal => p !== null);
}

/**
 * Write a proposal, unless the same kind, target and proposed value was proposed in the last
 * PROPOSAL_DEDUPE_DAYS (whatever became of it). Returns the proposal and whether it is new.
 */
export async function createProposal(db: D1Database, input: ProposalInput, now: Date): Promise<{ proposal: ExperimentProposal; created: boolean }> {
  const since = new Date(now.getTime() - PROPOSAL_DEDUPE_DAYS * DAY_MS).toISOString();
  const existing = await db
    .prepare(`SELECT ${COLUMNS} FROM experiment_proposals WHERE kind = ?1 AND target = ?2 AND proposed = ?3 AND created_at > ?4 ORDER BY created_at DESC LIMIT 1`)
    .bind(input.kind, input.target, input.proposed, since)
    .first<ProposalRow>();
  const found = existing ? toProposal(existing) : null;
  if (found) return { proposal: found, created: false };
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  await db
    .prepare(
      `INSERT INTO experiment_proposals (id, kind, target, current, proposed, reason, prediction, predicted_effect, needed_sample, evidence, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11)`,
    )
    .bind(id, input.kind, input.target, input.current, input.proposed, input.reason, input.prediction, input.predictedEffect ?? null, input.neededSample ?? null, JSON.stringify(input.evidence ?? {}), now.toISOString())
    .run();
  const proposal = await loadProposal(db, id);
  if (!proposal) throw new Error("the proposal could not be read back");
  return { proposal, created: true };
}

/** How many proposals of these kinds were written since `since`. Throws on a database error. */
export async function proposalsSince(db: D1Database, kinds: readonly ProposalKind[], since: Date): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM experiment_proposals WHERE created_at > ?1 AND kind IN (${kinds.map((_, i) => `?${i + 2}`).join(", ")})`)
    .bind(since.toISOString(), ...kinds)
    .first<{ n: number | null }>();
  return Number(row?.n ?? 0);
}

export interface TrackRecord {
  hits: number;
  misses: number;
}

/** Judged outcomes of earlier proposals of these kinds. Throws on a database error. */
export async function trackRecord(db: D1Database, kinds: readonly ProposalKind[]): Promise<TrackRecord> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN outcome = 'miss' THEN 1 ELSE 0 END) AS misses
         FROM experiment_proposals WHERE kind IN (${kinds.map((_, i) => `?${i + 1}`).join(", ")})`,
    )
    .bind(...kinds)
    .first<{ hits: number | null; misses: number | null }>();
  return { hits: Number(row?.hits ?? 0), misses: Number(row?.misses ?? 0) };
}

export function trackRecordLine(t: TrackRecord): string {
  const judged = t.hits + t.misses;
  return judged === 0 ? "Track record: no earlier proposal judged yet." : `Track record: ${t.hits} of ${judged} earlier predictions held (${t.misses} missed).`;
}

/** Record a judged outcome, once. Bookkeeping: never throws. */
export async function recordOutcome(db: D1Database, id: string, outcome: "hit" | "miss", detail: string, now: Date): Promise<boolean> {
  try {
    const r = await db
      .prepare("UPDATE experiment_proposals SET outcome = ?2, outcome_detail = ?3, outcome_at = ?4 WHERE id = ?1 AND outcome IS NULL AND status = 'applied'")
      .bind(id, outcome, detail, now.toISOString())
      .run();
    return (r.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Expire pending proposals older than PROPOSAL_TTL_DAYS. Bookkeeping: never throws. */
export async function expireProposals(db: D1Database, now: Date): Promise<number> {
  try {
    const r = await db
      .prepare("UPDATE experiment_proposals SET status = 'expired', decided_at = ?1 WHERE status = 'pending' AND created_at < ?2")
      .bind(now.toISOString(), new Date(now.getTime() - PROPOSAL_TTL_DAYS * DAY_MS).toISOString())
      .run();
    return r.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

/** The operator message for a proposal. Pure. */
export function proposalText(p: ExperimentProposal, track: TrackRecord | null): string {
  const lines = [
    `Proposal ${p.id} (${p.kind.replace(/_/g, " ")}): ${p.target} from ${p.current === "" ? "unset" : p.current} to ${p.proposed}.`,
    `Why: ${p.reason}`,
    `Prediction: ${p.prediction}`,
    track ? trackRecordLine(track) : "Track record: could not be read.",
    `Apply: exp-approve-${p.id}   Decline: exp-reject-${p.id}`,
    "It applies only if the setting still holds the value it was proposed against.",
  ];
  return lines.join("\n");
}

const norm = (v: string | null | undefined) => (v ?? "").trim();

/** The flag targets each kind may write, and the values it may write there. Pure. */
export function validFlagChange(kind: ProposalKind, target: string, proposed: string): string | null {
  switch (kind) {
    case "template_weight": {
      if (!/^experiments:template_weight:[a-z0-9_-]+$/.test(target)) return "not a template weight";
      const w = parseWeight(proposed);
      return w !== null && w > 0 ? null : `a weight is more than 0 and at most ${MAX_TEMPLATE_WEIGHT}`;
    }
    case "holdout_rate": {
      if (target !== "outreach:holdout_rate") return "not the holdout rate";
      const n = Number(proposed);
      return Number.isFinite(n) && n > 0 && n <= HOLDOUT_RATE_MAX ? null : `a holdout rate is more than 0 and at most ${HOLDOUT_RATE_MAX}`;
    }
    case "signal_source":
      return /^discovery:[a-z0-9-]+_enabled$/.test(target) && proposed === "true" ? null : "not a signal source switch";
    case "send_time_experiment":
      return target === "outreach:send_time_experiment" && proposed === "true" ? null : "not the send-time test switch";
    case "copy_change":
      return "a copy change is not a flag";
  }
}

export interface ApplyDeps {
  db: D1Database;
  kv: Pick<KvStore, "put"> | undefined;
  flags: FlagReader;
  /** The templates as served now, for re-checking a copy change. */
  templates: () => Promise<readonly ServedTemplate[]>;
  userId: string;
  now: Date;
}

export interface ApplyResult {
  ok: boolean;
  text: string;
}

async function claim(db: D1Database, id: string, by: string, now: Date): Promise<boolean> {
  const r = await db.prepare("UPDATE experiment_proposals SET status = 'applied', decided_at = ?2, decided_by = ?3 WHERE id = ?1 AND status = 'pending'").bind(id, now.toISOString(), by).run();
  return (r.meta.changes ?? 0) > 0;
}

async function unclaim(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE experiment_proposals SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ?1 AND status = 'applied'").bind(id).run().catch(() => undefined);
}

async function markStale(db: D1Database, id: string, now: Date): Promise<void> {
  await db.prepare("UPDATE experiment_proposals SET status = 'stale', decided_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(id, now.toISOString()).run().catch(() => undefined);
}

/** A template's weight as the batch reads it: the override, else the file. Null when unreadable. */
async function effectiveWeight(flags: FlagReader, t: ServedTemplate): Promise<{ raw: string; weight: number } | null> {
  let raw: string | null;
  try {
    raw = await flags.get(templateWeightKey(t.id));
  } catch {
    return null;
  }
  const override = parseWeight(raw);
  return { raw: norm(raw), weight: override ?? t.meta.volume_weight };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The weights a promotion writes: the loser's weight moves to the winner, down to the floor. Pure. */
export function promotedWeights(winnerWeight: number, loserWeight: number): { winner: number; loser: number } {
  const loser = LOSER_WEIGHT_FLOOR;
  const winner = Math.min(MAX_TEMPLATE_WEIGHT, round2(Math.max(winnerWeight, 0) + Math.max(loserWeight - loser, 0)));
  return { winner: Math.max(winner, loser), loser };
}

/** What a copy change re-checks and writes: both templates' state when it was proposed. */
export interface CopyChangeSnapshot {
  change: "experiment" | "template_pair" | "subject_test";
  experimentId?: string;
  testId?: string;
  variantId?: string;
  winnerTemplate: string;
  loserTemplate?: string;
  winnerSha: string;
  loserSha?: string;
  winnerWeight?: string;
  loserWeight?: string;
}

function snapshotOf(evidence: Record<string, unknown>): CopyChangeSnapshot | null {
  const s = evidence.snapshot;
  if (!s || typeof s !== "object") return null;
  const v = s as Record<string, unknown>;
  const str = (k: string) => {
    const value = v[k];
    return typeof value === "string" ? value : undefined;
  };
  const change = str("change");
  const winnerTemplate = str("winnerTemplate");
  const winnerSha = str("winnerSha");
  if ((change !== "experiment" && change !== "template_pair" && change !== "subject_test") || !winnerTemplate || !winnerSha) return null;
  const out: CopyChangeSnapshot = { change, winnerTemplate, winnerSha };
  for (const k of ["experimentId", "testId", "variantId", "loserTemplate", "loserSha", "winnerWeight", "loserWeight"] as const) {
    const value = str(k);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

async function applyCopyChange(deps: ApplyDeps, p: ExperimentProposal): Promise<ApplyResult> {
  const snap = snapshotOf(p.evidence);
  if (!snap) return { ok: false, text: `Proposal ${p.id} carries no snapshot to check against, so nothing was applied.` };
  const served = new Map((await deps.templates()).map((t) => [t.id, t]));
  const changed: string[] = [];
  const winner = served.get(snap.winnerTemplate);
  if (!winner || winner.sha256 !== snap.winnerSha) changed.push(`template ${snap.winnerTemplate} changed or is no longer served`);

  if (snap.change === "subject_test") {
    const test = await deps.db
      .prepare("SELECT t.status, t.template_id, (SELECT COUNT(*) FROM subject_variants v WHERE v.id = ?2 AND v.test_id = t.id) AS has_variant FROM subject_tests t WHERE t.id = ?1")
      .bind(snap.testId ?? "", snap.variantId ?? "")
      .first<{ status: string; template_id: string | null; has_variant: number }>();
    if (!test || test.status !== "running" || test.template_id !== snap.winnerTemplate || Number(test.has_variant) !== 1) changed.push("the subject test is no longer running as proposed");
    if (changed.length > 0) {
      await markStale(deps.db, p.id, deps.now);
      return { ok: false, text: `Proposal ${p.id} is stale: ${changed.join("; ")}. Nothing was applied.` };
    }
    if (!(await claim(deps.db, p.id, deps.userId, deps.now))) return { ok: false, text: `Proposal ${p.id} is no longer pending.` };
    const r = await deps.db
      .prepare("UPDATE subject_tests SET status = 'concluded', winner_variant_id = ?2, concluded_at = ?3 WHERE id = ?1 AND status = 'running'")
      .bind(snap.testId ?? "", snap.variantId ?? "", deps.now.toISOString())
      .run()
      .catch(() => null);
    if (!r || (r.meta.changes ?? 0) === 0) {
      await unclaim(deps.db, p.id);
      return { ok: false, text: `The subject test could not be concluded; proposal ${p.id} stays pending.` };
    }
    return { ok: true, text: `Applied ${p.id}: template ${snap.winnerTemplate} now goes out with the winning subject line.` };
  }

  // A template promotion: the winner's weight rises, the loser drops to the floor.
  const loser = snap.loserTemplate ? served.get(snap.loserTemplate) : undefined;
  if (!snap.loserTemplate || !loser || loser.sha256 !== snap.loserSha) changed.push(`template ${snap.loserTemplate ?? "(none)"} changed or is no longer served`);
  const ww = winner ? await effectiveWeight(deps.flags, winner) : null;
  const lw = loser ? await effectiveWeight(deps.flags, loser) : null;
  if (!ww || !lw) changed.push("a template weight could not be read");
  else if (ww.raw !== norm(snap.winnerWeight) || lw.raw !== norm(snap.loserWeight)) changed.push("a template weight changed since the proposal");
  if (snap.change === "experiment") {
    const e = snap.experimentId ? await loadExperiment(deps.db, snap.experimentId) : null;
    if (!e || e.status !== "concluded" || recordedVerdict(e) !== "keep") changed.push("the experiment is no longer concluded with keep");
  }
  if (changed.length > 0 || !ww || !lw || !winner || !loser) {
    await markStale(deps.db, p.id, deps.now);
    return { ok: false, text: `Proposal ${p.id} is stale: ${changed.join("; ")}. Nothing was applied.` };
  }
  if (!deps.kv) return { ok: false, text: "No flag store is bound, so nothing was applied." };
  if (!(await claim(deps.db, p.id, deps.userId, deps.now))) return { ok: false, text: `Proposal ${p.id} is no longer pending.` };
  const weights = promotedWeights(ww.weight, lw.weight);
  try {
    await deps.kv.put(templateWeightKey(winner.id), String(weights.winner));
    await deps.kv.put(templateWeightKey(loser.id), String(weights.loser));
  } catch {
    // Put back what was there, as far as the store allows, and leave the proposal pending.
    await deps.kv.put(templateWeightKey(winner.id), ww.raw).catch(() => undefined);
    await unclaim(deps.db, p.id);
    return { ok: false, text: `The weights could not be written; proposal ${p.id} stays pending.` };
  }
  if (snap.change === "experiment" && snap.experimentId) {
    await deps.db.prepare("UPDATE experiments SET status = 'promoted', promoted_at = ?2 WHERE id = ?1 AND status = 'concluded'").bind(snap.experimentId, deps.now.toISOString()).run().catch(() => undefined);
  }
  return { ok: true, text: `Applied ${p.id}: ${winner.id} weight ${weights.winner}, ${loser.id} weight ${weights.loser}.` };
}

const LOCK_EFFECT = "experiment_setting_lock";
/** A lock older than this was left by a run that died; it is cleared before claiming. */
const LOCK_STALE_MS = 5 * 60_000;

/** The settings a proposal writes, locked while it is checked and applied. Pure. */
export function lockKeys(p: Pick<ExperimentProposal, "kind" | "target" | "evidence">): string[] {
  if (p.kind !== "copy_change") return [`setting:${p.target}`];
  const snap = snapshotOf(p.evidence);
  if (!snap) return [`setting:${p.target}`];
  if (snap.change === "subject_test") return [`subject_test:${snap.testId ?? ""}`];
  return [`setting:${templateWeightKey(snap.winnerTemplate)}`, `setting:${templateWeightKey(snap.loserTemplate ?? "")}`];
}

/**
 * Run `fn` holding a lock on each key (a claim in the effects ledger), so two approvals that touch
 * the same setting never check and write at the same time. Returns null when another holds one.
 */
async function withLocks<T>(db: D1Database, keys: readonly string[], fn: () => Promise<T>): Promise<T | null> {
  const acquired: string[] = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      await db.prepare("DELETE FROM event_effects WHERE event_id = ?1 AND effect = ?2 AND created_at < ?3").bind(key, LOCK_EFFECT, new Date(Date.now() - LOCK_STALE_MS).toISOString()).run();
      if (!(await claimEffect(db, key, LOCK_EFFECT))) return null;
      acquired.push(key);
    }
    return await fn();
  } finally {
    for (const key of acquired) await releaseEffect(db, key, LOCK_EFFECT);
  }
}

/** Apply a proposal for an allowlisted operator. Throws on a database error before any write. */
export async function approveProposal(deps: ApplyDeps, id: string): Promise<ApplyResult> {
  const first = await loadProposal(deps.db, id);
  if (!first) return { ok: false, text: `No proposal ${id}.` };
  const result = await withLocks(deps.db, lockKeys(first), () => applyLocked(deps, id));
  return result ?? { ok: false, text: `Another change to the same setting is being applied. Nothing was applied; send exp-approve-${id} again in a moment.` };
}

async function applyLocked(deps: ApplyDeps, id: string): Promise<ApplyResult> {
  // Read again under the lock: everything below checks the state as it is now.
  const p = await loadProposal(deps.db, id);
  if (!p) return { ok: false, text: `No proposal ${id}.` };
  if (p.status !== "pending") return { ok: false, text: `Proposal ${id} is ${p.status}; nothing was applied.` };
  if (Date.parse(p.createdAt) < deps.now.getTime() - PROPOSAL_TTL_DAYS * DAY_MS) {
    await deps.db.prepare("UPDATE experiment_proposals SET status = 'expired', decided_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(p.id, deps.now.toISOString()).run();
    return { ok: false, text: `Proposal ${id} is older than ${PROPOSAL_TTL_DAYS} days and has expired. Nothing was applied.` };
  }
  if (p.kind === "copy_change") return applyCopyChange(deps, p);

  const invalid = validFlagChange(p.kind, p.target, p.proposed);
  if (invalid) return { ok: false, text: `Proposal ${id} cannot be applied: ${invalid}.` };
  let raw: string | null;
  try {
    raw = await deps.flags.get(p.target);
  } catch {
    return { ok: false, text: `${p.target} could not be read, so nothing was applied. Try again once it can be.` };
  }
  if (norm(raw) !== norm(p.current)) {
    await markStale(deps.db, p.id, deps.now);
    return { ok: false, text: `Proposal ${id} is stale: ${p.target} is now ${norm(raw) || "unset"}, not ${p.current || "unset"}. Nothing was applied.` };
  }
  if (!deps.kv) return { ok: false, text: "No flag store is bound, so nothing was applied." };
  if (!(await claim(deps.db, p.id, deps.userId, deps.now))) return { ok: false, text: `Proposal ${id} is no longer pending.` };
  try {
    await deps.kv.put(p.target, p.proposed);
  } catch {
    await unclaim(deps.db, p.id);
    return { ok: false, text: `${p.target} could not be written; proposal ${id} stays pending.` };
  }
  return { ok: true, text: `Applied ${id}: ${p.target} is now ${p.proposed}.` };
}

/** Decline a pending proposal. */
export async function rejectProposal(db: D1Database, id: string, by: string, now: Date): Promise<ApplyResult> {
  const r = await db.prepare("UPDATE experiment_proposals SET status = 'rejected', decided_at = ?2, decided_by = ?3 WHERE id = ?1 AND status = 'pending'").bind(id, now.toISOString(), by).run();
  return (r.meta.changes ?? 0) > 0 ? { ok: true, text: `Declined ${id}. Nothing changed.` } : { ok: false, text: `No pending proposal ${id}.` };
}
