// GTM-agents: StartShipBuild and the engineering contract reader: one Workflow instance per task,
// with the task id as its id, however often it is asked; nothing started while a flag is off or
// unreadable, the system is halted, or a binding or adapter is missing; and the target repository's
// contract read from its base branch. Every repository and task is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@gtm-agents/core";
import { createShipBuild } from "../src/build.ts";
import { resetShipTables, shipTestConfig, SHIP_TEST_REPO } from "../src/planning-testing.ts";
import { BUILD_ON, buildRig, seedShipTask, taskState } from "../src/sandbox-testing.ts";

const base = env as unknown as Env;
const db = base.DB;
const NOW = new Date("2026-11-10T15:00:00.000Z");

beforeEach(async () => {
  await resetShipTables(db);
});

describe("StartShipBuild", () => {
  it("starts one Workflow instance whose id is the task id, however often it is called", async () => {
    const rig = buildRig(base);
    const { startBuild } = createShipBuild(rig.deps);
    const { taskId } = await seedShipTask(db);

    expect(await startBuild(rig.env, taskId, NOW)).toEqual({ started: true });
    expect(await startBuild(rig.env, taskId, NOW)).toEqual({ started: true, reason: "already started" });
    expect(await startBuild(rig.env, taskId, NOW)).toEqual({ started: true, reason: "already started" });

    expect(rig.workflow.created).toEqual([{ id: taskId, params: { taskId } }]);
    expect(await taskState(db, taskId)).toMatchObject({ status: "running", theme_status: "building", workflow_instance_id: taskId });
  });

  it("finds the build another call created a moment earlier instead of starting a second", async () => {
    const rig = buildRig(base);
    const { startBuild } = createShipBuild(rig.deps);
    const { taskId } = await seedShipTask(db);
    const [first, second] = await Promise.all([startBuild(rig.env, taskId, NOW), startBuild(rig.env, taskId, NOW)]);
    expect(first.started && second.started).toBe(true);
    expect(rig.workflow.created).toHaveLength(1);
  });

  it("starts nothing while the module, a flag or the halt says no, or cannot be read", async () => {
    const cases: Array<[string, Parameters<typeof buildRig>[1], RegExp]> = [
      ["ship:enabled off", { flags: { ...BUILD_ON, "ship:enabled": "false" } }, /ship:enabled is off/],
      ["ship:enabled unset", { flags: { "ship:builds_enabled": "true" } }, /ship:enabled is off/],
      ["ship:builds_enabled unset", { flags: { "ship:enabled": "true" } }, /ship:builds_enabled is off/],
      ["halted", { flags: { ...BUILD_ON, "system:halt": JSON.stringify({ reason: "test" }) } }, /halted/],
      ["module off in the config", { config: shipTestConfig({ modules: { ship: { enabled: false } } }) }, /modules\.ship\.enabled/],
    ];
    for (const [name, options, reason] of cases) {
      const rig = buildRig(base, options);
      const { taskId } = await seedShipTask(db);
      const result = await createShipBuild(rig.deps).startBuild(rig.env, taskId, NOW);
      expect(result.started, name).toBe(false);
      expect(result.reason, name).toMatch(reason);
      expect(rig.workflow.created, name).toHaveLength(0);
      expect(await taskState(db, taskId), name).toMatchObject({ status: "queued", theme_status: "approved" });
    }

    const unreadable = buildRig(base);
    unreadable.kv.failing = true;
    const { taskId } = await seedShipTask(db);
    expect(await createShipBuild(unreadable.deps).startBuild(unreadable.env, taskId, NOW)).toEqual({ started: false, reason: "the ship flags could not be read" });
    expect(unreadable.workflow.created).toHaveLength(0);
  });

  it("starts nothing when a binding or an adapter is missing", async () => {
    for (const [missing, reason] of [
      ["workflow", /Workflow binding is missing/],
      ["codeHost", /code host adapter is not configured/],
      ["sandbox", /sandbox adapter is not configured/],
    ] as const) {
      const rig = buildRig(base, { without: [missing] });
      const { taskId } = await seedShipTask(db);
      const result = await createShipBuild(rig.deps).startBuild(rig.env, taskId, NOW);
      expect(result.started, missing).toBe(false);
      expect(result.reason, missing).toMatch(reason);
      expect(rig.workflow.created, missing).toHaveLength(0);
    }
    const rig = buildRig(base);
    const { taskId } = await seedShipTask(db);
    const noKv = { ...rig.env, KV: undefined as unknown as KVNamespace };
    expect(await createShipBuild(rig.deps).startBuild(noKv, taskId, NOW)).toMatchObject({ started: false });
    const noBucket = { ...rig.env, BUCKET: undefined as unknown as R2Bucket };
    expect(await createShipBuild(rig.deps).startBuild(noBucket, taskId, NOW)).toEqual({ started: false, reason: "the DB or BUCKET binding is missing" });
    expect(rig.workflow.created).toHaveLength(0);
  });

  it("starts nothing while the code host would refuse to push the ship branch, so no budget is spent on it", async () => {
    const rig = buildRig(base, { pushRefusal: "CI for ship branches is not isolated yet" });
    const { taskId } = await seedShipTask(db);
    expect(await createShipBuild(rig.deps).startBuild(rig.env, taskId, NOW)).toEqual({ started: false, reason: "CI for ship branches is not isolated yet" });
    expect(rig.workflow.created).toHaveLength(0);
    expect((await taskState(db, taskId))?.status).toBe("queued");
  });

  it("refuses a task that does not exist, is not queued, has no feasible spec, or targets another repository", async () => {
    const rig = buildRig(base);
    const { startBuild } = createShipBuild(rig.deps);
    expect(await startBuild(rig.env, "st_missing", NOW)).toEqual({ started: false, reason: "there is no such task" });
    expect((await startBuild(rig.env, "../etc/passwd", NOW)).started).toBe(false);
    const merged = await seedShipTask(db, { taskStatus: "merged", themeStatus: "merged" });
    expect(await startBuild(rig.env, merged.taskId, NOW)).toEqual({ started: false, reason: "the task is merged, not queued" });
    const infeasible = await seedShipTask(db, { spec: { feasible: false } });
    expect(await startBuild(rig.env, infeasible.taskId, NOW)).toEqual({ started: false, reason: "the theme has no feasible spec" });
    const declined = await seedShipTask(db, { themeStatus: "declined" });
    expect(await startBuild(rig.env, declined.taskId, NOW)).toEqual({ started: false, reason: "the theme is declined, not approved" });
    const elsewhere = await seedShipTask(db, { repo: "initech-example/app" });
    expect((await startBuild(rig.env, elsewhere.taskId, NOW)).reason).toMatch(/allowlist/);
    expect(rig.workflow.created).toHaveLength(0);
  });

  it("restarts a finished instance when its task is still queued, and leaves a live one alone", async () => {
    const rig = buildRig(base);
    const { startBuild } = createShipBuild(rig.deps);
    const { taskId } = await seedShipTask(db);
    await rig.workflow.binding.create({ id: taskId, params: { taskId } });
    rig.workflow.statuses.set(taskId, "complete");
    expect(await startBuild(rig.env, taskId, NOW)).toEqual({ started: true, reason: "restarted" });
    expect(rig.workflow.restarted).toEqual([taskId]);

    const live = await seedShipTask(db);
    await rig.workflow.binding.create({ id: live.taskId, params: { taskId: live.taskId } });
    expect(await startBuild(rig.env, live.taskId, NOW)).toEqual({ started: true, reason: "already started" });
    expect(rig.workflow.restarted).toEqual([taskId]);
  });
});

describe("the engineering contract reader", () => {
  it("reads the first contract file on the base branch, capped, and null when there is none", async () => {
    const rig = buildRig(base, { baseFiles: { "AGENTS.md": "# Acme engineering rules\nRun the checks.\n" } });
    expect(await createShipBuild(rig.deps).readEngineeringContract(rig.env)).toBe("# Acme engineering rules\nRun the checks.\n");

    const both = buildRig(base, { baseFiles: { "CLAUDE.md": "first", "AGENTS.md": "second" } });
    expect(await createShipBuild(both.deps).readEngineeringContract(both.env)).toBe("first");

    const long = buildRig(base, { baseFiles: { "CLAUDE.md": "x".repeat(100_000) } });
    expect((await createShipBuild(long.deps).readEngineeringContract(long.env))?.length).toBe(64 * 1024);

    expect(await createShipBuild(buildRig(base).deps).readEngineeringContract(base)).toBeNull();
    const noHost = buildRig(base, { without: ["codeHost"], baseFiles: { "CLAUDE.md": "first" } });
    expect(await createShipBuild(noHost.deps).readEngineeringContract(noHost.env)).toBeNull();
  });

  it("refuses to be built for a repository or branch that is not one", () => {
    const rig = buildRig(base);
    expect(() => createShipBuild({ ...rig.deps, repo: "not a repo" })).toThrow(/owner\/name/);
    expect(() => createShipBuild({ ...rig.deps, baseBranch: "ship/other" })).toThrow(/baseBranch/);
    expect(() => createShipBuild({ ...rig.deps, options: { checks: [] } })).toThrow(/checks/);
    expect(createShipBuild(rig.deps).commands.map((c) => c.module)).toEqual(["ship"]);
    expect(SHIP_TEST_REPO).toMatch(/\//);
  });
});
