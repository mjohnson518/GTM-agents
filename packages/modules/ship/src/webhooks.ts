// GTM-agents: the ship build's code host webhook, POST /api/webhooks/code.
//
// The code host adapter verifies the signature before anything else is read: no flag, no database.
// A missing secret answers 503, a bad signature 401, a payload it cannot map 400. Only then:
//   - ship:enabled off, or unreadable, answers 503 and records nothing (the module switch in
//     gtm.config.ts likewise);
//   - each delivery is claimed once in the effects ledger by the digest of what its signature
//     covered (or its delivery id, when the adapter gives no digest), so a redelivery, or a captured
//     payload sent again under a new delivery id, does nothing; a delivery whose handling fails is
//     released, so a redelivery can try again;
//   - the task is always re-resolved from what the code host says, never from an id in the body: by
//     repository and pull request number, by repository and head commit for checks, and by
//     repository and merge commit for deploys.
// Then:
//   - a merged pull request marks the task and its theme merged, with the merge commit;
//   - a pull request closed without merging closes the task and declines the theme (reopening it
//     brings both back to pr_open); new commits on it reset the checks to pending;
//   - a failed check marks the task's checks failed and tells the operator, once per commit;
//   - a successful deploy to a production environment whose commit is the merge commit marks the
//     task deployed and calls AnnounceShipped, whose failure is logged and never fails the webhook.
import type { AppType, Env } from "@gtm-agents/core";
import { claimEffect, releaseEffect, writeAudit } from "@gtm-agents/core/events";
import { AdapterError, type CodeHostEvent } from "@gtm-agents/core/ports";
import { isFlagOn } from "@gtm-agents/core/jobs";
import { SHIP_ENABLED_FLAG, line, moveTask, moveTheme, noticeOnce, resolveOptions, tryFactory, type ShipBuildDeps } from "./workflow.ts";

export const SHIP_WEBHOOK_PATH = "/api/webhooks/code";
export const DELIVERY_EFFECT = "ship_webhook";

interface TaskRef {
  id: string;
  theme_id: string;
  status: string;
  theme_title: string;
  pr_url: string | null;
}

const SELECT_TASK = "SELECT t.id, t.theme_id, t.status, t.pr_url, th.title AS theme_title FROM ship_tasks t JOIN themes th ON th.id = t.theme_id";

/** What one verified event did, for the response and the audit row. */
export interface WebhookResult {
  matched: number;
  changed: number;
}

async function onPullRequest<E extends Env>(deps: ShipBuildDeps<E>, env: E, event: Extract<CodeHostEvent, { type: "pull_request" }>, now: Date): Promise<WebhookResult> {
  const task = await env.DB.prepare(`${SELECT_TASK} WHERE lower(t.repo) = ?1 AND t.pr_number = ?2`).bind(event.repo, event.number).first<TaskRef>();
  if (!task) return { matched: 0, changed: 0 };
  let changed = false;
  if (event.action === "closed" && event.merged && event.mergeCommitSha) {
    changed = await moveTask(env.DB, task.id, ["pr_open"], "merged", now, { merge_commit_sha: event.mergeCommitSha, merged_at: now.toISOString() });
    if (changed) await moveTheme(env.DB, task.theme_id, ["pr_open"], "merged", now);
  } else if (event.action === "closed" && !event.merged) {
    changed = await moveTask(env.DB, task.id, ["pr_open"], "closed", now);
    if (changed) await moveTheme(env.DB, task.theme_id, ["pr_open"], "declined", now, "the pull request was closed without merging");
  } else if (event.action === "reopened") {
    changed = await moveTask(env.DB, task.id, ["closed"], "pr_open", now, { head_sha: event.headSha, checks_state: "pending" });
    if (changed) await moveTheme(env.DB, task.theme_id, ["declined"], "pr_open", now);
  } else if (event.action === "synchronize") {
    changed = await moveTask(env.DB, task.id, ["pr_open"], "pr_open", now, { head_sha: event.headSha, checks_state: "pending" });
  }
  if (changed) await writeAudit(env.DB, { agentId: "ship", action: `ship_pr_${event.merged ? "merged" : event.action}`, details: { taskId: task.id, pr: event.number }, now });
  return { matched: 1, changed: changed ? 1 : 0 };
}

async function onCheck<E extends Env>(deps: ShipBuildDeps<E>, env: E, event: Extract<CodeHostEvent, { type: "check" }>, now: Date): Promise<WebhookResult> {
  if (event.conclusion !== "failure" && event.conclusion !== "success") return { matched: 0, changed: 0 };
  const { results } = await env.DB.prepare(`${SELECT_TASK} WHERE lower(t.repo) = ?1 AND t.head_sha = ?2 AND t.status = 'pr_open'`).bind(event.repo, event.headSha).all<TaskRef>();
  let changed = 0;
  for (const task of results) {
    if (event.conclusion === "failure") {
      const result = await env.DB.prepare("UPDATE ship_tasks SET checks_state = 'failure', updated_at = ?1 WHERE id = ?2").bind(now.toISOString(), task.id).run();
      changed += result.meta.changes ?? 0;
      await noticeOnce(deps, env, task.id, `checks_failed:${event.headSha}`, `A check failed on the pull request for ${line(task.theme_title, 80)}: ${line(event.name, 100)}${task.pr_url ? ` (${task.pr_url})` : ""}. Nothing merges on its own; fix or close it.`);
    } else {
      // A success never hides a failure already seen on the same commit.
      const result = await env.DB.prepare("UPDATE ship_tasks SET checks_state = 'success', updated_at = ?1 WHERE id = ?2 AND (checks_state IS NULL OR checks_state IN ('pending', 'success'))").bind(now.toISOString(), task.id).run();
      changed += result.meta.changes ?? 0;
    }
  }
  return { matched: results.length, changed };
}

async function onDeployment<E extends Env>(deps: ShipBuildDeps<E>, env: E, event: Extract<CodeHostEvent, { type: "deployment" }>, now: Date): Promise<WebhookResult> {
  if (event.state !== "success") return { matched: 0, changed: 0 };
  const production = resolveOptions(deps.options).productionEnvironments.some((name) => name.toLowerCase() === event.environment.toLowerCase()) || event.productionEnvironment === true;
  if (!production) return { matched: 0, changed: 0 };
  const { results } = await env.DB.prepare(`${SELECT_TASK} WHERE lower(t.repo) = ?1 AND t.merge_commit_sha = ?2 AND t.status = 'merged'`).bind(event.repo, event.sha).all<TaskRef>();
  let changed = 0;
  for (const task of results) {
    if (!(await moveTask(env.DB, task.id, ["merged"], "deployed", now, { deployed_at: now.toISOString() }))) continue;
    changed++;
    await writeAudit(env.DB, { agentId: "ship", action: "ship_deployed", details: { taskId: task.id, environment: line(event.environment, 60) }, now });
    try {
      await deps.announceShipped(env, task.id, now);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", msg: "ship: AnnounceShipped failed", taskId: task.id, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return { matched: results.length, changed };
}

async function shipOn<E extends Env>(deps: ShipBuildDeps<E>, env: E): Promise<boolean> {
  if (!deps.config.modules.ship.enabled || !env.KV) return false;
  try {
    return isFlagOn(await env.KV.get(SHIP_ENABLED_FLAG));
  } catch {
    return false;
  }
}

/** Handles one webhook request. Exported so a deployment can mount it under its own router. */
export async function handleCodeWebhook<E extends Env>(deps: ShipBuildDeps<E>, env: E, request: Request, now: Date): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const host = tryFactory(deps.codeHost, env);
  if (!host) return json({ error: "code_host_not_configured" }, 503);
  let event: CodeHostEvent;
  try {
    event = await host.verifyWebhook(request);
  } catch (error) {
    if (error instanceof AdapterError && error.code === "auth") return json({ error: "unauthorized" }, 401);
    if (error instanceof AdapterError && error.code === "unavailable") return json({ error: "webhook_secret_not_configured" }, 503);
    if (error instanceof AdapterError && error.code === "invalid") return json({ error: "invalid_payload" }, 400);
    return json({ error: "unverifiable" }, 401);
  }
  // Verified. Only now are the flags and the database read.
  if (!(await shipOn(deps, env))) return json({ error: "ship_disabled" }, 503);
  if (event.type === "ping" || event.type === "ignored") return json({ ok: true, ignored: true });
  // Deduplicate on what the signature covered when the adapter gives it, else on the delivery id.
  const delivery = `ship-webhook:${event.digest ?? event.deliveryId}`;
  if (!(await claimEffect(env.DB, delivery, DELIVERY_EFFECT))) return json({ ok: true, duplicate: true });
  try {
    const result =
      event.type === "pull_request" ? await onPullRequest(deps, env, event, now) : event.type === "check" ? await onCheck(deps, env, event, now) : await onDeployment(deps, env, event, now);
    return json({ ok: true, ...result });
  } catch {
    await releaseEffect(env.DB, delivery, DELIVERY_EFFECT);
    return json({ error: "not_processed" }, 500);
  }
}

/** Mounts the webhook. Pass it to createWorker's `routes`, or call it from your own `routes`. */
export function createShipRoutes<E extends Env>(deps: ShipBuildDeps<E>): (app: AppType<E>) => void {
  return (app) => {
    app.post(SHIP_WEBHOOK_PATH, (c) => handleCodeWebhook(deps, c.env, c.req.raw, new Date()));
  };
}
