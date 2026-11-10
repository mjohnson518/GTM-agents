// GTM-agents: the CodingSandbox port over one Durable Object per task. The Worker side only names
// the task's sandbox and forwards each call; the sandbox itself (runner.ts) runs in the Durable
// Object that owns the container.
import { AdapterError, SHIP_TASK_ID, type CodingSandbox } from "@gtm-agents/core/ports";
import type { SandboxOptions } from "./options.ts";
import type { SandboxRpc } from "./runner.ts";

export const NAME = "sandbox-cloudflare";

/** The sandbox for one task: in a deployment, the Durable Object stub named by the task id. */
export type SandboxResolver = (taskId: string) => SandboxRpc;

export function createCodingSandbox(resolve: SandboxResolver, options: SandboxOptions): CodingSandbox {
  const sandbox = (taskId: string): SandboxRpc => {
    if (!SHIP_TASK_ID.test(taskId)) throw new AdapterError("not a ship task id", "invalid", false);
    return resolve(taskId);
  };
  return {
    name: NAME,
    limits: { ...options.limits },
    start: (taskId, stepId, step) => sandbox(taskId).begin(taskId, stepId, step),
    status: (taskId) => sandbox(taskId).report(),
    collect: (taskId) => sandbox(taskId).collect(),
    destroy: (taskId) => sandbox(taskId).teardown(),
  };
}
