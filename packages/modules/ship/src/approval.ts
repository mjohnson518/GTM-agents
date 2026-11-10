// GTM-agents: approving and declining a theme's spec, by a person or, at an earned level, on its own.
//
// An approval binds to the digest of the spec's exact content (spec.ts specDigest):
//   - a person approves with `ship-approve-<id> <code>`, where the code is the digest's first 32 hex
//     characters, shown with the spec by ship-spec-<id>. A code that is not the current spec's
//     approves nothing, and the current spec is shown again with its code;
//   - a spec edited in the database after it was written no longer hashes to its stored digest: it
//     goes back to review (the stored digest is replaced with the new one, and nothing is approved);
//   - automatically only while ship_spec is at level 2 or above (read through the autonomy module's
//     reader, which fails closed to 1), only for a low-risk spec, and at most
//     MAX_AUTO_APPROVALS_PER_RUN per run. Medium risk always waits for a person.
// Approving is one transaction: the ship_tasks row (queued) is created only while the theme still
// waits with the same digest and the same stored spec, and the theme moves to approved under the
// same condition, so two approvals at once create one task.
// Then StartShipBuild is called, which is idempotent per task: if it does not start, the task stays
// queued and the same approve command tries again. Every decision is autonomy evidence for ship_spec,
// written once per theme and digest (bookkeeping: a lost row never changes the approval).
import { recordAutonomyEvidenceOnce, readAutonomyLevel } from "@gtm-agents/core/autonomy/runtime";
import type { GtmConfig } from "@gtm-agents/core/config";
import type { Env } from "@gtm-agents/core";
import type { FlagReader, JobLogger } from "@gtm-agents/core/jobs";
import { sanitizeErrorMessage } from "@gtm-agents/core/security";
import type { ShipSpec, StartShipBuild } from "./contract.ts";
import { SHIP_FLAGS, shipFlagOn } from "./planning-flags.ts";
import { constantTimeEqual, hexId, oneLine } from "./planning-shared.ts";
import { approvalCode, declineReason, impliedRisk, parseStoredSpec, renderSpec, specDigest, unusableSpec } from "./spec.ts";

/**
 * Records that a spec changed after it was written: its digest becomes the new one, and its stored
 * risk becomes at least medium, so automatic approval (which needs low) never takes it.
 */
export async function markEdited(db: D1Database, themeId: string, digest: string, stored: string | null, now: Date): Promise<void> {
  await db
    .prepare("UPDATE themes SET spec_digest = ?2, spec_risk = CASE WHEN spec_risk = 'high' THEN 'high' ELSE 'medium' END, updated_at = ?3 WHERE id = ?1 AND status = 'spec_ready' AND spec IS ?4")
    .bind(themeId, digest, now.toISOString(), stored)
    .run();
}

/**
 * Why a stored spec may not be approved without a person, by the writer's own checks, or null.
 * `raw` is the theme's feedback text, read only for the verbatim check and never sent anywhere.
 * Pure.
 */
export function automaticRecheck(spec: ShipSpec, deniedPaths: readonly string[] | undefined, raw: readonly string[]): string | null {
  if (!deniedPaths) return "the denied paths are not known here";
  if (impliedRisk(spec) !== "low") return "its files make it more than low risk";
  const decline = declineReason(spec, deniedPaths);
  if (decline) return decline;
  const unusable = unusableSpec(spec, raw);
  if (unusable) return unusable;
  return null;
}

/** The raw feedback text of a theme's requests, for the verbatim check only. */
async function themeFeedbackText(db: D1Database, themeId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT text FROM feedback_items WHERE theme_id = ?1 AND status IN ('themed', 'shipped') ORDER BY created_at DESC LIMIT 200").bind(themeId).all<{ text: string }>();
  return results.map((r) => r.text);
}

/** Specs approved automatically in one run, at most. */
export const MAX_AUTO_APPROVALS_PER_RUN = 2;

export interface ApprovalDeps<E extends Env> {
  env: E;
  db: D1Database;
  flags: FlagReader;
  config: Pick<GtmConfig, "autonomy">;
  startBuild: StartShipBuild<E>;
  baseBranch: string;
  now: Date;
  log?: JobLogger;
  /**
   * The denied-path globs. Automatic approval re-checks the stored spec against them, and refuses
   * when they are not given (it fails closed).
   */
  deniedPaths?: readonly string[];
}

export type ApprovalStatus = "started" | "queued" | "review" | "declined" | "refused" | "not_found";

export interface ApprovalOutcome {
  status: ApprovalStatus;
  message: string;
  taskId?: string;
}

interface ThemeRow {
  id: string;
  repo: string;
  title: string;
  status: string;
  spec: string | null;
  spec_digest: string | null;
  spec_risk: string | null;
  approved_by: string | null;
}

const loadTheme = (db: D1Database, id: string) =>
  db.prepare("SELECT id, repo, title, status, spec, spec_digest, spec_risk, approved_by FROM themes WHERE id = ?1").bind(id).first<ThemeRow>();

export const newTaskId = (): string => `st_${hexId(20)}`;

/** The command that approves exactly this spec. */
export const approveCommand = (themeId: string, digest: string): string => `ship-approve-${themeId} ${approvalCode(digest)}`;

/** The text that shows a spec for review, with the command that approves exactly it. Pure. */
export function reviewText(themeId: string, spec: ShipSpec, digest: string, lead: string[] = []): string {
  return [...lead, ...(lead.length ? [""] : []), renderSpec(spec), "", `Approve exactly this: ${approveCommand(themeId, digest)}`, `Decline it: ship-decline-${themeId} [reason]`].join("\n");
}

async function startTask<E extends Env>(deps: ApprovalDeps<E>, taskId: string): Promise<{ started: boolean; reason?: string }> {
  try {
    const r = await deps.startBuild(deps.env, taskId, deps.now);
    return r && typeof r.started === "boolean" ? r : { started: false, reason: "the build answered with nothing usable" };
  } catch (error) {
    deps.log?.warn("the ship build could not be started", { taskId, error: sanitizeErrorMessage(error) });
    return { started: false, reason: `the build could not be started (${sanitizeErrorMessage(error)})` };
  }
}

const startedText = (taskId: string, start: { started: boolean; reason?: string }, retry: string) =>
  start.started
    ? `Task ${taskId} is queued and its build has started. A pull request comes back for a person to review; nothing merges on its own.`
    : `Task ${taskId} is queued, but its build did not start: ${oneLine(start.reason ?? "no reason given", 200)}. ${retry}`;

/**
 * Approve a theme's spec. `code` is the approval code a person sent; null with `automatic` set
 * approves at the earned level the caller read (and this function reads again). Throws on a
 * database error; the caller reports it.
 */
export async function approveSpec<E extends Env>(deps: ApprovalDeps<E>, themeId: string, input: { actor: string; code: string | null; automatic?: boolean }): Promise<ApprovalOutcome> {
  const { db, now } = deps;
  if (!(await shipFlagOn(deps.flags, SHIP_FLAGS.enabled))) return { status: "refused", message: `The ship loop is off (${SHIP_FLAGS.enabled}), so nothing was approved.` };
  const row = await loadTheme(db, themeId);
  if (!row) return { status: "not_found", message: `There is no theme ${themeId}.` };
  const spec = parseStoredSpec(row.spec);

  if (row.status === "approved" && !input.automatic) {
    // Approved already: the same command (with the same code) starts a build that did not start.
    if (!spec) return { status: "refused", message: `Theme ${themeId} is approved, but its spec cannot be read, so no build was started.` };
    const digest = await specDigest(row.id, spec);
    if (!input.code || !constantTimeEqual(input.code, approvalCode(digest)) || digest !== row.spec_digest) {
      return { status: "refused", message: `Theme ${themeId} is already approved. To start a build that did not start, send the approve command you used.` };
    }
    const task = await db.prepare("SELECT id FROM ship_tasks WHERE theme_id = ?1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1").bind(row.id).first<{ id: string }>();
    if (!task) return { status: "refused", message: `Theme ${themeId} is approved and its task is past the queue, so nothing was started again.` };
    const start = await startTask(deps, task.id);
    return { status: start.started ? "started" : "queued", taskId: task.id, message: startedText(task.id, start, "Send the same command again to retry.") };
  }
  if (row.status !== "spec_ready") return { status: "refused", message: `Theme ${themeId} is ${row.status}, so there is no spec to approve.` };
  if (!spec) return { status: "refused", message: `The spec on theme ${themeId} cannot be read, so nothing was approved.` };

  const digest = await specDigest(row.id, spec);
  if (digest !== row.spec_digest) {
    // Edited after it was written: it goes back to review under its new digest, at no lower than
    // medium risk, so only a person can approve a spec no writer produced.
    await markEdited(db, row.id, digest, row.spec, now);
    return { status: "review", message: reviewText(row.id, spec, digest, [`Nothing was approved: the spec on theme ${themeId} changed after it was written, so it goes back to review. This is the version an approval covers.`]) };
  }
  if (input.automatic) {
    if (spec.risk !== "low" || row.spec_risk !== "low") return { status: "refused", message: `Theme ${themeId} is not low risk, so it waits for a person.` };
    // The same checks the spec writer applied, run again on what is stored now.
    const recheck = automaticRecheck(spec, deps.deniedPaths, await themeFeedbackText(db, row.id));
    if (recheck) return { status: "refused", message: `Theme ${themeId} waits for a person: ${recheck}.` };
    const reading = await readAutonomyLevel({ flags: deps.flags, db, config: deps.config }, "ship_spec");
    if (reading.level < 2) return { status: "refused", message: `ship_spec is at level ${reading.level}, so theme ${themeId} waits for a person.` };
  } else if (!input.code || !constantTimeEqual(input.code, approvalCode(digest))) {
    return { status: "review", message: reviewText(row.id, spec, digest, [`Nothing was approved: that code is not the current spec's. This is the version an approval covers.`]) };
  }

  const at = now.toISOString();
  const taskId = newTaskId();
  // One transaction: the task row is created only while the theme still waits with this exact spec,
  // and the theme moves in the same breath, so two approvals at once create one task.
  const [created] = await db.batch([
    db
      .prepare(
        `INSERT INTO ship_tasks (id, theme_id, repo, base_branch, status, risk, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?6 WHERE EXISTS (SELECT 1 FROM themes WHERE id = ?2 AND status = 'spec_ready' AND spec_digest = ?7 AND spec IS ?8)`,
      )
      .bind(taskId, row.id, row.repo, deps.baseBranch, spec.risk, at, digest, row.spec),
    db
      .prepare("UPDATE themes SET status = 'approved', approved_by = ?2, approved_at = ?3, updated_at = ?3 WHERE id = ?1 AND status = 'spec_ready' AND spec_digest = ?4 AND spec IS ?5")
      .bind(row.id, input.actor, at, digest, row.spec),
  ]);
  if ((created?.meta.changes ?? 0) === 0) return { status: "refused", message: `Theme ${themeId} changed while it was being approved, so nothing was approved. Show it again with ship-spec-${themeId}.` };

  await recordAutonomyEvidenceOnce(db, `ship_spec:${row.id}:${digest.slice(0, 16)}`, {
    actionClass: "ship_spec",
    outcome: input.automatic ? "auto_sent" : "approved_unchanged",
    subjectId: row.id,
    detail: input.automatic ? "approved automatically at an earned level" : "approved in chat",
    now,
  });
  const start = await startTask(deps, taskId);
  const lead = input.automatic ? `Approved theme ${themeId} automatically (ship_spec at level 2 or above, low risk): ${oneLine(spec.title, 100)}.` : `Approved theme ${themeId}: ${oneLine(spec.title, 100)}.`;
  return { status: start.started ? "started" : "queued", taskId, message: `${lead} ${startedText(taskId, start, `Send ${approveCommand(row.id, digest)} again to retry.`)}` };
}

/** Decline a theme that is open or has a spec waiting. Throws on a database error. */
export async function declineSpec(db: D1Database, themeId: string, input: { actor: string; reason: string; now: Date; flags: FlagReader }): Promise<ApprovalOutcome> {
  if (!(await shipFlagOn(input.flags, SHIP_FLAGS.enabled))) return { status: "refused", message: `The ship loop is off (${SHIP_FLAGS.enabled}), so nothing was changed.` };
  const row = await loadTheme(db, themeId);
  if (!row) return { status: "not_found", message: `There is no theme ${themeId}.` };
  if (row.status !== "open" && row.status !== "spec_ready") return { status: "refused", message: `Theme ${themeId} is ${row.status}, so it cannot be declined here.` };
  const reason = oneLine(input.reason, 300) || "declined by the operator";
  const at = input.now.toISOString();
  const changed = await db
    .prepare("UPDATE themes SET status = 'declined', declined_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = ?4")
    .bind(row.id, reason, at, row.status)
    .run();
  if ((changed.meta.changes ?? 0) === 0) return { status: "refused", message: `Theme ${themeId} changed while it was being declined, so nothing was changed.` };
  if (row.status === "spec_ready" && row.spec_digest) {
    await recordAutonomyEvidenceOnce(db, `ship_spec:${row.id}:${row.spec_digest.slice(0, 16)}`, { actionClass: "ship_spec", outcome: "rejected", subjectId: row.id, detail: "declined in chat", now: input.now });
  }
  return { status: "declined", message: `Declined theme ${themeId}${row.status === "spec_ready" ? " and its spec" : ""}. Nothing will be built for it.` };
}
