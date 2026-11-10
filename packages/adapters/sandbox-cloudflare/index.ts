// GTM-agents: the sandbox-cloudflare adapter: the CodingSandbox port on Cloudflare Containers, for
// the optional ship module (docs/SHIP.md). A coding agent edits a read-only clone in a container
// that holds no credentials and reaches only what the Worker lets through.
//
// What a deployer exports from the Worker entry (examples/ship shows the wiring):
//
//   const sandbox = createShipSandbox({ config });
//   export const ShipSandbox = sandbox.Sandbox;              // the Durable Object that owns the container
//   export const ShipSandboxEgress = sandbox.Egress;         // the entrypoint every request from the container reaches
//
// and builds the port with createAdapter(context, env.SHIP_SANDBOX).
//
// Specifically:
//   - each task has its own Durable Object, named by the task id, and its own container, started
//     with internet access off. A build always starts a fresh container;
//   - the container reaches the git host (a read-only clone of the task's repository, closed again
//     once the clone is done), the package registries (GET only) and the profile's model API. Every
//     other request is denied. egress.ts holds the rules, including the model handler: flags, halt
//     and budget checked first (fail closed), at most 80 model turns per task, the model rewritten to
//     the coder model, server-side tools stripped, the key attached, the reported usage recorded in
//     the cost ledger (fire and forget) under job ship_build and run ship:<task>;
//   - each step runs in the background through ship-run in the image, with a time limit, so the
//     caller polls status() instead of holding a long call open. The container stops after 45
//     minutes without a call;
//   - collect() runs ship-collect in the image, which writes the changes against the recorded base
//     commit, and validates its output in the Worker: paths, modes, encodings and sizes (2 MB in all,
//     512 KB a file and 100 files by default; options can only lower them);
//   - the agent profile (claude-code by default, or opencode) is chosen in the options, and each
//     has its own image under images/<profile>/Dockerfile.
//
// Secrets (read by the egress entrypoint only, never given to the container): GITHUB_TOKEN for the
// clone, and the model key: ANTHROPIC_API_KEY, or OPENAI_API_KEY for opencode with modelApi
// "openai" (options.modelKeySecret renames it). AI_GATEWAY_TOKEN when modelBaseUrl is a gateway.
// Options (adapters.sandbox-cloudflare.options):
//   profile         "claude-code" (default) or "opencode"
//   modelApi        opencode only: "anthropic" (default) or "openai" (a Chat Completions API)
//   modelHost       the hostname the agent calls; defaults to the vendor's API host
//   modelBaseUrl    where the Worker forwards model calls, in place of the API's /v1 prefix, for
//                   example an AI Gateway provider URL; defaults to the vendor's API
//   modelKeySecret  the Worker secret holding the model key
//   byok            with an authenticated AI Gateway, send no vendor key and let the gateway add its own
//   gitHost         defaults to github.com
//   registryHosts   defaults to ["registry.npmjs.org"]
//   instance        the container instance type; defaults to standard-2
//   dailySpendCents the cap on a UTC day's model spend across every task, in cents; defaults to
//                   2000. The flag budget:job:ship_build:daily_cents can lower it; each task also
//                   stops at budget:run_ceiling_cents
//   limits          { maxDiffBytes, maxFileBytes, maxFiles, maxModelTurns }, each only lowered
//   timeouts        { prepare, agent, checks } in seconds
import { Files } from "@cloudflare/sandbox";
import type { ModelPrice } from "@gtm-agents/core/budget";
import type { GtmConfig } from "@gtm-agents/core/config";
import type { AdapterContext, CodingCollectResult, CodingSandbox, CodingStatus, CodingStep } from "@gtm-agents/core/ports";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { handleEgress, type EgressProps } from "./egress.ts";
import { createEgressContext, type EgressSetup, type ShipSandboxEnv } from "./egress-context.ts";
import { INACTIVITY_TIMEOUT_MS, readSandboxOptions, type SandboxOptions } from "./options.ts";
import { NAME, createCodingSandbox } from "./port.ts";
import { AGENT_PROFILES } from "./profiles.ts";
import { SandboxRunner, type ContainerLike, type ModelTurn, type SandboxRpc } from "./runner.ts";

export { NAME, createCodingSandbox } from "./port.ts";
export type { SandboxResolver } from "./port.ts";
export { DEFAULT_DAILY_SPEND_CENTS, DEFAULT_LIMITS, DEFAULT_TIMEOUTS, INACTIVITY_TIMEOUT_MS, MAX_MODEL_TURNS, PROFILES, readSandboxOptions } from "./options.ts";
export type { ModelApi, ProfileName, SandboxOptions } from "./options.ts";
export { AGENT_PROFILES, roundPrompt } from "./profiles.ts";
export type { AgentProfile } from "./profiles.ts";
export { fetchesRemoteContent, handleEgress, rewriteModelRequest } from "./egress.ts";
export type { EgressContext, EgressProps, EgressRoute } from "./egress.ts";
export { SHIP_BUILD_JOB, createEgressContext, shipRunId } from "./egress-context.ts";
export type { EgressSetup, ShipSandboxEnv } from "./egress-context.ts";
export { SandboxRunner, parseCollected } from "./runner.ts";
export type { ContainerLike, FilesLike, RunnerStore, SandboxRpc } from "./runner.ts";

export const DEFAULT_SANDBOX_BINDING = "SHIP_SANDBOX";
export const DEFAULT_EGRESS_EXPORT = "ShipSandboxEgress";

export interface ShipSandboxSetup {
  /** The deployment's gtm.config.ts: the coder model, its price and this adapter's options. */
  config: Pick<GtmConfig, "models" | "adapters">;
  /** The Durable Object binding for the Sandbox class, as named in wrangler.jsonc. Defaults to SHIP_SANDBOX. */
  binding?: string;
  /** The name the Egress class is exported under from the Worker entry. Defaults to ShipSandboxEgress. */
  egressExport?: string;
}

function setupOf(setup: ShipSandboxSetup): { options: SandboxOptions; coderModel: string | null; price: ModelPrice | undefined; binding: string; egressExport: string } {
  const options = readSandboxOptions(setup.config.adapters[NAME]?.options ?? {});
  const coderModel = setup.config.models.roles.coder ?? null;
  return {
    options,
    coderModel,
    price: coderModel ? setup.config.models.pricing[coderModel] : undefined,
    binding: setup.binding ?? DEFAULT_SANDBOX_BINDING,
    egressExport: setup.egressExport ?? DEFAULT_EGRESS_EXPORT,
  };
}

/** What the sandbox Durable Object answers over RPC: the steps, and each task's model turns. */
export interface ShipSandboxRpc extends SandboxRpc {
  takeModelTurn(limit: number, maxInFlight: number): Promise<ModelTurn>;
  releaseModelTurn(ticket: string): Promise<void>;
}

/** The two classes a deployment exports from its Worker entry. */
export interface ShipSandboxClasses<E extends ShipSandboxEnv> {
  /** The Durable Object with the container, bound in wrangler.jsonc (SHIP_SANDBOX by default). */
  Sandbox: new (ctx: DurableObjectState, env: E) => DurableObject<E> & ShipSandboxRpc;
  /** The egress entrypoint every request from the container goes through (exported as ShipSandboxEgress by default). */
  Egress: new (ctx: ExecutionContext<EgressProps>, env: E) => WorkerEntrypoint<E, EgressProps>;
}

/**
 * The Durable Object and the egress entrypoint, bound to this deployment's config. Export both from
 * the Worker entry under the names wrangler.jsonc uses.
 */
export function createShipSandbox<E extends ShipSandboxEnv = ShipSandboxEnv>(setup: ShipSandboxSetup): ShipSandboxClasses<E> {
  const resolved = setupOf(setup);
  const profile = AGENT_PROFILES[resolved.options.profile];
  const egressSetup: EgressSetup = { options: resolved.options, coderModel: resolved.coderModel, price: resolved.price, provider: profile.provider(resolved.options.model), binding: resolved.binding };

  class Sandbox extends DurableObject<E> implements ShipSandboxRpc {
    readonly #runner: SandboxRunner;

    constructor(ctx: DurableObjectState, env: E) {
      super(ctx, env);
      const container = ctx.container;
      if (!container) throw new Error("the ShipSandbox Durable Object has no container; add it to containers in wrangler.jsonc");
      const exported = (ctx.exports as unknown as Record<string, ((options: { props: EgressProps }) => Fetcher) | undefined>)[resolved.egressExport];
      this.#runner = new SandboxRunner({
        container: container as ContainerLike,
        files: new Files(container),
        store: ctx.storage.kv,
        egress: (props) => {
          if (!exported) throw new Error(`the Worker entry does not export ${resolved.egressExport}`);
          return exported({ props });
        },
        options: resolved.options,
        profile,
        coderModel: resolved.coderModel,
        name: ctx.id.name ?? null,
        now: () => new Date(),
      });
      // A restarted Durable Object sets the inactivity timeout again for a container that kept running.
      if (container.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }

    begin(taskId: string, stepId: string, step: CodingStep): Promise<{ accepted: boolean; reason?: string }> {
      return this.ctx.blockConcurrencyWhile(() => this.#runner.begin(taskId, stepId, step));
    }

    report(): Promise<CodingStatus> {
      return this.#runner.report();
    }

    collect(): Promise<CodingCollectResult> {
      return this.#runner.collect();
    }

    teardown(): Promise<void> {
      return this.#runner.teardown();
    }

    takeModelTurn(limit: number, maxInFlight: number): Promise<ModelTurn> {
      return Promise.resolve(this.#runner.takeTurn(limit, maxInFlight, Date.now()));
    }

    releaseModelTurn(ticket: string): Promise<void> {
      this.#runner.releaseTurn(ticket, Date.now());
      return Promise.resolve();
    }
  }

  class Egress extends WorkerEntrypoint<E, EgressProps> {
    override fetch(request: Request): Promise<Response> {
      const props = this.ctx.props;
      const context = createEgressContext(egressSetup, this.env, props, { fetch: (input, init) => fetch(input, init), waitUntil: (promise) => this.ctx.waitUntil(promise) });
      return handleEgress(request, props, context);
    }
  }

  return { Sandbox, Egress };
}

/**
 * The CodingSandbox port, over the Sandbox Durable Object namespace. `ctx.options` are this
 * adapter's options from gtm.config.ts.
 */
export function createAdapter(ctx: AdapterContext, namespace: DurableObjectNamespace): CodingSandbox {
  const options = readSandboxOptions(ctx.options);
  return createCodingSandbox((taskId) => namespace.getByName(taskId) as unknown as SandboxRpc, options);
}
