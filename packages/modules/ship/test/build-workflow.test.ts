// GTM-agents: the ship build's Workflow, step by step, over a scripted sandbox, an in-memory code
// host and a step object that runs steps inline: one commit and one pull request from the approved
// spec, never a merge; the path policy and the gatekeeper on the exact files; one repair round; the
// risk approval bound to the files' digest; gates that stop a build when they close; and statuses
// that stay within the tables' CHECK values. Every repository, task and person is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@gtm-agents/core";
import { createShipBuild } from "../src/build.ts";
import { FAKE_BASE_SHA } from "../src/code-host-testing.ts";
import { resetShipTables, seedFeedback, SHIP_TEST_CHAT, SHIP_TEST_REPO } from "../src/planning-testing.ts";
import { BUILD_ON, buildRig, collectedFile, fakeStep, seedShipTask, taskState, type BuildRig, type BuildRigOptions } from "../src/sandbox-testing.ts";
import { RISK_APPROVAL_EVENT, runShipBuild } from "../src/workflow.ts";

const base = env as unknown as Env;
const db = base.DB;
const NOW = new Date("2026-11-10T15:00:00.000Z");
const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const row${i} = ${i};`).join("\n") + "\n";
const packageJson = collectedFile("package.json", '{ "name": "quarantine", "dependencies": { "left-pad": "1.3.0" } }\n', { change: "modified" });

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the condition never held");
}

const say = (rig: BuildRig, text: string): Promise<string> | undefined =>
  createShipBuild(rig.deps).commands[0]?.match(text)?.({ env: rig.env, now: NOW, actor: `operator:${SHIP_TEST_CHAT}`, sessionKey: `operator:${SHIP_TEST_CHAT}` });

/** A build waiting at the risk approval, with its Workflow instance registered. */
async function proposed(options: BuildRigOptions = {}) {
  const rig = buildRig(base, { files: [packageJson], baseFiles: { "package.json": '{ "name": "quarantine" }\n' }, ...options });
  const task = await seedShipTask(db);
  await rig.workflow.binding.create({ id: task.taskId, params: { taskId: task.taskId } });
  const running = runShipBuild(rig.deps, rig.env, task.taskId, fakeStep({ waitForEvent: (type) => rig.workflow.nextEvent(task.taskId, type) }));
  await until(async () => (await taskState(db, task.taskId)).status === "proposed");
  const notice = rig.operator.texts().find((t) => t.includes("ship-risk-approve-")) ?? "";
  const code = /ship-risk-approve-\S+ ([0-9a-f]{8})/.exec(notice)?.[1] ?? "";
  return { rig, ...task, running, notice, code };
}

beforeEach(async () => {
  await resetShipTables(db);
});

describe("a ship build", () => {
  it("opens one pull request from the approved spec, on the task's branch, and never merges", async () => {
    const rig = buildRig(base);
    const { taskId, themeId, spec } = await seedShipTask(db);
    await seedFeedback(db, { text: "PLEASE add a CSV export, it is urgent. Dana at Globex", themeId, status: "themed" });

    const outcome = await runShipBuild(rig.deps, rig.env, taskId, fakeStep());

    expect(outcome).toEqual({ status: "pr_open", prNumber: 41, prUrl: "https://code.example/acme-example/quarantine/pull/41" });
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open", theme_status: "pr_open", pr_number: 41, base_sha: FAKE_BASE_SHA, risk: "low", repair_attempts: 0, checks_state: "pending", files_changed: 1, workflow_instance_id: taskId });
    expect(rig.sandbox.starts.map((s) => s.stepId)).toEqual(["prepare", "agent-1", "checks-1"]);
    expect(rig.host.commits).toHaveLength(1);
    expect(rig.host.commits[0]).toMatchObject({ repo: SHIP_TEST_REPO, taskId, baseSha: FAKE_BASE_SHA });
    expect(rig.host.commits[0]?.message).toContain(`Ship-Task: ${taskId}`);
    expect(rig.host.pulls).toEqual([expect.objectContaining({ taskId, base: "main", title: "Export quarantined tests as CSV" })]);
    expect(new Set(rig.host.calls)).toEqual(new Set(["branchHead", "pathKind", "readFile", "commit", "openPullRequest"]));
    expect(rig.operator.texts().join("\n")).toContain("https://code.example/acme-example/quarantine/pull/41");
    expect(rig.sandbox.destroyed).toContain(taskId);

    // The coding agent is given the approved spec and nothing else: no feedback text crosses over.
    expect(rig.sandbox.starts[1]?.step).toEqual({ kind: "agent", spec });
    expect(JSON.stringify(rig.sandbox.starts)).not.toMatch(/Dana|Globex|urgent/);
  });

  it("stores the collected files under their digest and commits exactly those files", async () => {
    const rig = buildRig(base);
    const { taskId } = await seedShipTask(db);
    await runShipBuild(rig.deps, rig.env, taskId, fakeStep());
    const row = await taskState(db, taskId);
    expect(row.diff_key).toMatch(new RegExp(`^ship/${taskId}/changes-[0-9a-f]{64}\\.json$`));
    const stored = JSON.parse((await (await base.BUCKET.get(String(row.diff_key)))?.text()) ?? "{}") as { files: Array<{ path: string; content: unknown }> };
    expect(rig.host.commits[0]?.files.map((f) => [f.path, f.content])).toEqual(stored.files.map((f) => [f.path, f.content]));
    expect(await (await base.BUCKET.get(String(row.log_key)))?.text()).toBe("build log");
  });

  it("counts lines against the base commit, never with the container's own numbers", async () => {
    // The container claims one added line for a 500-line file: over the review threshold all the same.
    const rig = buildRig(base, { files: [collectedFile("src/quarantine/rows.ts", lines(500), { additions: 1, deletions: 0 })] });
    const { taskId } = await seedShipTask(db);
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toMatchObject({ status: "parked" });
    expect(await taskState(db, taskId)).toMatchObject({ lines_changed: 500, status: "parked" });
    expect(rig.host.commits).toHaveLength(0);
  });

  it("runs one repair round when the checks fail, and fails the task when they still fail", async () => {
    const repaired = buildRig(base, { script: { "checks-1": { state: "failed", exitCode: 1 } } });
    const first = await seedShipTask(db);
    expect(await runShipBuild(repaired.deps, repaired.env, first.taskId, fakeStep())).toMatchObject({ status: "pr_open" });
    expect(repaired.sandbox.starts.map((s) => s.stepId)).toEqual(["prepare", "agent-1", "checks-1", "repair-1", "checks-2"]);
    expect(repaired.sandbox.starts[3]?.step).toEqual({ kind: "repair", spec: first.spec });
    expect(await taskState(db, first.taskId)).toMatchObject({ status: "pr_open", repair_attempts: 1 });

    const broken = buildRig(base, { script: { "checks-1": { state: "failed" }, "checks-2": { state: "failed" } } });
    const second = await seedShipTask(db);
    expect(await runShipBuild(broken.deps, broken.env, second.taskId, fakeStep())).toEqual({ status: "failed", reason: "the checks still fail after one repair round" });
    expect(broken.sandbox.starts.map((s) => s.stepId)).toEqual(["prepare", "agent-1", "checks-1", "repair-1", "checks-2"]);
    expect(await taskState(db, second.taskId)).toMatchObject({ status: "failed", theme_status: "failed", repair_attempts: 1 });
    expect(broken.host.commits).toHaveLength(0);
    expect(broken.sandbox.destroyed).toContain(second.taskId);
  });

  it("refuses a change the path policy refuses, and commits nothing", async () => {
    const rig = buildRig(base, { files: [collectedFile(".github/workflows/deploy.yml", "on: push\n"), collectedFile("src/quarantine/csv.ts", "export {};\n")] });
    const { taskId } = await seedShipTask(db);
    const outcome = await runShipBuild(rig.deps, rig.env, taskId, fakeStep());
    expect(outcome).toMatchObject({ status: "refused" });
    const row = await taskState(db, taskId);
    expect(row).toMatchObject({ status: "refused", theme_status: "failed", pr_number: null });
    expect(String(row.policy_reasons)).toContain("denied path");
    expect(rig.host.commits).toHaveLength(0);
    expect(rig.host.pulls).toHaveLength(0);
    expect(rig.operator.texts().join("\n")).toContain("was refused");
  });

  it("refuses a change over the sandbox's limits, and fails one the sandbox cannot describe", async () => {
    const over = buildRig(base);
    over.sandbox.collected = { ok: false, reason: "diff_too_large", detail: "the change is larger than 2097152 bytes", log: "" };
    const first = await seedShipTask(db);
    expect(await runShipBuild(over.deps, over.env, first.taskId, fakeStep())).toMatchObject({ status: "refused" });
    expect(await taskState(db, first.taskId)).toMatchObject({ status: "refused" });

    const garbled = buildRig(base);
    garbled.sandbox.collected = { ok: false, reason: "invalid_output", detail: "a path is unsafe or repeated", log: "" };
    const second = await seedShipTask(db);
    expect(await runShipBuild(garbled.deps, garbled.env, second.taskId, fakeStep())).toMatchObject({ status: "failed" });

    const empty = buildRig(base, { files: [] });
    const third = await seedShipTask(db);
    expect(await runShipBuild(empty.deps, empty.env, third.taskId, fakeStep())).toEqual({ status: "failed", reason: "collecting the change: the agent changed nothing" });
    for (const rig of [over, garbled, empty]) expect(rig.host.commits).toHaveLength(0);
  });

  it("fails the task when the clone, the agent or a step the sandbox lost does not succeed", async () => {
    for (const [stepId, script] of [
      ["prepare", { state: "failed", exitCode: 128 }],
      ["agent-1", { state: "failed", timedOut: true, detail: "the step hit its time limit" }],
      ["agent-1", { state: "lost", detail: "the container stopped before the step ended" }],
      ["prepare", { refuse: "the image claude-code is not configured for this container" }],
    ] as const) {
      const rig = buildRig(base, { script: { [stepId]: script } });
      const { taskId } = await seedShipTask(db);
      expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep()), stepId).toMatchObject({ status: "failed" });
      expect(await taskState(db, taskId)).toMatchObject({ status: "failed", theme_status: "failed" });
      expect(rig.host.commits).toHaveLength(0);
      expect(rig.sandbox.destroyed).toContain(taskId);
    }
  });

  it("polls a running step instead of holding a call open", async () => {
    const rig = buildRig(base, { script: { "agent-1": { polls: 7 } } });
    const { taskId } = await seedShipTask(db);
    const step = fakeStep();
    expect(await runShipBuild(rig.deps, rig.env, taskId, step)).toMatchObject({ status: "pr_open" });
    expect(step.names.filter((n) => n.startsWith("agent-1 status"))).toHaveLength(8);
    expect(step.slept).toBeGreaterThanOrEqual(8 * 60_000);
  });
});

describe("a build whose branch could not be pushed", () => {
  it("stops at the load step, before any sandbox step or model call, and leaves the task queued", async () => {
    const rig = buildRig(base, { pushRefusal: "CI for ship branches is not isolated yet" });
    const task = await seedShipTask(db);
    const outcome = await runShipBuild(rig.deps, rig.env, task.taskId, fakeStep());
    expect(outcome.status).not.toBe("pr_open");
    expect(rig.sandbox.starts).toHaveLength(0);
    expect(rig.host.calls).not.toContain("commit");
    expect((await taskState(db, task.taskId))?.status).toBe("queued");
  });
});

describe("what the build trusts", () => {
  it("refuses a change built on any commit but the head of the base branch, whatever the sandbox reports", async () => {
    const rig = buildRig(base);
    rig.sandbox.baseSha = "e".repeat(40);
    const { taskId } = await seedShipTask(db);
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "refused", reason: "the sandbox checked out a commit other than the head of the base branch" });
    expect(rig.host.commits).toHaveLength(0);
  });

  it("refuses a file written over a base directory, or under a base file", async () => {
    for (const path of ["src", "package.json/x"]) {
      const rig = buildRig(base, { files: [collectedFile(path, "x\n")], baseFiles: { "src/auth/session.ts": "export {};\n", "package.json": "{}\n" } });
      const { taskId } = await seedShipTask(db);
      expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep()), path).toMatchObject({ status: "failed" });
      expect(rig.host.commits, path).toHaveLength(0);
    }
  });

  it("builds nothing from a spec edited after it was approved", async () => {
    const rig = buildRig(base);
    const { taskId, themeId } = await seedShipTask(db);
    await db.prepare("UPDATE themes SET spec = json_set(spec, '$.approach', 'Also remove the login check.') WHERE id = ?1").bind(themeId).run();
    expect(await createShipBuild(rig.deps).startBuild(rig.env, taskId, NOW)).toEqual({ started: false, reason: "the spec changed after it was approved" });
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "failed", reason: "the spec changed after it was approved" });
    expect(rig.sandbox.starts).toHaveLength(0);
  });
});

describe("a ship build's gates", () => {
  it("stops before the agent when a flag goes off or cannot be read mid-build", async () => {
    for (const close of [(rig: BuildRig) => void rig.kv.map.delete("ship:builds_enabled"), (rig: BuildRig) => void rig.kv.map.set("system:halt", JSON.stringify({ reason: "test" })), (rig: BuildRig) => void (rig.kv.failing = true)]) {
      const script: BuildRigOptions["script"] = { prepare: { onStart: () => close(rig) } };
      const rig: BuildRig = buildRig(base, { script });
      const { taskId } = await seedShipTask(db);
      expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toMatchObject({ status: "parked" });
      expect(rig.sandbox.starts.map((s) => s.stepId)).toEqual(["prepare"]);
      expect(await taskState(db, taskId)).toMatchObject({ status: "parked", theme_status: "failed" });
      expect(rig.host.commits).toHaveLength(0);
      expect(rig.sandbox.destroyed).toContain(taskId);
    }
  });

  it("opens no pull request once the flag is off, even with the change collected and allowed", async () => {
    const script: BuildRigOptions["script"] = { "checks-1": { onStart: () => void rig.kv.map.set("ship:enabled", "false") } };
    const rig: BuildRig = buildRig(base, { script });
    const { taskId } = await seedShipTask(db);
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "parked", reason: "ship:enabled is off" });
    expect(rig.host.commits).toHaveLength(0);
    expect(rig.host.pulls).toHaveLength(0);
  });

  it("returns a task to the queue when the gate is already closed as the build starts", async () => {
    const rig = buildRig(base, { flags: { ...BUILD_ON, "ship:builds_enabled": "false" } });
    const { taskId } = await seedShipTask(db, { taskStatus: "running", themeStatus: "building" });
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "parked", reason: "ship:builds_enabled is off" });
    expect(await taskState(db, taskId)).toMatchObject({ status: "queued", theme_status: "approved" });
    expect(rig.sandbox.starts).toHaveLength(0);
  });

  it("builds nothing for a task that is not queued, has no feasible spec, or targets another repository", async () => {
    const rig = buildRig(base);
    const done = await seedShipTask(db, { taskStatus: "pr_open", themeStatus: "pr_open" });
    expect(await runShipBuild(rig.deps, rig.env, done.taskId, fakeStep())).toEqual({ status: "failed", reason: "the task is pr_open" });
    expect(await taskState(db, done.taskId)).toMatchObject({ status: "pr_open", theme_status: "pr_open" });

    const infeasible = await seedShipTask(db, { spec: { feasible: false } });
    expect(await runShipBuild(rig.deps, rig.env, infeasible.taskId, fakeStep())).toMatchObject({ status: "failed" });
    expect(await taskState(db, infeasible.taskId)).toMatchObject({ status: "failed", theme_status: "failed" });

    const elsewhere = await seedShipTask(db, { repo: "initech-example/app" });
    expect(await runShipBuild(rig.deps, rig.env, elsewhere.taskId, fakeStep())).toMatchObject({ status: "failed" });
    expect(await runShipBuild(rig.deps, rig.env, "no-such-task", fakeStep())).toEqual({ status: "failed", reason: "the task does not exist" });
    expect(rig.sandbox.starts).toHaveLength(0);
    expect(rig.host.commits).toHaveLength(0);
  });

  it("does not build twice when the Workflow runs again for a task that already has its pull request", async () => {
    const rig = buildRig(base);
    const { taskId } = await seedShipTask(db);
    await runShipBuild(rig.deps, rig.env, taskId, fakeStep());
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "failed", reason: "the task is pr_open" });
    expect(rig.host.commits).toHaveLength(1);
    expect(rig.host.pulls).toHaveLength(1);
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open", theme_status: "pr_open" });
  });

  it("reaches the same single commit, pull request and notice when the Workflow replays after any step", async () => {
    const rig = buildRig(base, { script: { "checks-1": { state: "failed" }, "agent-1": { polls: 2 } } });
    const { taskId } = await seedShipTask(db);
    const journal = new Map<string, unknown>();
    let outcome: unknown;
    for (let haltAfter = 1; haltAfter < 200 && outcome === undefined; haltAfter++) {
      const step = fakeStep({ journal, haltAfter: 1 });
      outcome = await Promise.race([runShipBuild(rig.deps, rig.env, taskId, step), step.halted.then(() => undefined)]);
    }
    expect(outcome).toMatchObject({ status: "pr_open", prNumber: 41 });
    expect(rig.sandbox.starts.map((s) => s.stepId)).toEqual(["prepare", "agent-1", "checks-1", "repair-1", "checks-2"]);
    expect(rig.host.commits).toHaveLength(1);
    expect(rig.host.pulls).toHaveLength(1);
    expect(rig.operator.messages.filter((m) => m.text.startsWith("Pull request opened"))).toHaveLength(1);
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open", repair_attempts: 1 });
  });
});

describe("the risk approval", () => {
  it("holds a high-risk change as proposed until a person approves its exact files", async () => {
    const { rig, taskId, running, notice, code } = await proposed();
    expect(notice).toContain("risk high");
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect(rig.host.commits).toHaveLength(0);
    expect(await taskState(db, taskId)).toMatchObject({ status: "proposed", risk: "high", theme_status: "building" });

    expect(await say(rig, `ship-risk-approve-${taskId}`)).toContain(`ship-risk-approve-${taskId} ${code}`);
    expect(await say(rig, `ship-risk-approve-${taskId} 00000000`)).toContain("does not match");
    expect(rig.workflow.events).toHaveLength(0);

    expect(await say(rig, `ship-risk-approve-${taskId} ${code}`)).toContain("Approved");
    expect(await running).toMatchObject({ status: "pr_open" });
    expect(rig.host.commits).toHaveLength(1);
    expect(rig.host.commits[0]?.files.map((f) => f.path)).toEqual(["package.json"]);
    expect(await taskState(db, taskId)).toMatchObject({ status: "pr_open", theme_status: "pr_open", risk: "high" });
    const audit = await db.prepare("SELECT agent_id FROM audit_log WHERE action = 'ship_risk_approved'").first<{ agent_id: string }>();
    expect(audit?.agent_id).toBe(`operator:${SHIP_TEST_CHAT}`);
  });

  it("never approves a spec the planning side rated high, however small the change", async () => {
    const rig = buildRig(base);
    const { taskId } = await seedShipTask(db, { spec: { risk: "high" } });
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "parked", reason: "no risk approval arrived within 7 days" });
    expect(await taskState(db, taskId)).toMatchObject({ status: "parked", risk: "high" });
    expect(rig.host.commits).toHaveLength(0);
  });

  it("does not carry a code from one task to another", async () => {
    const first = await proposed();
    const second = await proposed();
    expect(first.code).not.toBe(second.code);
    expect(await say(second.rig, `ship-risk-approve-${second.taskId} ${first.code}`)).toContain("does not match");
    expect(second.rig.workflow.events).toHaveLength(0);
    for (const waiting of [first, second]) await (await waiting.rig.workflow.binding.get(waiting.taskId)).sendEvent({ type: RISK_APPROVAL_EVENT, payload: { digest: "none" } });
    await Promise.all([first.running, second.running]);
  });

  it("refuses an approval event that names other files, and a stored change that no longer matches its digest", async () => {
    const wrong = await proposed();
    await (await wrong.rig.workflow.binding.get(wrong.taskId)).sendEvent({ type: RISK_APPROVAL_EVENT, payload: { digest: "0".repeat(64) } });
    expect(await wrong.running).toEqual({ status: "refused", reason: "the risk approval does not name these exact files" });
    expect(wrong.rig.host.commits).toHaveLength(0);

    const swapped = await proposed();
    const key = String((await taskState(db, swapped.taskId)).diff_key);
    await base.BUCKET.put(key, JSON.stringify({ kind: "ship_changes", v: 1, files: [collectedFile("src/auth/session.ts", "export const bypass = true;\n")] }));
    expect(await say(swapped.rig, `ship-risk-approve-${swapped.taskId} ${swapped.code}`)).toContain("cannot be verified");
    expect(swapped.rig.workflow.events).toHaveLength(0);
    // Even an event sent around the command opens nothing: the gatekeeper reads the stored bytes again.
    const digest = /changes-([0-9a-f]{64})\.json$/.exec(key)?.[1] ?? "";
    await (await swapped.rig.workflow.binding.get(swapped.taskId)).sendEvent({ type: RISK_APPROVAL_EVENT, payload: { digest } });
    expect(await swapped.running).toMatchObject({ status: "failed" });
    expect(swapped.rig.host.commits).toHaveLength(0);
  });

  it("parks the build when no approval arrives, and refuses the command for a task that is not waiting", async () => {
    const rig = buildRig(base, { files: [packageJson], baseFiles: { "package.json": "{}\n" } });
    const { taskId } = await seedShipTask(db);
    expect(await runShipBuild(rig.deps, rig.env, taskId, fakeStep())).toEqual({ status: "parked", reason: "no risk approval arrived within 7 days" });
    expect(await taskState(db, taskId)).toMatchObject({ status: "parked", theme_status: "failed" });
    expect(await say(rig, `ship-risk-approve-${taskId} 00000000`)).toContain("is parked, not waiting");
    expect(await say(rig, "ship-risk-approve-no-such-task 00000000")).toContain("There is no ship task");
    expect(rig.host.commits).toHaveLength(0);
  });

  it("parks a change that needs approval when the operator cannot be asked, instead of waiting for nobody", async () => {
    const silent = buildRig(base, { files: [packageJson], baseFiles: { "package.json": "{}\n" }, without: ["operator"] });
    const first = await seedShipTask(db);
    expect(await runShipBuild(silent.deps, silent.env, first.taskId, fakeStep({ waitForEvent: () => new Promise(() => undefined) }))).toMatchObject({ status: "parked" });
    expect(silent.host.commits).toHaveLength(0);

    const failing = buildRig(base, { files: [packageJson], baseFiles: { "package.json": "{}\n" } });
    failing.operator.channel.notify = () => Promise.reject(new Error("the channel is down"));
    const second = await seedShipTask(db);
    expect(await runShipBuild(failing.deps, failing.env, second.taskId, fakeStep({ waitForEvent: () => new Promise(() => undefined) }))).toMatchObject({ status: "parked" });
    expect(failing.host.commits).toHaveLength(0);
    // The claim was released, so a later ask for the same files is not swallowed as a duplicate.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE effect LIKE 'risk:%'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("approves nothing while ship builds are off, and matches only its own command word", async () => {
    const { rig, taskId, code, running } = await proposed();
    rig.kv.map.set("ship:builds_enabled", "false");
    expect(await say(rig, `ship-risk-approve-${taskId} ${code}`)).toContain("nothing was approved");
    expect(rig.workflow.events).toHaveLength(0);
    const command = createShipBuild(rig.deps).commands[0];
    for (const text of ["ship-risk-approve", `please ship-risk-approve-${taskId} ${code}`, `ship-risk-approve-${taskId} ${code} now`, `ship-approve-${taskId} ${code}`, `ship-risk-approve-${taskId} not-a-code`]) {
      expect(command?.match(text), text).toBeNull();
    }
    rig.kv.map.set("ship:builds_enabled", "true");
    await say(rig, `ship-risk-approve-${taskId} ${code}`);
    expect(await running).toMatchObject({ status: "pr_open" });
  });
});
