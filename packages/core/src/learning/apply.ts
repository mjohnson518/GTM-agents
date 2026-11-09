// GTM-agents: approving, rejecting and applying self-improvement proposals.
//
// approveLearningProposal is the only path from a proposal to a change made by a person. It applies
// only when, at that moment:
//   1. the proposal is pending and unexpired;
//   2. its stored fields still render to the stored digest (nothing edited the row);
//   3. the digest the person was shown matches it (the full digest from the dashboard, or the code
//      of at least 32 hex characters the chat shows);
//   4. it is claimed with a compare-and-set, so two approvals never both apply;
//   5. what it changes still holds the value it was made against (a brain component's bytes, an
//      objection's pattern, a playbook field's value); otherwise it is marked expired as stale.
// A write that fails puts the proposal back to pending.
//
// autoApplyLearningProposal is the one exception, for what earned autonomy allows: a loop's own
// proposal applies without a person only when its class (brain_edit or retrospective_actuation)
// reads level 2 or above through readAutonomyLevel at that moment, and only for changes that never
// reach a prospect on their own: an edit to a self-editable brain component (message-pillars,
// voice), an inactive discovery query, or a playbook field no writer reads. No flag loosens this.
// Decisions are recorded as autonomy evidence for the class (bookkeeping: never fails the action).
import { recordAutonomyEvidence } from "../autonomy/evidence.ts";
import type { ActionClass } from "../autonomy/levels.ts";
import { readAutonomyLevel } from "../autonomy/store.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { objectionAnswerDigest } from "../replies/objections.ts";
import { applyBrainEdit, SELF_EDITABLE_COMPONENTS, type BrainKv } from "./brain-edit.ts";
import { learningEntries, sectionRoom } from "./learnings.ts";
import { intact, loadLearningProposal, PROSPECT_FACING_PLAYBOOK_FIELDS, type LearningProposal, type ProposalPayloads } from "./proposals.ts";

export interface ApplyDeps {
  db: D1Database;
  /** The KV namespace the brain is served from. Brain edits need it. */
  kv?: BrainKv;
  now: Date;
}

export type ApproveStatus = "applied" | "approved" | "stale" | "refused" | "not_found" | "failed";
export interface ApproveOutcome {
  status: ApproveStatus;
  message: string;
}

type ApplyResult = { result: "applied" | "approved"; message: string } | { result: "stale" | "failed"; message: string };

/** The autonomy class a proposal's decisions count toward, or null for the operator's own. */
export function classOf(p: Pick<LearningProposal, "kind" | "proposedBy">): ActionClass | null {
  if (p.proposedBy.startsWith("operator:")) return null;
  if (p.kind === "brain" || p.kind === "voice") return "brain_edit";
  if (p.proposedBy === "retrospective") return "retrospective_actuation";
  return null;
}

async function applyChange(deps: ApplyDeps, p: LearningProposal, actor: string): Promise<ApplyResult> {
  const at = deps.now.toISOString();
  switch (p.kind) {
    case "learning": {
      const x = p.payload as ProposalPayloads["learning"];
      const room = sectionRoom(await learningEntries(deps.db), x.section, x.text, x.replaces ?? null);
      if (room) return { result: "failed", message: room };
      if (x.replaces) {
        const r = await deps.db
          .prepare("UPDATE learnings_proposals SET status = 'expired', status_reason = ?2, updated_at = ?3 WHERE short_id = ?1 AND kind = 'learning' AND status = 'applied'")
          .bind(x.replaces, `replaced by ${p.shortId}`, at)
          .run();
        if ((r.meta.changes ?? 0) === 0) return { result: "stale", message: `entry ${x.replaces} is no longer in the document` };
      }
      return { result: "applied", message: `Added to the learnings section ${x.section}.` };
    }
    case "brain":
    case "voice": {
      const x = p.payload as ProposalPayloads["brain"];
      const r = await applyBrainEdit({ db: deps.db, kv: deps.kv, now: deps.now }, { component: x.component, baseSha256: x.baseSha256, content: x.content });
      if (r.ok) return { result: "applied", message: `Applied ${x.component}; the brain is now version ${r.version}.` };
      return { result: r.stale ? "stale" : "failed", message: r.reason };
    }
    case "objection_answer": {
      const x = p.payload as ProposalPayloads["objection_answer"];
      const digest = await objectionAnswerDigest({ pattern: x.pattern, response: x.response });
      const r = await deps.db
        .prepare("UPDATE objections SET response_template = ?1, approved_digest = ?2, author = ?3, updated_at = ?4 WHERE id = ?5 AND pattern = ?6")
        .bind(x.response, digest, actor.slice(0, 64), at, x.objectionId, x.pattern)
        .run();
      if ((r.meta.changes ?? 0) === 0) return { result: "stale", message: "the objection changed or is gone" };
      return { result: "applied", message: "The answer is approved; reply drafts may use it." };
    }
    case "template": {
      const x = p.payload as ProposalPayloads["template"];
      const candidate = `${x.template}-candidate-${p.shortId}`.slice(0, 64);
      return {
        result: "approved",
        message: [
          `Approved as a candidate. No template changed. To test it through the copy-change gate, add a template file with the id ${candidate} holding exactly the subject and body shown, upload it, then send:`,
          "experiment-create",
          `name: ${candidate}`,
          `hypothesis: ${x.hypothesis}`,
          "primary_metric: positive_reply",
          `control_template: ${x.template}`,
          `treatment_template: ${candidate}`,
        ].join("\n"),
      };
    }
    case "discovery_query": {
      const x = p.payload as ProposalPayloads["discovery_query"];
      const dup = await deps.db.prepare("SELECT id FROM discovery_queries WHERE source = ?1 AND lower(query) = lower(?2) LIMIT 1").bind(x.source, x.query).first();
      if (dup) return { result: "stale", message: "that query already exists" };
      await deps.db
        .prepare("INSERT INTO discovery_queries (id, query, source, category, is_active, deactivated_reason, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)")
        .bind(`dq_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, x.query, x.source, x.category ?? null, `proposed by ${p.proposedBy} (${p.shortId}); inactive until activated`, at)
        .run();
      return { result: "applied", message: "Added inactive. It runs only once you activate it." };
    }
    case "playbook_field": {
      const x = p.payload as ProposalPayloads["playbook_field"];
      const column = x.field; // one of PLAYBOOK_FIELDS, checked when the proposal was stored
      const row = await deps.db.prepare(`SELECT ${column} AS value FROM persona_playbooks WHERE persona = ?1`).bind(x.persona).first<{ value: string | null }>();
      if (row) {
        if ((row.value ?? null) !== x.previous) return { result: "stale", message: `the ${x.field} of ${x.persona} changed since this was proposed` };
        const r = await deps.db
          .prepare(`UPDATE persona_playbooks SET ${column} = ?1, updated_at = ?2 WHERE persona = ?3 AND ${column} IS ?4`)
          .bind(x.value, at, x.persona, x.previous)
          .run();
        if ((r.meta.changes ?? 0) === 0) return { result: "stale", message: `the ${x.field} of ${x.persona} changed since this was proposed` };
      } else {
        if (x.previous !== null) return { result: "stale", message: `the ${x.persona} playbook is gone` };
        await deps.db
          .prepare(`INSERT INTO persona_playbooks (id, persona, goal, ${column}, created_at, updated_at) VALUES (?1, ?2, 'positive_reply', ?3, ?4, ?4)`)
          .bind(`pb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, x.persona, x.value, at)
          .run();
      }
      return { result: "applied", message: `Set the ${x.field} of ${x.persona}.` };
    }
  }
}

async function finish(deps: ApplyDeps, p: LearningProposal, outcome: ApplyResult): Promise<void> {
  const at = deps.now.toISOString();
  if (outcome.result === "applied") {
    await deps.db.prepare("UPDATE learnings_proposals SET status = 'applied', applied_at = ?2, status_reason = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(p.id, at).run();
  } else if (outcome.result === "approved") {
    await deps.db.prepare("UPDATE learnings_proposals SET status_reason = ?2, updated_at = ?3 WHERE id = ?1").bind(p.id, "approved as a copy-change candidate", at).run();
  } else if (outcome.result === "stale") {
    await deps.db.prepare("UPDATE learnings_proposals SET status = 'expired', status_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'approved'").bind(p.id, `stale: ${outcome.message}`.slice(0, 300), at).run();
  } else {
    await deps.db
      .prepare("UPDATE learnings_proposals SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, status_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'approved'")
      .bind(p.id, outcome.message.slice(0, 300), at)
      .run();
  }
}

async function claim(deps: ApplyDeps, p: LearningProposal, reviewer: string): Promise<boolean> {
  const at = deps.now.toISOString();
  const r = await deps.db
    .prepare("UPDATE learnings_proposals SET status = 'approved', reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3 WHERE id = ?1 AND status = 'pending' AND proposed_digest = ?4")
    .bind(p.id, reviewer.slice(0, 64), at, p.digest)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

async function checkable(deps: ApplyDeps, id: string): Promise<{ proposal: LearningProposal } | ApproveOutcome> {
  const p = await loadLearningProposal(deps.db, id);
  if (!p) return { status: "not_found", message: `No proposal ${id}.` };
  if (p.status !== "pending") return { status: "refused", message: `Proposal ${p.shortId} is ${p.status}${p.statusReason ? ` (${p.statusReason})` : ""}.` };
  if (p.expiresAt && p.expiresAt <= deps.now.toISOString()) {
    await deps.db.prepare("UPDATE learnings_proposals SET status = 'expired', status_reason = 'expired unreviewed', updated_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(p.id, deps.now.toISOString()).run();
    return { status: "refused", message: `Proposal ${p.shortId} expired.` };
  }
  if (!(await intact(p))) return { status: "refused", message: `Proposal ${p.shortId} no longer matches what was proposed, so it cannot be approved.` };
  return { proposal: p };
}

/** Apply a proposal a person approved, bound to the digest they were shown. Throws on a database error. */
export async function approveLearningProposal(deps: ApplyDeps, id: string, shownDigest: string, actor: string): Promise<ApproveOutcome> {
  const checked = await checkable(deps, id);
  if (!("proposal" in checked)) return checked;
  const p = checked.proposal;
  const shown = shownDigest.trim().toLowerCase();
  if (!/^[0-9a-f]{32,64}$/.test(shown) || !p.digest.startsWith(shown)) {
    return { status: "refused", message: `What you approved is not what proposal ${p.shortId} holds now. Show it again with learning-show ${p.shortId}.` };
  }
  if (!(await claim(deps, p, actor))) return { status: "refused", message: `Proposal ${p.shortId} was decided by someone else first.` };
  let outcome: ApplyResult;
  try {
    outcome = await applyChange(deps, p, actor);
  } catch {
    outcome = { result: "failed", message: "the change could not be written" };
  }
  await finish(deps, p, outcome);
  const actionClass = classOf(p);
  if (actionClass && (outcome.result === "applied" || outcome.result === "approved")) {
    await recordAutonomyEvidence(deps.db, { actionClass, outcome: "approved_unchanged", subjectId: p.shortId, detail: `${p.kind} approved by a person`, now: deps.now });
  }
  if (outcome.result === "failed") return { status: "failed", message: `Proposal ${p.shortId} was not applied: ${outcome.message}. It is pending again.` };
  if (outcome.result === "stale") return { status: "stale", message: `Proposal ${p.shortId} is stale: ${outcome.message}. Nothing changed.` };
  return { status: outcome.result, message: outcome.message };
}

/** Turn a proposal down. Throws on a database error. */
export async function rejectLearningProposal(deps: ApplyDeps, id: string, actor: string, reason?: string): Promise<ApproveOutcome> {
  const p = await loadLearningProposal(deps.db, id);
  if (!p) return { status: "not_found", message: `No proposal ${id}.` };
  const at = deps.now.toISOString();
  const r = await deps.db
    .prepare("UPDATE learnings_proposals SET status = 'rejected', reviewed_by = ?2, reviewed_at = ?3, status_reason = ?4, updated_at = ?3 WHERE id = ?1 AND status = 'pending'")
    .bind(p.id, actor.slice(0, 64), at, (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null)
    .run();
  if ((r.meta.changes ?? 0) === 0) return { status: "refused", message: `Proposal ${p.shortId} is ${p.status}; nothing changed.` };
  const actionClass = classOf(p);
  if (actionClass) await recordAutonomyEvidence(deps.db, { actionClass, outcome: "rejected", subjectId: p.shortId, detail: `${p.kind} rejected`, now: deps.now });
  return { status: "applied", message: `Rejected ${p.shortId}.` };
}

export interface AutoApplyDeps extends ApplyDeps {
  flags: FlagReader;
  config?: Pick<GtmConfig, "autonomy">;
}

/** Whether a loop's proposal is the kind earned autonomy may apply without a person. */
export function selfApplicable(p: Pick<LearningProposal, "kind" | "payload" | "proposedBy">): boolean {
  if (p.proposedBy.startsWith("operator:")) return false;
  if (p.kind === "brain" || p.kind === "voice") return SELF_EDITABLE_COMPONENTS.includes((p.payload as ProposalPayloads["brain"]).component);
  if (p.proposedBy !== "retrospective") return false;
  if (p.kind === "discovery_query") return true;
  if (p.kind === "playbook_field") return !PROSPECT_FACING_PLAYBOOK_FIELDS.includes((p.payload as ProposalPayloads["playbook_field"]).field);
  return false;
}

/**
 * Apply a loop's own proposal without a person, only when its class reads level 2 or above now and
 * the change is self-applicable. Anything else leaves it pending for a person. Throws on a database
 * error.
 */
export async function autoApplyLearningProposal(deps: AutoApplyDeps, id: string): Promise<ApproveOutcome & { level: number | null }> {
  const checked = await checkable(deps, id);
  if (!("proposal" in checked)) return { ...checked, level: null };
  const p = checked.proposal;
  const actionClass = classOf(p);
  if (!actionClass || !selfApplicable(p)) return { status: "refused", message: `Proposal ${p.shortId} waits for a person.`, level: null };
  const reading = await readAutonomyLevel({ flags: deps.flags, db: deps.db, ...(deps.config ? { config: deps.config } : {}) }, actionClass);
  if (reading.level < 2) return { status: "refused", message: `Proposal ${p.shortId} waits for a person (${actionClass} is at level ${reading.level}).`, level: reading.level };
  const reviewer = `auto:autonomy:${actionClass}:L${reading.level}`;
  if (!(await claim(deps, p, reviewer))) return { status: "refused", message: `Proposal ${p.shortId} was decided first.`, level: reading.level };
  let outcome: ApplyResult;
  try {
    outcome = await applyChange(deps, p, reviewer);
  } catch {
    outcome = { result: "failed", message: "the change could not be written" };
  }
  await finish(deps, p, outcome);
  if (outcome.result === "applied") await recordAutonomyEvidence(deps.db, { actionClass, outcome: "auto_sent", subjectId: p.shortId, detail: `${p.kind} applied at level ${reading.level}`, now: deps.now });
  const status: ApproveStatus = outcome.result === "applied" || outcome.result === "approved" ? outcome.result : outcome.result === "stale" ? "stale" : "failed";
  return { status, message: outcome.message, level: reading.level };
}
