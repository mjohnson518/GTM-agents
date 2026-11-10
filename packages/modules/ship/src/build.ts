// GTM-agents: the ship module's build side, in one factory:
//
//   const build = createShipBuild<Env>({ config, repo, policy, evaluatePolicy, announceShipped,
//     codeHost, sandbox, operator, workflow, options });
//
// It returns StartShipBuild (the planning side calls it once a spec is approved), the engineering
// contract reader the planning side writes specs with, the operator command for risk approvals, the
// webhook route, and the Workflow class to export from the Worker entry. docs/SHIP.md describes the
// whole build; workflow.ts holds its steps.
//
// StartShipBuild fails closed: with the module off in gtm.config.ts, ship:enabled or
// ship:builds_enabled off or unreadable, the system halted, a binding or adapter missing, or a task
// that is not queued with an approved, feasible spec for an allowlisted repository, it starts
// nothing and says why. It is idempotent per task: the Workflow instance id is the task id, so a
// second call finds the first build instead of starting another, and a build that ended while its
// task was still queued (a gate closed in between) is restarted.
import type { Env } from "@gtm-agents/core";
import { writeAudit } from "@gtm-agents/core/events";
import type { ModuleCommand } from "@gtm-agents/core/operator";
import { SHIP_TASK_ID } from "@gtm-agents/core/ports";
import type { AppType } from "@gtm-agents/core";
import type { StartShipBuild } from "./contract.ts";
import { createRiskApproveCommand } from "./risk.ts";
import { parseStoredSpec, specDigest } from "./spec.ts";
import { createShipRoutes } from "./webhooks.ts";
import { buildGate, createShipBuildWorkflow, loadTaskRow, moveTask, moveTheme, resolveOptions, tryFactory, type ShipBuildDeps, type ShipBuildWorkflowClass } from "./workflow.ts";

/** At most this much of the engineering contract is returned. */
export const CONTRACT_MAX_BYTES = 64 * 1024;
const TERMINAL: ReadonlySet<string> = new Set(["complete", "errored", "terminated"]);

export interface ShipBuild<E extends Env> {
  startBuild: StartShipBuild<E>;
  /**
   * The target repository's engineering contract (the first of options.contractPaths on the base
   * branch), or null when there is none or it cannot be read. Repository text is written by other
   * people: full taint. Fence it as data; never put it in a system prompt.
   */
  readEngineeringContract: (env: E) => Promise<string | null>;
  commands: ModuleCommand<E>[];
  routes: (app: AppType<E>) => void;
  /** Export it from the Worker entry under the class name the Workflow binding names. */
  Workflow: ShipBuildWorkflowClass<E>;
}

export function createStartBuild<E extends Env>(deps: ShipBuildDeps<E>): StartShipBuild<E> {
  return async (env, taskId, now) => {
    const refuse = (reason: string) => ({ started: false, reason });
    if (!SHIP_TASK_ID.test(taskId)) return refuse("the task id is not one the build accepts (letters, digits, '-' and '_', at most 64)");
    const gate = await buildGate(env, deps.config);
    if (!gate.ok) return refuse(gate.reason);
    if (!env.DB || !env.BUCKET) return refuse("the DB or BUCKET binding is missing");
    const workflow = tryFactory(deps.workflow, env);
    if (!workflow) return refuse("the ship build Workflow binding is missing");
    const host = tryFactory(deps.codeHost, env);
    if (!host) return refuse("the code host adapter is not configured");
    // A build whose branch could never be pushed would spend its whole budget first.
    const pushRefused = host.pushRefusal();
    if (pushRefused) return refuse(pushRefused);
    if (!tryFactory(deps.sandbox, env)) return refuse("the sandbox adapter is not configured");

    let row: Awaited<ReturnType<typeof loadTaskRow>>;
    try {
      row = await loadTaskRow(env.DB, taskId);
    } catch {
      return refuse("the task could not be read");
    }
    if (!row) return refuse("there is no such task");
    if (row.status === "running" && row.workflow_instance_id === taskId) return { started: true, reason: "already started" };
    if (row.status !== "queued") return refuse(`the task is ${row.status}, not queued`);
    const repo = row.repo.toLowerCase();
    if (!deps.policy.allowedRepos.some((r) => r.toLowerCase() === repo) || !host.allowedRepos().includes(repo)) return refuse("the repository is not on both the path policy's and the code host's allowlist");
    const spec = parseStoredSpec(row.spec);
    if (!spec || !spec.feasible) return refuse("the theme has no feasible spec");
    if (row.spec_digest !== (await specDigest(row.theme_id, spec))) return refuse("the spec changed after it was approved");
    if (row.theme_status !== "approved" && row.theme_status !== "building") return refuse(`the theme is ${row.theme_status}, not approved`);

    let reason: string | undefined;
    try {
      await workflow.create({ id: taskId, params: { taskId } });
    } catch {
      // The id is taken: this task's build exists. Restart it only when it ended with the task still queued.
      try {
        const instance = await workflow.get(taskId);
        const { status } = await instance.status();
        if (TERMINAL.has(status)) {
          await instance.restart();
          reason = "restarted";
        } else {
          reason = "already started";
        }
      } catch {
        return refuse("the Workflow could not be started");
      }
    }
    try {
      await moveTask(env.DB, taskId, ["queued"], "running", now, { workflow_instance_id: taskId });
      await moveTheme(env.DB, row.theme_id, ["approved"], "building", now);
    } catch {
      // The Workflow's first step moves them as well.
    }
    await writeAudit(env.DB, { agentId: "ship", action: "ship_build_started", details: { taskId, ...(reason ? { reason } : {}) }, now });
    return reason ? { started: true, reason } : { started: true };
  };
}

export function createShipBuild<E extends Env>(deps: ShipBuildDeps<E>): ShipBuild<E> {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(deps.repo)) throw new Error(`ship build: repo must be owner/name, not ${JSON.stringify(deps.repo)}`);
  if (typeof deps.evaluatePolicy !== "function" || typeof deps.announceShipped !== "function") throw new Error("ship build: evaluatePolicy and announceShipped are required");
  const options = resolveOptions(deps.options);
  if (!Array.isArray(options.checks) || options.checks.length === 0) throw new Error("ship build: options.checks must be a command, as argv");
  const baseBranch = deps.baseBranch ?? "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(baseBranch) || baseBranch.includes("..") || baseBranch.startsWith("ship/")) throw new Error("ship build: baseBranch is not a branch a ship change can target");

  return {
    startBuild: createStartBuild(deps),
    async readEngineeringContract(env) {
      const host = tryFactory(deps.codeHost, env);
      if (!host) return null;
      for (const path of options.contractPaths) {
        try {
          const file = await host.readFile({ repo: deps.repo, path, ref: baseBranch, maxBytes: CONTRACT_MAX_BYTES * 4 });
          if (!file || file.encoding !== "utf-8" || file.data === null) continue;
          const bytes = new TextEncoder().encode(file.data);
          return bytes.length <= CONTRACT_MAX_BYTES ? file.data : new TextDecoder().decode(bytes.slice(0, CONTRACT_MAX_BYTES));
        } catch {
          return null;
        }
      }
      return null;
    },
    commands: [createRiskApproveCommand(deps)],
    routes: createShipRoutes(deps),
    Workflow: createShipBuildWorkflow(deps),
  };
}
