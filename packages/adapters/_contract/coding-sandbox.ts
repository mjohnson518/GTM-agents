// GTM-agents: the shared contract every CodingSandbox adapter runs in its contract.test.ts.
//
//   runCodingSandboxContract(fixtures)
//
// Against a fake container the adapter's harness provides, it checks that:
//   - the manifest validates, declares the CodingSandbox port, and classifies running and collecting
//     as full taint (what comes out of a sandbox is untrusted);
//   - the limits stay within the build's bounds: at most 2 MB of changed content and 80 model turns;
//   - prepare starts the container with internet access off; every outbound protocol ends in a
//     catch-all intercept registered after the specific hosts, so nothing unlisted is reached;
//   - no secret value appears in the container's environment, in any command or its environment,
//     or in any file written into the container;
//   - start is idempotent per step id, refuses another step while one runs ("busy"), and refuses an
//     agent or checks step before the sandbox is prepared;
//   - status follows a step from running to succeeded or failed, marks a step that hit its time
//     limit, reports lost when the container stops, and an agent round whose own output reports a
//     failure is failed even when it exited 0;
//   - collect returns exactly the expected files, refuses oversized changes with the limit that was
//     hit, refuses malformed or unsafe collector output as invalid_output, and answers not_ready
//     before any step has finished;
//   - destroy is safe to call twice and leaves the task idle.
import { manifestSchema, type ChangedFile, type CodingCollectFailure, type CodingSandbox, type CodingStep } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";

export interface ObservedContainer {
  starts: Array<{ enableInternet: boolean; env?: Record<string, string> }>;
  commands: Array<{ argv: string[]; env: Record<string, string> }>;
  writtenFiles: Record<string, string>;
  /** Intercepts in registration order. */
  intercepts: Array<{ protocol: "http" | "https"; target: string }>;
}

export interface CodingSandboxHarness {
  sandbox: CodingSandbox;
  /** End the step running in the task's container, as the container would. */
  finish(taskId: string, exitCode: number, output?: { stdout?: string; baseSha?: string }): Promise<void>;
  /** Stop the task's container, as an eviction or a crash would. */
  stop(taskId: string): Promise<void>;
  /** What the image's collector reports next for the task, in the adapter's own format. */
  setCollectorOutput(taskId: string, output: string): void;
  observed(taskId: string): ObservedContainer;
}

export interface CodingSandboxFixtures {
  manifest: unknown;
  /** A fresh harness over a fresh fake container. */
  harness(): CodingSandboxHarness;
  /** Secret values configured in the Worker; none may reach the container. */
  secrets: readonly string[];
  taskId: string;
  baseSha: string;
  prepare: Extract<CodingStep, { kind: "prepare" }>;
  spec: string;
  checks: Extract<CodingStep, { kind: "checks" }>;
  /** Agent output that reports success, and output that reports failure despite exit code 0. */
  agentSucceeded: string;
  agentFailed: string;
  /** An exit code the adapter reports as a time-out. */
  timeoutExitCode: number;
  collected: { output: string; files: ChangedFile[] };
  oversized: Array<{ name: string; output: string; reason: CodingCollectFailure }>;
  invalid: Array<{ name: string; output: string }>;
}

export function runCodingSandboxContract(fixtures: CodingSandboxFixtures): void {
  describe("the CodingSandbox contract", () => {
    const { taskId } = fixtures;

    async function prepared(): Promise<CodingSandboxHarness> {
      const h = fixtures.harness();
      expect(await h.sandbox.start(taskId, "prepare", fixtures.prepare)).toMatchObject({ accepted: true });
      await h.finish(taskId, 0, { baseSha: fixtures.baseSha });
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "prepare", state: "succeeded", baseSha: fixtures.baseSha });
      return h;
    }

    async function agentDone(): Promise<CodingSandboxHarness> {
      const h = await prepared();
      expect(await h.sandbox.start(taskId, "agent-1", { kind: "agent", spec: fixtures.spec })).toMatchObject({ accepted: true });
      await h.finish(taskId, 0, { stdout: fixtures.agentSucceeded });
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "agent-1", state: "succeeded" });
      return h;
    }

    it("has a manifest that validates, declares the port, and treats sandbox output as full taint", () => {
      const manifest = manifestSchema.parse(fixtures.manifest);
      expect(manifest.ports).toContain("CodingSandbox");
      const tools = Object.values(manifest.tools);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) expect(tool.taint).toBe("full");
    });

    it("keeps its limits within the build's bounds", () => {
      const { limits } = fixtures.harness().sandbox;
      expect(limits.maxDiffBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(limits.maxFileBytes).toBeLessThanOrEqual(limits.maxDiffBytes);
      expect(limits.maxModelTurns).toBeLessThanOrEqual(80);
      expect(limits.maxFiles).toBeGreaterThan(0);
    });

    it("starts the container with internet access off and ends every protocol in a catch-all", async () => {
      const h = fixtures.harness();
      await h.sandbox.start(taskId, "prepare", fixtures.prepare);
      const seen = h.observed(taskId);
      expect(seen.starts.length).toBeGreaterThan(0);
      for (const start of seen.starts) expect(start.enableInternet).toBe(false);
      for (const protocol of ["http", "https"] as const) {
        const order = seen.intercepts.filter((i) => i.protocol === protocol).map((i) => i.target);
        const catchAll = order.lastIndexOf("*");
        expect(catchAll, `${protocol} has no catch-all`).toBeGreaterThanOrEqual(0);
        expect(order.slice(0, catchAll).every((t) => t !== "*"), `${protocol} registers a host after its catch-all`).toBe(true);
        expect(order.slice(catchAll + 1), `${protocol} registers a host after its catch-all`).toEqual([]);
      }
    });

    it("never gives a secret to the container", async () => {
      const h = await agentDone();
      await h.sandbox.start(taskId, "checks-1", fixtures.checks);
      await h.finish(taskId, 0);
      h.setCollectorOutput(taskId, fixtures.collected.output);
      await h.sandbox.collect(taskId);
      const seen = h.observed(taskId);
      const everything = JSON.stringify(seen);
      expect(seen.commands.length).toBeGreaterThan(0);
      for (const secret of fixtures.secrets) expect(everything.includes(secret), "a secret reached the container").toBe(false);
    });

    it("starts a step once per step id, refuses another while one runs, and refuses work before prepare", async () => {
      const h = fixtures.harness();
      expect(await h.sandbox.start(taskId, "agent-1", { kind: "agent", spec: fixtures.spec })).toMatchObject({ accepted: false });
      expect(await h.sandbox.start(taskId, "checks-1", fixtures.checks)).toMatchObject({ accepted: false });
      expect(await h.sandbox.start(taskId, "prepare", fixtures.prepare)).toEqual({ accepted: true });
      const commands = h.observed(taskId).commands.length;
      expect(await h.sandbox.start(taskId, "prepare", fixtures.prepare)).toMatchObject({ accepted: true });
      expect(h.observed(taskId).commands.length, "a repeated start ran the step again").toBe(commands);
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "prepare", state: "running" });
      expect(await h.sandbox.start(taskId, "agent-1", { kind: "agent", spec: fixtures.spec })).toEqual({ accepted: false, reason: "busy" });
    });

    it("follows a step to its end, and marks failures, time-outs and a stopped container", async () => {
      const h = await prepared();
      await h.sandbox.start(taskId, "checks-1", fixtures.checks);
      await h.finish(taskId, 2);
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "checks-1", state: "failed", exitCode: 2, timedOut: false });
      await h.sandbox.start(taskId, "checks-2", fixtures.checks);
      await h.finish(taskId, fixtures.timeoutExitCode);
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "checks-2", state: "failed", timedOut: true });
      await h.sandbox.start(taskId, "checks-3", fixtures.checks);
      await h.stop(taskId);
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "checks-3", state: "lost" });
    });

    it("fails an agent round whose own output reports a failure, even when it exited 0", async () => {
      const h = await prepared();
      await h.sandbox.start(taskId, "agent-1", { kind: "agent", spec: fixtures.spec });
      await h.finish(taskId, 0, { stdout: fixtures.agentFailed });
      expect(await h.sandbox.status(taskId)).toMatchObject({ stepId: "agent-1", state: "failed" });
    });

    it("collects exactly the changed files, and nothing before a step has finished", async () => {
      const early = fixtures.harness();
      expect(await early.sandbox.collect(taskId)).toMatchObject({ ok: false, reason: "not_ready" });
      const h = await agentDone();
      h.setCollectorOutput(taskId, fixtures.collected.output);
      const result = await h.sandbox.collect(taskId);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.files).toEqual(fixtures.collected.files);
    });

    for (const over of fixtures.oversized) {
      it(`refuses an oversized change: ${over.name}`, async () => {
        const h = await agentDone();
        h.setCollectorOutput(taskId, over.output);
        expect(await h.sandbox.collect(taskId)).toMatchObject({ ok: false, reason: over.reason });
      });
    }

    for (const bad of fixtures.invalid) {
      it(`refuses malformed collector output: ${bad.name}`, async () => {
        const h = await agentDone();
        h.setCollectorOutput(taskId, bad.output);
        expect(await h.sandbox.collect(taskId)).toMatchObject({ ok: false, reason: "invalid_output" });
      });
    }

    it("destroys idempotently and leaves the task idle", async () => {
      const h = await agentDone();
      await h.sandbox.destroy(taskId);
      await h.sandbox.destroy(taskId);
      expect(await h.sandbox.status(taskId)).toMatchObject({ state: "idle", stepId: null });
    });
  });
}
