// GTM-agents: the risk approval for a ship change, as an operator chat command:
//
//   ship-risk-approve-<task> <code>
//
// A change the path policy rates high risk, or that is over the review thresholds, waits (status
// proposed) for a person before its pull request opens. The code is bound to the task and to the
// digest of the exact files stored for it, so an approval covers those files and nothing else. The
// command re-reads the stored change, checks that its bytes still have the digest its key names,
// compares the code in constant time, and only then sends the Workflow the digest it approved. The
// Workflow checks that digest again, and the gatekeeper checks it once more before it commits.
//
// The approval opens a pull request; it never merges one. Merging code is permanently human.
import type { Env } from "@gtm-agents/core";
import { writeAudit } from "@gtm-agents/core/events";
import { constantTimeEqual } from "@gtm-agents/core/http";
import type { ModuleCommand, ModuleCommandContext } from "@gtm-agents/core/operator";
import { riskCode } from "./gatekeeper.ts";
import { RISK_APPROVAL_EVENT, buildGate, loadTaskRow, storedChanges, tryFactory, type ShipBuildDeps } from "./workflow.ts";

export const RISK_COMMAND = /^\/?ship-risk-approve-([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\s+([0-9A-Fa-f]{8}))?\s*$/;
export const RISK_HELP_LINES: readonly string[] = ["ship-risk-approve-<task> <code>: open the pull request for a high-risk ship change, for exactly the files it was shown with"];

/** Runs the approval. Returns the reply; never throws for an expected refusal. */
export async function approveRisk<E extends Env>(deps: ShipBuildDeps<E>, ctx: ModuleCommandContext<E>, taskId: string, code: string | undefined): Promise<string> {
  const { env, now } = ctx;
  const gate = await buildGate(env, deps.config);
  if (!gate.ok) return `Ship builds are not running (${gate.reason}), so nothing was approved.`;
  const row = await loadTaskRow(env.DB, taskId);
  if (!row) return `There is no ship task ${taskId}.`;
  if (row.status !== "proposed" || !row.diff_key) return `Ship task ${taskId} is ${row.status}, not waiting for a risk approval.`;
  let digest: string;
  try {
    digest = (await storedChanges(env.BUCKET, row.diff_key)).digest;
  } catch {
    return `The stored change for ${taskId} cannot be verified, so nothing was approved.`;
  }
  const expected = await riskCode(taskId, digest);
  if (!code) return `Ship task ${taskId} waits for a risk approval. Approve exactly its stored files with: ship-risk-approve-${taskId} ${expected}`;
  if (!(await constantTimeEqual(code.toLowerCase(), expected))) return `That code does not match the stored change for ${taskId}; nothing was approved.`;
  const workflow = tryFactory(deps.workflow, env);
  if (!workflow) return "The ship build Workflow binding is missing, so nothing was approved.";
  const instance = await workflow.get(taskId);
  await instance.sendEvent({ type: RISK_APPROVAL_EVENT, payload: { digest, actor: ctx.actor } });
  await writeAudit(env.DB, { agentId: ctx.actor, action: "ship_risk_approved", details: { taskId, digest }, now });
  return `Approved. The pull request for ${taskId} opens once the gatekeeper has checked the exact files again. Merging stays with you.`;
}

/** The command for createWorker's `commands`. */
export function createRiskApproveCommand<E extends Env>(deps: ShipBuildDeps<E>): ModuleCommand<E> {
  return {
    module: "ship",
    helpLines: RISK_HELP_LINES,
    match(text) {
      const match = typeof text === "string" ? RISK_COMMAND.exec(text.trim()) : null;
      if (!match?.[1]) return null;
      const taskId = match[1];
      const code = match[2];
      return (ctx) => approveRisk(deps, ctx, taskId, code);
    },
  };
}
