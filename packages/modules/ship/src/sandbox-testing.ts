// GTM-agents: fakes for the ship build's tests: a CodingSandbox whose steps end the way a script
// says, a step object that runs the Workflow's steps inline, a Workflow binding that records
// instances and hands events to the step that waits for them, and a rig that wires them to the
// build's dependencies over the suite's D1 and R2 bindings. No container and no Workflow engine is
// involved, and every repository, task and person is invented.
import type { Env } from "@gtm-agents/core";
import { memoryKv, recordingOperator, type MemoryKvNamespace, type RecordingOperator } from "@gtm-agents/core/agents/testing";
import type { GtmConfig } from "@gtm-agents/core/config";
import type { ChangedFile, CodingCollectResult, CodingSandbox, CodingStatus, CodingStep } from "@gtm-agents/core/ports";
import { FAKE_BASE_SHA, fakeCodeHost, type FakeCodeHost } from "./code-host-testing.ts";
import { evaluatePathPolicy, pathPolicyConfig } from "./path-policy.ts";
import { hexId } from "./planning-shared.ts";
import { SHIP_ON, SHIP_TEST_REPO, seedTheme, shipTestConfig, specAnswer } from "./planning-testing.ts";
import { parseSpec, specDigest, storedSpec } from "./spec.ts";
import type { BuildStep, ShipBuildDeps, ShipBuildParams } from "./workflow.ts";

export interface StepScript {
  /** How the step ends. Defaults to succeeded. */
  state?: "succeeded" | "failed" | "lost";
  exitCode?: number;
  timedOut?: boolean;
  detail?: string;
  /** status() answers "running" this many times first. Defaults to 0. */
  polls?: number;
  /** start() refuses with this reason. */
  refuse?: string;
  /** Called when the step starts, for a test that changes something mid-build. */
  onStart?: () => void | Promise<void>;
}

export interface ScriptedSandbox extends CodingSandbox {
  /** Every step started, in order. */
  starts: Array<{ taskId: string; stepId: string; step: CodingStep }>;
  destroyed: string[];
  /** How each step id ends; a step id without a script succeeds. */
  script: Record<string, StepScript>;
  /** What collect() returns. */
  collected: CodingCollectResult;
  baseSha: string;
}

export const collectedOk = (files: ChangedFile[], log = "build log"): CodingCollectResult => ({ ok: true, files, diffBytes: files.reduce((n, f) => n + (f.content ? f.content.data.length : 0), 0), log });

/** A text file as a sandbox would collect it. The line counts are deliberately the container's own claim. */
export const collectedFile = (path: string, data: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, change: "added", additions: 1, deletions: 0, mode: "100644", binary: false, content: { encoding: "utf-8", data }, ...extra });

export function scriptedSandbox(options: { files?: ChangedFile[]; script?: Record<string, StepScript>; baseSha?: string } = {}): ScriptedSandbox {
  const current = new Map<string, { stepId: string; step: CodingStep; polled: number }>();
  const sandbox: ScriptedSandbox = {
    name: "scripted-sandbox",
    limits: { maxDiffBytes: 2 * 1024 * 1024, maxFileBytes: 512 * 1024, maxFiles: 100, maxModelTurns: 80 },
    starts: [],
    destroyed: [],
    script: options.script ?? {},
    collected: collectedOk(options.files ?? [collectedFile("src/quarantine/csv.ts", "export const csv = (rows: string[][]) => rows.map((r) => r.join(\",\")).join(\"\\n\");\n")]),
    baseSha: options.baseSha ?? FAKE_BASE_SHA,
    async start(taskId, stepId, step) {
      const scripted = sandbox.script[stepId];
      if (scripted?.refuse) return { accepted: false, reason: scripted.refuse };
      if (current.get(taskId)?.stepId === stepId) return { accepted: true, reason: "already started" };
      sandbox.starts.push({ taskId, stepId, step });
      current.set(taskId, { stepId, step, polled: 0 });
      await scripted?.onStart?.();
      return { accepted: true };
    },
    status(taskId): Promise<CodingStatus> {
      const run = current.get(taskId);
      if (!run) return Promise.resolve({ stepId: null, kind: null, state: "idle", exitCode: null, timedOut: false, baseSha: null, detail: null });
      const scripted = sandbox.script[run.stepId] ?? {};
      const base = { stepId: run.stepId, kind: run.step.kind, baseSha: sandbox.baseSha };
      if (run.polled < (scripted.polls ?? 0)) {
        run.polled += 1;
        return Promise.resolve({ ...base, state: "running", exitCode: null, timedOut: false, detail: null });
      }
      const state = scripted.state ?? "succeeded";
      return Promise.resolve({ ...base, state, exitCode: scripted.exitCode ?? (state === "succeeded" ? 0 : state === "failed" ? 1 : null), timedOut: scripted.timedOut ?? false, detail: scripted.detail ?? (state === "succeeded" ? null : `the step exited with ${scripted.exitCode ?? 1}`) });
    },
    collect: () => Promise.resolve(sandbox.collected),
    destroy(taskId) {
      sandbox.destroyed.push(taskId);
      current.delete(taskId);
      return Promise.resolve();
    },
  };
  return sandbox;
}

export interface FakeWorkflow {
  binding: Workflow<ShipBuildParams>;
  created: Array<{ id: string; params: ShipBuildParams | undefined }>;
  events: Array<{ id: string; type: string; payload: unknown }>;
  restarted: string[];
  /** The status each instance reports. Defaults to "running". */
  statuses: Map<string, InstanceStatus["status"]>;
  /** Resolves with the next event of `type` sent to instance `id`. */
  nextEvent(id: string, type: string): Promise<{ payload: unknown }>;
}

export function fakeWorkflow(): FakeWorkflow {
  const waiters = new Map<string, Array<(event: { payload: unknown }) => void>>();
  const buffered = new Map<string, Array<{ payload: unknown }>>();
  const state: FakeWorkflow = {
    created: [],
    events: [],
    restarted: [],
    statuses: new Map(),
    nextEvent(id, type) {
      const key = `${id}:${type}`;
      const ready = buffered.get(key)?.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve) => waiters.set(key, [...(waiters.get(key) ?? []), resolve]));
    },
    binding: undefined as unknown as Workflow<ShipBuildParams>,
  };
  const instance = (id: string) => ({
    id,
    status: () => Promise.resolve({ status: state.statuses.get(id) ?? "running" }),
    restart: () => {
      state.restarted.push(id);
      state.statuses.set(id, "running");
      return Promise.resolve();
    },
    sendEvent: ({ type, payload }: { type: string; payload: unknown }) => {
      state.events.push({ id, type, payload });
      const key = `${id}:${type}`;
      const waiter = waiters.get(key)?.shift();
      if (waiter) waiter({ payload });
      else buffered.set(key, [...(buffered.get(key) ?? []), { payload }]);
      return Promise.resolve();
    },
  });
  state.binding = {
    create(options?: { id?: string; params?: ShipBuildParams }) {
      const id = options?.id ?? `generated-${state.created.length + 1}`;
      if (state.created.some((c) => c.id === id)) return Promise.reject(new Error("instance.already_exists"));
      state.created.push({ id, params: options?.params });
      return Promise.resolve(instance(id));
    },
    get(id: string) {
      if (!state.created.some((c) => c.id === id)) return Promise.reject(new Error("instance.not_found"));
      return Promise.resolve(instance(id));
    },
  } as unknown as Workflow<ShipBuildParams>;
  return state;
}

export interface FakeStep extends BuildStep {
  /** The name of every step.do that ran its callback, in order. */
  names: string[];
  slept: number;
  /** Resolves when the step object stopped the run, as a hibernating Workflow stops. */
  halted: Promise<void>;
}

export interface FakeStepOptions {
  /** What a wait answers. Omitted, every wait times out, as an unanswered wait does after its timeout. */
  waitForEvent?: (type: string) => Promise<{ payload: unknown }>;
  /**
   * Results of steps that already ran, keyed by name and occurrence. A step found here returns its
   * stored result without running again, the way a Workflow replays `run` after it hibernates.
   */
  journal?: Map<string, unknown>;
  /** Stop the run (never resolve) once this many steps have run their callbacks. */
  haltAfter?: number;
}

/** Runs each step inline. With a journal, a step that already ran returns its stored result instead. */
export function fakeStep(options: FakeStepOptions = {}): FakeStep {
  const seen = new Map<string, number>();
  let ran = 0;
  let halt: () => void = () => undefined;
  const key = (kind: string, name: string): string => {
    const n = (seen.get(`${kind}:${name}`) ?? 0) + 1;
    seen.set(`${kind}:${name}`, n);
    return `${kind}:${name}#${n}`;
  };
  const step: FakeStep = {
    names: [],
    slept: 0,
    halted: new Promise<void>((resolve) => {
      halt = resolve;
    }),
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const k = key("do", name);
      if (options.journal?.has(k)) return options.journal.get(k) as T;
      if (options.haltAfter !== undefined && ran >= options.haltAfter) {
        halt();
        return new Promise<T>(() => undefined);
      }
      ran += 1;
      step.names.push(name);
      const result = await fn();
      // A Workflow stores a step's result serialized, so later code never sees the live object.
      const stored = result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as T);
      options.journal?.set(k, stored);
      return stored as T;
    },
    sleep(name, ms) {
      const k = key("sleep", name);
      if (options.journal?.has(k)) return Promise.resolve();
      options.journal?.set(k, true);
      step.slept += ms;
      return Promise.resolve();
    },
    async waitForEvent<T>(name: string, wait: { type: string; timeout: string }) {
      const k = key("wait", name);
      if (options.journal?.has(k)) return options.journal.get(k) as { payload: T };
      if (!options.waitForEvent) throw new Error(`timed out waiting for ${wait.type} after ${wait.timeout}`);
      const event = (await options.waitForEvent(wait.type)) as { payload: T };
      options.journal?.set(k, event);
      return event;
    },
  };
  return step;
}

/** Flags with the build on, beside the planning switches. */
export const BUILD_ON: Readonly<Record<string, string>> = Object.freeze({ ...SHIP_ON, "ship:builds_enabled": "true" });
export const BUILD_WEBHOOK_SECRET = "w".repeat(32);

export interface BuildRig {
  deps: ShipBuildDeps<Env>;
  env: Env;
  kv: MemoryKvNamespace;
  host: FakeCodeHost;
  sandbox: ScriptedSandbox;
  operator: RecordingOperator;
  workflow: FakeWorkflow;
  /** Task ids AnnounceShipped was called with. */
  announced: string[];
}

export interface BuildRigOptions {
  flags?: Record<string, string>;
  config?: GtmConfig;
  /** Files at the base commit. */
  baseFiles?: Record<string, string>;
  /** What the sandbox collects. */
  files?: ChangedFile[];
  script?: Record<string, StepScript>;
  announce?: (taskId: string) => Promise<void>;
  options?: ShipBuildDeps<Env>["options"];
  /** Leave an adapter or binding out, to test what fails closed. */
  without?: ReadonlyArray<"codeHost" | "sandbox" | "workflow" | "operator">;
  /** What the code host's pushRefusal answers; null (the default) allows the push. */
  pushRefusal?: string | null;
}

/** Everything the build side needs, faked, over the suite's real D1 and R2 bindings. */
export function buildRig(base: Env, options: BuildRigOptions = {}): BuildRig {
  const kv = memoryKv(options.flags ?? { ...BUILD_ON });
  const host = fakeCodeHost({ repo: SHIP_TEST_REPO, webhookSecret: BUILD_WEBHOOK_SECRET, files: options.baseFiles ?? {}, ...(options.pushRefusal ? { pushRefusal: options.pushRefusal } : {}) });
  const sandbox = scriptedSandbox({ ...(options.files ? { files: options.files } : {}), ...(options.script ? { script: options.script } : {}) });
  const operator = recordingOperator();
  const workflow = fakeWorkflow();
  const announced: string[] = [];
  const without = new Set(options.without ?? []);
  const deps: ShipBuildDeps<Env> = {
    config: options.config ?? shipTestConfig(),
    repo: SHIP_TEST_REPO,
    baseBranch: "main",
    policy: pathPolicyConfig({ repo: SHIP_TEST_REPO, allowedRepos: [SHIP_TEST_REPO] }),
    evaluatePolicy: evaluatePathPolicy,
    announceShipped: async (_env, taskId) => {
      announced.push(taskId);
      await options.announce?.(taskId);
    },
    codeHost: () => (without.has("codeHost") ? undefined : host),
    sandbox: () => (without.has("sandbox") ? undefined : sandbox),
    operator: () => (without.has("operator") ? undefined : operator.channel),
    workflow: () => (without.has("workflow") ? undefined : workflow.binding),
    ...(options.options ? { options: options.options } : {}),
  };
  return { deps, env: { ...base, KV: kv as unknown as KVNamespace }, kv, host, sandbox, operator, workflow, announced };
}

/** An approved theme with a stored spec and its queued task, as the planning side leaves them. */
export async function seedShipTask(db: D1Database, input: { taskId?: string; spec?: Record<string, unknown>; themeStatus?: string; taskStatus?: string; repo?: string; title?: string } = {}): Promise<{ taskId: string; themeId: string; spec: string }> {
  const parsed = parseSpec(specAnswer(input.spec ?? {}));
  if (!parsed) throw new Error("the test spec does not parse");
  const spec = storedSpec(parsed);
  const themeId = hexId(10);
  await seedTheme(db, { id: themeId, status: input.themeStatus ?? "approved", spec, specDigest: await specDigest(themeId, parsed), specRisk: parsed.risk, ...(input.repo ? { repo: input.repo } : {}), ...(input.title ? { title: input.title } : {}) });
  const taskId = input.taskId ?? `st_${hexId(20)}`;
  await db
    .prepare("INSERT INTO ship_tasks (id, theme_id, repo, base_branch, status, risk) VALUES (?1, ?2, ?3, 'main', ?4, ?5)")
    .bind(taskId, themeId, input.repo ?? SHIP_TEST_REPO, input.taskStatus ?? "queued", parsed.risk)
    .run();
  return { taskId, themeId, spec };
}

export async function taskState(db: D1Database, taskId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare("SELECT t.*, th.status AS theme_status, th.declined_reason FROM ship_tasks t JOIN themes th ON th.id = t.theme_id WHERE t.id = ?1").bind(taskId).first<Record<string, unknown>>();
  if (!row) throw new Error(`no task ${taskId}`);
  return row;
}
