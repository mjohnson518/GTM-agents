// GTM-agents: POST /api/webhooks/code, the ship build's code host webhook, through a fake code
// host: the signature is checked before any flag or database read; the task is re-resolved from the
// repository and the pull request number, the head commit or the merge commit, never from an id in
// the body; a merge, a close, a failed check and a production deploy each do exactly one thing; and
// a redelivery does nothing. Every repository, commit and task is invented.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorker, type Env } from "@gtm-agents/core";
import type { CodeHostEvent } from "@gtm-agents/core/ports";
import { createShipBuild } from "../src/build.ts";
import { fakeCodeWebhook } from "../src/code-host-testing.ts";
import { resetShipTables, shipTestConfig, SHIP_TEST_REPO } from "../src/planning-testing.ts";
import { BUILD_ON, BUILD_WEBHOOK_SECRET, buildRig, seedShipTask, taskState, type BuildRig, type BuildRigOptions } from "../src/sandbox-testing.ts";
import { handleCodeWebhook, SHIP_WEBHOOK_PATH } from "../src/webhooks.ts";

const base = env as unknown as Env;
const db = base.DB;
const NOW = new Date("2026-11-10T15:00:00.000Z");
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);
const repo = SHIP_TEST_REPO;
let delivery = 0;
const id = () => `delivery-${(delivery += 1)}`;

const pullRequest = (number: number, fields: Partial<Extract<CodeHostEvent, { type: "pull_request" }>> = {}): CodeHostEvent => ({
  type: "pull_request",
  deliveryId: id(),
  repo,
  number,
  action: "closed",
  merged: false,
  mergeCommitSha: null,
  headSha: HEAD,
  headBranch: "ship/some-task",
  baseBranch: "main",
  ...fields,
});
const merged = (number: number, sha = MERGE): CodeHostEvent => pullRequest(number, { merged: true, mergeCommitSha: sha });
const deployment = (fields: Partial<Extract<CodeHostEvent, { type: "deployment" }>> = {}): CodeHostEvent => ({ type: "deployment", deliveryId: id(), repo, sha: MERGE, environment: "production", productionEnvironment: null, state: "success", ...fields });
const check = (fields: Partial<Extract<CodeHostEvent, { type: "check" }>> = {}): CodeHostEvent => ({ type: "check", deliveryId: id(), repo, headSha: HEAD, name: "test (unit)", conclusion: "failure", pullRequests: [], ...fields });

const post = (rig: BuildRig, event: CodeHostEvent, options: { unsigned?: boolean; extra?: Record<string, unknown> } = {}) => handleCodeWebhook(rig.deps, rig.env, fakeCodeWebhook(event, { secret: BUILD_WEBHOOK_SECRET, ...options }), NOW);

/** A task whose pull request is open, as the build leaves it. */
async function openTask(number: number, headSha = HEAD): Promise<{ taskId: string; themeId: string }> {
  const task = await seedShipTask(db, { taskStatus: "pr_open", themeStatus: "pr_open" });
  await db.prepare("UPDATE ship_tasks SET pr_number = ?2, pr_url = ?3, head_sha = ?4, checks_state = 'pending' WHERE id = ?1").bind(task.taskId, number, `https://code.example/${repo}/pull/${number}`, headSha).run();
  return task;
}

/** A database that fails the test the moment anything touches it. */
const untouchable = new Proxy({} as D1Database, {
  get() {
    throw new Error("the database was read before the signature was verified");
  },
});

beforeEach(async () => {
  await resetShipTables(db);
});

describe("the code host webhook's answers", () => {
  it("answers 401 to an unsigned or wrongly signed webhook before reading any flag or the database", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    const sealed: Env = { ...rig.env, DB: untouchable, KV: new Proxy({} as KVNamespace, { get: () => { throw new Error("a flag was read before the signature was verified"); } }) };
    const unsigned = await handleCodeWebhook(rig.deps, sealed, fakeCodeWebhook(merged(41), { secret: BUILD_WEBHOOK_SECRET, unsigned: true }), NOW);
    expect(unsigned.status).toBe(401);
    const forged = await handleCodeWebhook(rig.deps, sealed, fakeCodeWebhook(merged(41), { secret: "x".repeat(32) }), NOW);
    expect(forged.status).toBe(401);
    expect(rig.host.bodiesRead).toBe(0);
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open" });
  });

  it("answers 400 to a signed body that is not an event, and 503 without an adapter or a webhook secret", async () => {
    const rig = buildRig(base);
    const garbled = new Request("https://agent.acme.example/api/webhooks/code", { method: "POST", headers: { "x-fake-code-signature": BUILD_WEBHOOK_SECRET }, body: "{}" });
    expect((await handleCodeWebhook(rig.deps, rig.env, garbled, NOW)).status).toBe(400);
    const none = buildRig(base, { without: ["codeHost"] });
    expect((await post(none, merged(41))).status).toBe(503);
    const throwing: BuildRig = { ...rig, deps: { ...rig.deps, codeHost: () => { throw new Error("GITHUB_WEBHOOK_SECRET is not set"); } } };
    expect((await post(throwing, merged(41))).status).toBe(503);
  });

  it("answers 503 and records nothing while ship is off or unreadable, after verifying the signature", async () => {
    const off: Array<[string, BuildRigOptions]> = [
      ["flag off", { flags: { ...BUILD_ON, "ship:enabled": "false" } }],
      ["flag unset", { flags: {} }],
      ["module off", { config: shipTestConfig({ modules: { ship: { enabled: false } } }) }],
    ];
    for (const [name, options] of off) {
      const rig = buildRig(base, options);
      const { taskId } = await openTask(41);
      const response = await handleCodeWebhook(rig.deps, { ...rig.env, DB: untouchable }, fakeCodeWebhook(merged(41), { secret: BUILD_WEBHOOK_SECRET }), NOW);
      expect(response.status, name).toBe(503);
      expect(rig.host.bodiesRead, name).toBe(1);
      expect(await taskState(db, taskId), name).toMatchObject({ status: "pr_open" });
      await resetShipTables(db);
    }
    const unreadable = buildRig(base);
    unreadable.kv.failing = true;
    expect((await post(unreadable, merged(41))).status).toBe(503);
  });

  it("keeps tracking pull requests while only the builds are switched off", async () => {
    const rig = buildRig(base, { flags: { ...BUILD_ON, "ship:builds_enabled": "false" } });
    const { taskId } = await openTask(41);
    expect((await post(rig, merged(41))).status).toBe(200);
    expect(await taskState(db, taskId)).toMatchObject({ status: "merged" });
  });

  it("is mounted at /api/webhooks/code by routes(app), outside the bearer token", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    const worker = createWorker<Env>(shipTestConfig(), { routes: createShipBuild(rig.deps).routes });
    const call = async (request: Request) => {
      const ctx = createExecutionContext();
      const response = await (worker.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(request, rig.env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    expect(SHIP_WEBHOOK_PATH).toBe("/api/webhooks/code");
    expect((await call(fakeCodeWebhook(merged(41), { secret: BUILD_WEBHOOK_SECRET, unsigned: true }))).status).toBe(401);
    const ok = await call(fakeCodeWebhook(merged(41), { secret: BUILD_WEBHOOK_SECRET }));
    expect(await ok.json()).toEqual({ ok: true, matched: 1, changed: 1 });
    expect(await taskState(db, taskId)).toMatchObject({ status: "merged", theme_status: "merged" });
  });
});

describe("what a code host event does", () => {
  it("marks the task and its theme merged, resolved from the repository and the pull request number", async () => {
    const rig = buildRig(base);
    const target = await openTask(41);
    const other = await openTask(42);
    // The body names another task everywhere a careless handler might look. None of it is read.
    const response = await post(rig, merged(41), { extra: { taskId: other.taskId, task_id: other.taskId, id: other.taskId, themeId: other.themeId } });
    expect(await response.json()).toEqual({ ok: true, matched: 1, changed: 1 });
    expect(await taskState(db, target.taskId)).toMatchObject({ status: "merged", theme_status: "merged", merge_commit_sha: MERGE, merged_at: NOW.toISOString() });
    expect(await taskState(db, other.taskId)).toMatchObject({ status: "pr_open", theme_status: "pr_open", merge_commit_sha: null });
  });

  it("matches nothing for a pull request it did not open, or one in another repository", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    expect(await (await post(rig, merged(77))).json()).toEqual({ ok: true, matched: 0, changed: 0 });
    expect(await (await post(rig, pullRequest(41, { repo: "initech-example/app", merged: true, mergeCommitSha: MERGE }))).json()).toEqual({ ok: true, matched: 0, changed: 0 });
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open" });
  });

  it("declines the theme when the pull request closes without merging, and restores both when it reopens", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    await post(rig, pullRequest(41));
    expect(await taskState(db, taskId)).toMatchObject({ status: "closed", theme_status: "declined", declined_reason: "the pull request was closed without merging", merge_commit_sha: null });
    await post(rig, pullRequest(41, { action: "reopened", headSha: "d".repeat(40) }));
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open", theme_status: "pr_open", head_sha: "d".repeat(40), checks_state: "pending" });
  });

  it("does nothing a second time for a redelivered event", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    const event = merged(41);
    expect(await (await post(rig, event)).json()).toEqual({ ok: true, matched: 1, changed: 1 });
    await db.prepare("UPDATE ship_tasks SET status = 'pr_open' WHERE id = ?1").bind(taskId).run();
    expect(await (await post(rig, event)).json()).toEqual({ ok: true, duplicate: true });
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open" });
  });

  it("tells the operator once per commit when a check fails, and never lets a later success hide it", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    await post(rig, check({ name: "lint", conclusion: "success" }));
    expect(await taskState(db, taskId)).toMatchObject({ checks_state: "success" });
    await post(rig, check({ name: "test\u0007 (unit)" }));
    await post(rig, check({ name: "test (e2e)" }));
    await post(rig, check({ name: "lint", conclusion: "success" }));
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open", checks_state: "failure" });
    const pages = rig.operator.messages.filter((m) => m.text.startsWith("A check failed"));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain("test (unit)");
    expect(pages[0]?.text).toContain("https://code.example/acme-example/quarantine/pull/41");
    // A check on a commit no open task has as its head changes nothing.
    expect(await (await post(rig, check({ headSha: "e".repeat(40) }))).json()).toEqual({ ok: true, matched: 0, changed: 0 });
    // New commits reset the checks, and a failure on them is told again.
    await post(rig, pullRequest(41, { action: "synchronize", headSha: "f".repeat(40) }));
    expect(await taskState(db, taskId)).toMatchObject({ head_sha: "f".repeat(40), checks_state: "pending" });
    await post(rig, check({ headSha: "f".repeat(40) }));
    expect(rig.operator.messages.filter((m) => m.text.startsWith("A check failed"))).toHaveLength(2);
  });

  it("marks the task deployed and announces it only for a successful production deploy of the merge commit", async () => {
    const rig = buildRig(base);
    const { taskId } = await openTask(41);
    // Not merged yet: a deploy of the same commit means nothing.
    await post(rig, deployment());
    expect(rig.announced).toEqual([]);
    await post(rig, merged(41));
    for (const event of [deployment({ environment: "staging" }), deployment({ environment: "preview" }), deployment({ sha: HEAD }), deployment({ state: "failure" }), deployment({ state: "pending" }), deployment({ repo: "initech-example/app" })]) {
      expect(await (await post(rig, event)).json(), JSON.stringify(event)).toMatchObject({ changed: 0 });
    }
    expect(rig.announced).toEqual([]);
    expect(await taskState(db, taskId)).toMatchObject({ status: "merged", deployed_at: null });

    expect(await (await post(rig, deployment({ environment: "Production" }))).json()).toEqual({ ok: true, matched: 1, changed: 1 });
    expect(await taskState(db, taskId)).toMatchObject({ status: "deployed", deployed_at: NOW.toISOString() });
    expect(rig.announced).toEqual([taskId]);
    // A second production deploy of the same commit announces nothing more.
    await post(rig, deployment());
    expect(rig.announced).toEqual([taskId]);
  });

  it("counts an environment the code host itself marks as production, and the environments the options name", async () => {
    const marked = buildRig(base);
    const first = await openTask(41);
    await post(marked, merged(41));
    await post(marked, deployment({ environment: "live-eu", productionEnvironment: true }));
    expect(marked.announced).toEqual([first.taskId]);

    const named = buildRig(base, { options: { productionEnvironments: ["prod"] } });
    const second = await openTask(43);
    await post(named, merged(43, "9".repeat(40)));
    await post(named, deployment({ sha: "9".repeat(40), environment: "production" }));
    expect(named.announced).toEqual([]);
    await post(named, deployment({ sha: "9".repeat(40), environment: "prod" }));
    expect(named.announced).toEqual([second.taskId]);
  });

  it("still answers 200 and keeps the task deployed when AnnounceShipped throws", async () => {
    const rig = buildRig(base, { announce: () => Promise.reject(new Error("the notes could not be drafted")) });
    const { taskId } = await openTask(41);
    await post(rig, merged(41));
    const response = await post(rig, deployment());
    expect(response.status).toBe(200);
    expect(await taskState(db, taskId)).toMatchObject({ status: "deployed" });
  });

  it("acknowledges a ping and an event the adapter ignores without touching a task", async () => {
    const rig = buildRig(base);
    expect(await (await post(rig, { type: "ping", deliveryId: id() })).json()).toEqual({ ok: true, ignored: true });
    expect(await (await post(rig, { type: "ignored", deliveryId: id(), reason: "not handled: issues" })).json()).toEqual({ ok: true, ignored: true });
  });
});
