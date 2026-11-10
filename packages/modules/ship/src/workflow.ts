// GTM-agents: the ship build as a durable Workflow. One instance per ship task, with the task id as
// its instance id, runs these steps:
//
//   1. load the task and its approved spec, and check the gates;
//   2. prepare the sandbox: a fresh container, a read-only clone of the base branch, the install;
//   3. run the coding agent on the spec, and wait for it by polling (the sandbox never holds a call open);
//   4. run the repository's checks, with one repair round when they fail;
//   5. collect the changed files, store them under their digest and stop the container;
//   6. evaluate them with the injected path policy, after normalizing them against the base commit;
//   7. when the change is high risk or needs review, ask the operator and wait up to 7 days for
//      `ship-risk-approve-<task> <code>`, whose code is bound to the digest of these exact files;
//   8. the gatekeeper re-runs the policy on the exact files, makes one commit and opens the pull request;
//   9. tell the operator.
//
// It never merges: merging code is permanently human (merge_code). The gates fail closed: the
// module switch in gtm.config.ts, ship:enabled, ship:builds_enabled and the system halt are read
// before the build starts, before each agent round and before the pull request opens, and an
// unreadable one stops the build. Bookkeeping fails open: an operator notice or audit row that
// fails is dropped. ship_tasks and themes statuses stay within their CHECK values:
//
//   ship_tasks  queued -> running -> (proposed ->) pr_open, or refused (the policy or the sandbox's
//               limits), failed (a step failed), parked (stopped by a gate, or the approval timed out)
//   themes      approved -> building -> pr_open, or failed when the task does not reach pr_open
//
// The steps are plain functions over a BuildStep, so a test drives them with a fake step object.
import type { Env } from "@gtm-agents/core";
import type { GtmConfig } from "@gtm-agents/core/config";
import { claimEffect, releaseEffect, writeAudit } from "@gtm-agents/core/events";
import { isFlagOn } from "@gtm-agents/core/jobs";
import { SHIP_TASK_ID, type CodeHost, type CodingSandbox, type CodingStatus, type CodingStep, type OperatorChannel } from "@gtm-agents/core/ports";
import { readHalt } from "@gtm-agents/core/security";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig, type WorkflowTimeoutDuration } from "cloudflare:workers";
import type { AnnounceShipped, EvaluatePathPolicy, PathPolicyConfig, Risk, ShipSpec } from "./contract.ts";
import { changesKey, decodeChanges, digestOfKey, encodeChanges, gatekeep, judge, riskCode } from "./gatekeeper.ts";
import { parseStoredSpec, specDigest, storedSpec } from "./spec.ts";

export const SHIP_ENABLED_FLAG = "ship:enabled";
export const SHIP_BUILDS_FLAG = "ship:builds_enabled";
/** The event type step 7 waits for; the risk approval command sends it. */
export const RISK_APPROVAL_EVENT = "ship-risk-approve";
export const RISK_APPROVAL_TIMEOUT = "7 days";
/** The effects-ledger event every notice for a task is claimed under. */
export const taskEffectId = (taskId: string): string => `ship-task:${taskId}`;
/** A base file larger than this is not read; its bytes count as lines instead. */
export const MAX_BASE_BYTES = 1024 * 1024;

/** How often each step is polled, and for how long. */
export const POLLS = Object.freeze({
  prepare: { intervalMs: 20_000, max: 60 },
  agent: { intervalMs: 60_000, max: 45 },
  checks: { intervalMs: 30_000, max: 40 },
});

export interface ShipBuildParams {
  taskId: string;
}

export interface ShipBuildOptions {
  /** The install command run after the clone, as argv, or null for none. */
  install: readonly string[] | null;
  /** The repository's checks command, as argv. */
  checks: readonly string[];
  /** Deployment environments that count as production, compared without case. */
  productionEnvironments: readonly string[];
  /** Files read as the repository's engineering contract; the first that exists is used. */
  contractPaths: readonly string[];
  /** Open pull requests as drafts. */
  draft: boolean;
  /** The chat notices go to. Defaults to the first allowlisted chat. */
  chatId?: string;
}

export const DEFAULT_SHIP_BUILD_OPTIONS: Readonly<ShipBuildOptions> = Object.freeze({
  // Lifecycle scripts of dependencies are not run: the install has the registry and the model
  // route open, and third-party code should not reach either. Set your own install if you need them.
  install: ["npm", "ci", "--ignore-scripts"],
  checks: ["npm", "run", "check"],
  productionEnvironments: ["production"],
  contractPaths: ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"],
  draft: false,
});

export interface ShipBuildDeps<E extends Env> {
  config: Pick<GtmConfig, "modules" | "operator">;
  /** The repository the engineering contract is read from, as owner/name. */
  repo: string;
  /** The branch the engineering contract is read from. Defaults to "main". */
  baseBranch?: string;
  /** The path policy configuration; the task's repository must be on its allowlist. */
  policy: PathPolicyConfig;
  evaluatePolicy: EvaluatePathPolicy;
  announceShipped: AnnounceShipped<E>;
  codeHost: (env: E) => CodeHost | undefined;
  sandbox: (env: E) => CodingSandbox | undefined;
  operator?: (env: E) => OperatorChannel | undefined;
  /** The Workflow binding that runs the build. */
  workflow: (env: E) => Workflow<ShipBuildParams> | undefined;
  options?: Partial<ShipBuildOptions>;
}

/** What a step of the Workflow needs from Cloudflare's WorkflowStep, so a test can pass a fake one. */
export interface BuildStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
  waitForEvent<T>(name: string, options: { type: string; timeout: string }): Promise<{ payload: T }>;
}

export type BuildOutcome = { status: "pr_open"; prNumber: number; prUrl: string } | { status: "refused" | "failed" | "parked"; reason: string };

export interface TaskRow {
  id: string;
  theme_id: string;
  repo: string;
  base_branch: string;
  base_sha: string | null;
  status: string;
  workflow_instance_id: string | null;
  diff_key: string | null;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  merge_commit_sha: string | null;
  theme_status: string;
  theme_title: string;
  spec: string | null;
  spec_digest: string | null;
}

export interface LoadedTask {
  taskId: string;
  themeId: string;
  repo: string;
  baseBranch: string;
  title: string;
  /** The approved spec as canonical JSON: the only description of the request the agent sees. */
  spec: string;
  specRisk: Risk;
}

export const resolveOptions = (options: Partial<ShipBuildOptions> | undefined): ShipBuildOptions => ({ ...DEFAULT_SHIP_BUILD_OPTIONS, ...(options ?? {}) });

/** Build from a factory, treating a throw (a missing secret, bad options) as "not configured". */
export function tryFactory<E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined {
  try {
    return factory?.(env) ?? undefined;
  } catch {
    return undefined;
  }
}

/** One line of text for an operator notice. Pure. */
export function line(text: string | null | undefined, max = 200): string {
  const out = (text ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out;
}

/**
 * The build's gates: the module in gtm.config.ts, ship:enabled, ship:builds_enabled and the system
 * halt. Any of them off or unreadable stops the build.
 */
export async function buildGate(env: Env, config: Pick<GtmConfig, "modules">): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!config.modules.ship.enabled) return { ok: false, reason: "modules.ship.enabled is off in gtm.config.ts" };
  if (!env.KV) return { ok: false, reason: "the KV binding is missing, so the flags cannot be read" };
  try {
    for (const flag of [SHIP_ENABLED_FLAG, SHIP_BUILDS_FLAG]) if (!isFlagOn(await env.KV.get(flag))) return { ok: false, reason: `${flag} is off` };
  } catch {
    return { ok: false, reason: "the ship flags could not be read" };
  }
  const halt = await readHalt(env.KV);
  if (halt.halted) return { ok: false, reason: "the system is halted" };
  return { ok: true };
}

export async function loadTaskRow(db: D1Database, taskId: string): Promise<TaskRow | null> {
  return db
    .prepare(
      `SELECT t.id, t.theme_id, t.repo, t.base_branch, t.base_sha, t.status, t.workflow_instance_id, t.diff_key, t.pr_number, t.pr_url, t.head_sha,
              t.merge_commit_sha, th.status AS theme_status, th.title AS theme_title, th.spec, th.spec_digest
         FROM ship_tasks t JOIN themes th ON th.id = t.theme_id
        WHERE t.id = ?1`,
    )
    .bind(taskId)
    .first<TaskRow>();
}

/** Moves a task from one of `from` to `to`, with extra columns. Returns whether it moved. */
export async function moveTask(db: D1Database, taskId: string, from: readonly string[], to: string, now: Date, extra: Record<string, string | number | null> = {}): Promise<boolean> {
  const columns = Object.keys(extra).filter((k) => /^[a-z_]+$/.test(k));
  const sets = ["status = ?1", "updated_at = ?2", ...columns.map((c, i) => `${c} = ?${i + 3}`)];
  const fromAt = columns.length + 3;
  const result = await db
    .prepare(`UPDATE ship_tasks SET ${sets.join(", ")} WHERE id = ?${fromAt} AND status IN (${from.map((_, i) => `?${fromAt + 1 + i}`).join(", ")})`)
    .bind(to, now.toISOString(), ...columns.map((c) => extra[c] ?? null), taskId, ...from)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Moves a theme from one of `from` to `to`. Returns whether it moved. */
export async function moveTheme(db: D1Database, themeId: string, from: readonly string[], to: string, now: Date, declinedReason?: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE themes SET status = ?1, updated_at = ?2${declinedReason !== undefined ? ", declined_reason = ?4" : ""} WHERE id = ?3 AND status IN (${from.map((_, i) => `?${i + 5}`).join(", ")})`)
    .bind(to, now.toISOString(), themeId, declinedReason ?? null, ...from)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Sends one notice about a task, at most once per `effect`. Bookkeeping: never throws. */
export async function noticeOnce<E extends Env>(deps: ShipBuildDeps<E>, env: E, taskId: string, effect: string, text: string): Promise<void> {
  try {
    const operator = tryFactory(deps.operator, env);
    if (!operator) return;
    if (!(await claimEffect(env.DB, taskEffectId(taskId), effect))) return;
    const chatId = resolveOptions(deps.options).chatId ?? deps.config.operator.allowedChatIds[0];
    await operator.notify({ text, ...(chatId ? { chatId } : {}) });
  } catch {
    // An undelivered notice is dropped; the task's status is in the database either way.
  }
}

/** The task and its spec, checked: a queued or running task, an approved theme with a feasible spec, an allowlisted repository. */
export type LoadResult =
  | { ok: true; task: LoadedTask }
  /** requeue: a gate is closed, the task goes back to queued. fail: the task cannot be built. none: there is nothing to build. */
  | { ok: false; reason: string; action: "requeue" | "fail" | "none"; themeId?: string; title?: string };

export async function loadBuild<E extends Env>(deps: ShipBuildDeps<E>, env: E, taskId: string, now: Date): Promise<LoadResult> {
  if (!SHIP_TASK_ID.test(taskId)) return { ok: false, reason: "the task id is not one the build accepts", action: "none" };
  const gate = await buildGate(env, deps.config);
  if (!gate.ok) {
    // A closed gate leaves the task queued, so StartShipBuild can run it once the gate opens.
    const waiting = await loadTaskRow(env.DB, taskId).catch(() => null);
    if (waiting && (waiting.status === "queued" || waiting.status === "running")) {
      await moveTask(env.DB, taskId, ["running"], "queued", now, { workflow_instance_id: null });
      await moveTheme(env.DB, waiting.theme_id, ["building"], "approved", now);
      return { ok: false, reason: gate.reason, action: "requeue" };
    }
    return { ok: false, reason: gate.reason, action: "none" };
  }
  const row = await loadTaskRow(env.DB, taskId);
  if (!row) return { ok: false, reason: "the task does not exist", action: "none" };
  if (row.status !== "queued" && row.status !== "running") return { ok: false, reason: `the task is ${row.status}`, action: "none" };
  const known = { themeId: row.theme_id, title: row.theme_title };
  const spec: ShipSpec | null = parseStoredSpec(row.spec);
  if (!spec || !spec.feasible) return { ok: false, reason: "the theme has no feasible spec", action: "fail", ...known };
  if (row.spec_digest !== (await specDigest(row.theme_id, spec))) return { ok: false, reason: "the spec changed after it was approved", action: "fail", ...known };
  if (row.theme_status !== "approved" && row.theme_status !== "building") return { ok: false, reason: `the theme is ${row.theme_status}, not approved`, action: "fail", ...known };
  const repo = row.repo.toLowerCase();
  const host = tryFactory(deps.codeHost, env);
  const allowed = deps.policy.allowedRepos.some((r) => r.toLowerCase() === repo) && (host?.allowedRepos() ?? []).includes(repo);
  if (!allowed) return { ok: false, reason: "the repository is not on both the path policy's and the code host's allowlist", action: "fail", ...known };
  // Refused before the sandbox starts: a build whose branch could never be pushed spends nothing.
  // The task stays queued, so it runs once the deployer opens the gate.
  const pushRefused = host ? host.pushRefusal() : "the code host adapter is not configured";
  if (pushRefused) {
    await moveTask(env.DB, taskId, ["running"], "queued", now, { workflow_instance_id: null });
    await moveTheme(env.DB, row.theme_id, ["building"], "approved", now);
    return { ok: false, reason: pushRefused, action: "requeue" };
  }
  await moveTask(env.DB, taskId, ["queued", "running"], "running", now, { workflow_instance_id: taskId });
  await moveTheme(env.DB, row.theme_id, ["approved"], "building", now);
  return { ok: true, task: { taskId, themeId: row.theme_id, repo, baseBranch: row.base_branch, title: spec.title, spec: storedSpec(spec), specRisk: spec.risk } };
}

/** Ends a task that did not reach a pull request: its status, its theme's, a notice. */
export async function endTask<E extends Env>(deps: ShipBuildDeps<E>, env: E, task: { taskId: string; themeId?: string; title?: string }, status: "refused" | "failed" | "parked", reason: string, now: Date): Promise<void> {
  const error = line(reason, 500);
  await moveTask(env.DB, task.taskId, ["queued", "running", "proposed"], status, now, { error });
  if (task.themeId) await moveTheme(env.DB, task.themeId, ["approved", "building"], "failed", now);
  await writeAudit(env.DB, { agentId: "ship", action: `ship_build_${status}`, details: { taskId: task.taskId, reason: error.slice(0, 200) }, now });
  const what = status === "refused" ? "was refused" : status === "parked" ? "is parked" : "failed";
  await noticeOnce(deps, env, task.taskId, "ended", `Ship build ${task.taskId}${task.title ? ` (${line(task.title, 80)})` : ""} ${what}: ${error}`);
}

/** Starts one sandbox step and polls it until it ends or runs out of polls. */
export async function runSandboxStep<E extends Env>(step: BuildStep, deps: ShipBuildDeps<E>, env: E, taskId: string, stepId: string, work: CodingStep, poll: { intervalMs: number; max: number }): Promise<CodingStatus> {
  const failed = (detail: string, timedOut = false): CodingStatus => ({ stepId, kind: work.kind, state: "failed", exitCode: null, timedOut, baseSha: null, detail });
  const started = await step.do(`start ${stepId}`, async () => {
    const sandbox = tryFactory(deps.sandbox, env);
    if (!sandbox) return { accepted: false, reason: "the sandbox adapter is not configured" };
    return sandbox.start(taskId, stepId, work);
  });
  if (!started.accepted) return failed(started.reason ?? "the sandbox refused the step");
  for (let i = 1; i <= poll.max; i++) {
    await step.sleep(`${stepId} wait ${i}`, poll.intervalMs);
    const status = await step.do(`${stepId} status ${i}`, async () => {
      const sandbox = tryFactory(deps.sandbox, env);
      if (!sandbox) throw new Error("the sandbox adapter is not configured");
      return sandbox.status(taskId);
    });
    if (status.stepId !== stepId) return { ...failed("the sandbox lost the step"), state: "lost" };
    if (status.state !== "running") return status;
  }
  return failed("the step did not finish in time", true);
}

export type CollectOutcome = { ok: true; key: string; digest: string; files: number; bytes: number } | { ok: false; reason: string; refused: boolean };

/** Collects the changes, stores them under their digest, records the keys and stops the container. */
export async function collectChanges<E extends Env>(deps: ShipBuildDeps<E>, env: E, taskId: string, now: Date): Promise<CollectOutcome> {
  const sandbox = tryFactory(deps.sandbox, env);
  if (!sandbox) return { ok: false, reason: "the sandbox adapter is not configured", refused: false };
  const result = await sandbox.collect(taskId);
  const logKey = `ship/${taskId}/build.log`;
  try {
    // The log is an archive for a person to read: full taint, never shown to a model.
    if (result.log) await env.BUCKET.put(logKey, result.log, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  } catch {
    // Bookkeeping fails open.
  }
  if (!result.ok) return { ok: false, reason: result.detail, refused: result.reason !== "not_ready" && result.reason !== "invalid_output" };
  if (result.files.length === 0) return { ok: false, reason: "the agent changed nothing", refused: false };
  const { text, digest } = await encodeChanges(result.files);
  const key = changesKey(taskId, digest);
  await env.BUCKET.put(key, text, { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare("UPDATE ship_tasks SET diff_key = ?1, log_key = ?2, updated_at = ?3 WHERE id = ?4").bind(key, result.log ? logKey : null, now.toISOString(), taskId).run();
  await sandbox.destroy(taskId).catch(() => undefined);
  return { ok: true, key, digest, files: result.files.length, bytes: result.diffBytes };
}

/** The stored files a key names, checked against the digest in the key. */
export async function storedChanges(bucket: R2Bucket, key: string): Promise<{ digest: string; files: Awaited<ReturnType<typeof decodeChanges>> }> {
  const digest = digestOfKey(key);
  if (!digest) throw new Error("the key does not name a change");
  const object = await bucket.get(key);
  if (!object) throw new Error("the stored change is missing");
  return { digest, files: await decodeChanges(await object.text(), digest) };
}

export type Evaluation =
  | { decision: "allow"; risk: Risk; needsApproval: boolean; reasons: string[]; filesChanged: number; linesChanged: number }
  | { decision: "refuse"; reasons: string[]; filesChanged: number; linesChanged: number };

/** Step 6: the policy on the stored files, normalized against the base commit; the verdict is recorded on the task. */
export async function evaluateChanges<E extends Env>(deps: ShipBuildDeps<E>, env: E, task: LoadedTask, key: string, baseSha: string, now: Date): Promise<Evaluation> {
  const host = tryFactory(deps.codeHost, env);
  if (!host) throw new Error("the code host adapter is not configured");
  const spec = parseStoredSpec(task.spec);
  if (!spec) throw new Error("the spec no longer parses");
  const { files } = await storedChanges(env.BUCKET, key);
  const judged = await judge({ host, evaluate: deps.evaluatePolicy, policy: deps.policy, repo: task.repo, baseSha, files, maxBaseBytes: MAX_BASE_BYTES, spec });
  const reasons = judged.verdict.reasons.slice(0, 30).map((r) => line(r, 300));
  await env.DB.prepare("UPDATE ship_tasks SET risk = ?1, policy_reasons = ?2, files_changed = ?3, lines_changed = ?4, updated_at = ?5 WHERE id = ?6")
    .bind(judged.risk, JSON.stringify(reasons), judged.verdict.filesChanged, judged.verdict.linesChanged, now.toISOString(), task.taskId)
    .run();
  if (judged.verdict.decision !== "allow" || judged.risk === null) return { decision: "refuse", reasons, filesChanged: judged.verdict.filesChanged, linesChanged: judged.verdict.linesChanged };
  return { decision: "allow", risk: judged.risk, needsApproval: judged.needsApproval, reasons, filesChanged: judged.verdict.filesChanged, linesChanged: judged.verdict.linesChanged };
}

/**
 * Step 7's ask: the task waits as proposed, and the operator gets the code for these exact files.
 * Unlike other notices this one is needed: nobody can approve a change they were never shown. It
 * returns false when the operator could not be told, after releasing its claim so a retry can ask
 * again, and the build then parks instead of waiting 7 days for an approval that cannot come.
 */
export async function askRiskApproval<E extends Env>(deps: ShipBuildDeps<E>, env: E, task: LoadedTask, digest: string, evaluation: Extract<Evaluation, { decision: "allow" }>, now: Date): Promise<boolean> {
  const operator = tryFactory(deps.operator, env);
  if (!operator) return false;
  await moveTask(env.DB, task.taskId, ["running"], "proposed", now);
  const code = await riskCode(task.taskId, digest);
  const reasons = evaluation.reasons.slice(0, 5).map((r) => `- ${r}`).join("\n");
  const text = `Ship change ${task.taskId} (${line(task.title, 80)}) needs your approval before its pull request opens: risk ${evaluation.risk}, ${evaluation.filesChanged} files, ${evaluation.linesChanged} lines.\n${reasons}\nTo open the pull request for exactly these files: ship-risk-approve-${task.taskId} ${code}\nWithout it, the build is parked in 7 days.`;
  const effect = `risk:${digest}`;
  // Already asked (a retried step): the first message stands.
  if (!(await claimEffect(env.DB, taskEffectId(task.taskId), effect))) return true;
  try {
    const chatId = resolveOptions(deps.options).chatId ?? deps.config.operator.allowedChatIds[0];
    await operator.notify({ text, ...(chatId ? { chatId } : {}) });
    return true;
  } catch {
    await releaseEffect(env.DB, taskEffectId(task.taskId), effect);
    return false;
  }
}

/** Step 8: the gatekeeper on the stored files, then the task and theme move to pr_open. */
export async function openPullRequest<E extends Env>(deps: ShipBuildDeps<E>, env: E, task: LoadedTask, key: string, baseSha: string, approvedDigest: string | null, now: Date): Promise<{ ok: true; number: number; url: string; risk: Risk; files: number; lines: number } | { ok: false; reason: string; refused: boolean }> {
  const gate = await buildGate(env, deps.config);
  if (!gate.ok) return { ok: false, reason: gate.reason, refused: false };
  const host = tryFactory(deps.codeHost, env);
  if (!host) return { ok: false, reason: "the code host adapter is not configured", refused: false };
  const spec = parseStoredSpec(task.spec);
  if (!spec) return { ok: false, reason: "the spec no longer parses", refused: true };
  const { digest, files } = await storedChanges(env.BUCKET, key);
  const result = await gatekeep({ host, evaluate: deps.evaluatePolicy, policy: deps.policy, taskId: task.taskId, repo: task.repo, baseBranch: task.baseBranch, baseSha, spec, files, digest, approvedDigest, draft: resolveOptions(deps.options).draft, maxBaseBytes: MAX_BASE_BYTES });
  if (!result.ok) return result;
  await moveTask(env.DB, task.taskId, ["running", "proposed"], "pr_open", now, { pr_number: result.pr.number, pr_url: result.pr.url, head_sha: result.pr.headSha, checks_state: "pending" });
  await moveTheme(env.DB, task.themeId, ["approved", "building"], "pr_open", now);
  await writeAudit(env.DB, { agentId: "ship", action: "ship_pr_opened", details: { taskId: task.taskId, pr: result.pr.number, commit: result.commit.commitSha, created: result.pr.created }, now });
  return { ok: true, number: result.pr.number, url: result.pr.url, risk: result.risk, files: result.filesChanged, lines: result.linesChanged };
}

/** The whole build, as the Workflow runs it. */
export async function runShipBuild<E extends Env>(deps: ShipBuildDeps<E>, env: E, taskId: string, step: BuildStep): Promise<BuildOutcome> {
  const options = resolveOptions(deps.options);
  const loaded = await step.do("load task", () => loadBuild(deps, env, taskId, new Date()));
  if (!loaded.ok) {
    if (loaded.action === "fail") {
      await step.do("end: not started", () => endTask(deps, env, { taskId, ...(loaded.themeId ? { themeId: loaded.themeId } : {}), ...(loaded.title ? { title: loaded.title } : {}) }, "failed", loaded.reason, new Date()));
      return { status: "failed", reason: loaded.reason };
    }
    if (loaded.action === "requeue") {
      await step.do("note: not started", () => noticeOnce(deps, env, taskId, "not_started", `Ship build ${taskId} did not start: ${loaded.reason}. The task stays queued.`));
      return { status: "parked", reason: loaded.reason };
    }
    return { status: "failed", reason: loaded.reason };
  }
  const task = loaded.task;
  const end = async (status: "refused" | "failed" | "parked", reason: string): Promise<BuildOutcome> => {
    await step.do(`end: ${status}`, () => endTask(deps, env, task, status, reason, new Date()));
    return { status, reason };
  };
  const gated = async (name: string): Promise<string | null> => {
    const gate = await step.do(`gate before ${name}`, () => buildGate(env, deps.config));
    return gate.ok ? null : gate.reason;
  };

  try {
    // 1-2. Clone and install. The base commit is read from the code host, never taken from the
    // container: the sandbox must report the same commit, and everything after works from this one.
    const headOfBase = await step.do("resolve base", async () => {
      const host = tryFactory(deps.codeHost, env);
      if (!host) throw new Error("the code host adapter is not configured");
      return host.branchHead(task.repo, task.baseBranch);
    });
    if (!headOfBase) return await end("failed", `the base branch ${task.baseBranch} does not exist`);
    const prepared = await runSandboxStep(step, deps, env, taskId, "prepare", { kind: "prepare", repo: task.repo, baseBranch: task.baseBranch, install: options.install }, POLLS.prepare);
    if (prepared.state !== "succeeded" || !prepared.baseSha) return await end("failed", `preparing the sandbox: ${prepared.detail ?? prepared.state}`);
    if (prepared.baseSha !== headOfBase) return await end("refused", "the sandbox checked out a commit other than the head of the base branch");
    const baseSha = headOfBase;
    await step.do("record base", async () => {
      await env.DB.prepare("UPDATE ship_tasks SET base_sha = ?1, updated_at = ?2 WHERE id = ?3").bind(baseSha, new Date().toISOString(), taskId).run();
    });

    // 3. The agent, and the wait for it.
    const closedBeforeAgent = await gated("the agent");
    if (closedBeforeAgent) return await end("parked", closedBeforeAgent);
    const agent = await runSandboxStep(step, deps, env, taskId, "agent-1", { kind: "agent", spec: task.spec }, POLLS.agent);
    if (agent.state !== "succeeded") return await end("failed", `the coding agent: ${agent.detail ?? agent.state}`);

    // 4. The checks, with one repair round.
    let checks = await runSandboxStep(step, deps, env, taskId, "checks-1", { kind: "checks", command: options.checks }, POLLS.checks);
    if (checks.state !== "succeeded") {
      const closedBeforeRepair = await gated("the repair round");
      if (closedBeforeRepair) return await end("parked", closedBeforeRepair);
      await step.do("record repair", async () => {
        await env.DB.prepare("UPDATE ship_tasks SET repair_attempts = 1, updated_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), taskId).run();
      });
      const repair = await runSandboxStep(step, deps, env, taskId, "repair-1", { kind: "repair", spec: task.spec }, POLLS.agent);
      if (repair.state !== "succeeded") return await end("failed", `the repair round: ${repair.detail ?? repair.state}`);
      checks = await runSandboxStep(step, deps, env, taskId, "checks-2", { kind: "checks", command: options.checks }, POLLS.checks);
      if (checks.state !== "succeeded") return await end("failed", "the checks still fail after one repair round");
    }

    // 5. Collect the changed files.
    const collected = await step.do("collect changes", () => collectChanges(deps, env, taskId, new Date()));
    if (!collected.ok) return await end(collected.refused ? "refused" : "failed", `collecting the change: ${collected.reason}`);

    // 6. The path policy.
    const evaluation = await step.do("evaluate policy", () => evaluateChanges(deps, env, task, collected.key, baseSha, new Date()));
    if (evaluation.decision !== "allow") return await end("refused", `the path policy refused the change: ${evaluation.reasons.slice(0, 5).join("; ")}`);

    // 7. High risk, or over the review thresholds: a person approves these exact files.
    let approvedDigest: string | null = null;
    if (evaluation.needsApproval) {
      const asked = await step.do("ask for risk approval", () => askRiskApproval(deps, env, task, collected.digest, evaluation, new Date()));
      if (!asked) return await end("parked", "the change needs a risk approval, and the operator could not be asked for it");
      let payload: { digest?: unknown } | null = null;
      try {
        payload = (await step.waitForEvent<{ digest?: unknown }>("wait for risk approval", { type: RISK_APPROVAL_EVENT, timeout: RISK_APPROVAL_TIMEOUT })).payload;
      } catch {
        return await end("parked", "no risk approval arrived within 7 days");
      }
      if (payload?.digest !== collected.digest) return await end("refused", "the risk approval does not name these exact files");
      approvedDigest = collected.digest;
    }

    // 8. The gatekeeper: the policy again on the exact files, one commit, the pull request.
    const opened = await step.do("open pull request", () => openPullRequest(deps, env, task, collected.key, baseSha, approvedDigest, new Date()));
    if (!opened.ok) return await end(opened.refused ? "refused" : "parked", opened.reason);

    // 9. Tell the operator. Merging is theirs.
    await step.do("announce pull request", () =>
      noticeOnce(deps, env, taskId, "pr_opened", `Pull request opened for ${line(task.title, 80)}: ${opened.url}\nRisk ${opened.risk}, ${opened.files} files, ${opened.lines} lines. Review and merge it yourself; the ship loop never merges.`),
    );
    return { status: "pr_open", prNumber: opened.number, prUrl: opened.url };
  } catch (error) {
    return await end("failed", `an unexpected error: ${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await step.do("stop sandbox", async () => {
      await tryFactory(deps.sandbox, env)
        ?.destroy(taskId)
        .catch(() => undefined);
    });
  }
}

const STEP_CONFIG: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };

/** Adapts Cloudflare's WorkflowStep to BuildStep. */
export function workflowStep(step: WorkflowStep): BuildStep {
  type Do = <T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>) => Promise<T>;
  const run = step.do.bind(step) as unknown as Do;
  return {
    do: (name, fn) => run(name, STEP_CONFIG, fn),
    sleep: (name, ms) => step.sleep(name, ms),
    waitForEvent: async <T>(name: string, options: { type: string; timeout: string }) => {
      const event = await step.waitForEvent<never>(name, { type: options.type, timeout: options.timeout as WorkflowTimeoutDuration });
      const payload: T = event.payload;
      return { payload };
    },
  };
}

/** The Workflow class's type: a WorkflowEntrypoint over the ship build params. */
export type ShipBuildWorkflowClass<E extends Env> = new (ctx: ExecutionContext, env: E) => WorkflowEntrypoint<E, ShipBuildParams>;

/** The Workflow class a deployer exports from the Worker entry, bound to these dependencies. */
export function createShipBuildWorkflow<E extends Env>(deps: ShipBuildDeps<E>): ShipBuildWorkflowClass<E> {
  return class ShipBuildWorkflow extends WorkflowEntrypoint<E, ShipBuildParams> {
    override async run(event: Readonly<WorkflowEvent<ShipBuildParams>>, step: WorkflowStep): Promise<BuildOutcome> {
      // The instance id is the task id: one build per task, whatever the params say.
      if (event.payload.taskId !== event.instanceId) return { status: "failed", reason: "the instance id is not the task id" };
      return runShipBuild(deps, this.env, event.instanceId, workflowStep(step));
    }
  };
}
