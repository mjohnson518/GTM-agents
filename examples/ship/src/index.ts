// GTM-agents: an example Worker entry with the optional ship loop wired in (docs/SHIP.md). It is
// the Worker template's entry (apps/worker/src/index.ts) reduced to what the ship loop needs, plus
// the ship wiring itself. Add the ship parts to your own entry; keep your other jobs as they are.
//
// What the ship loop adds to a Worker entry:
//   - three more named exports that wrangler.jsonc refers to: the sandbox's Durable Object, its
//     egress entrypoint and the build Workflow;
//   - two adapters: code-github (the code host) and sandbox-cloudflare (the coding sandbox);
//   - createShipBuild and createShipPlanning, which hand each other what they need;
//   - the planning jobs, both sides' chat commands and the code host webhook route.
// Everything stays off until modules.ship.enabled is true in gtm.config.ts and the ship:* flags
// are on in KV. Nothing here merges a pull request: merging is always yours.
import { createWorker, type Env } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createOutreachSender, senderDepsFromEnv } from "@gtm-agents/core/sending";
import { createAdapter as createGithub } from "@gtm-agents/adapters/code-github";
import { createAdapter as createResend } from "@gtm-agents/adapters/email-resend";
import { createAdapter as createModelGateway } from "@gtm-agents/adapters/llm-gateway";
import { createAdapter as createTelegram } from "@gtm-agents/adapters/operator-telegram";
import { createAdapter as createSandbox, createShipSandbox } from "@gtm-agents/adapters/sandbox-cloudflare";
import { createShipBuild, createShipPlanning, evaluatePathPolicy, pathPolicyConfig, type ShipBuild, type ShipBuildParams, type ShipPlanning } from "@gtm-agents/modules/ship";
import config from "../gtm.config.ts";

export { FollowupAgent, OperatorGateway } from "@gtm-agents/core/durable-objects";

/** The template's bindings, plus the two the ship build adds in wrangler.jsonc. */
interface ShipEnv extends Env {
  SHIP_SANDBOX: DurableObjectNamespace;
  SHIP_BUILD: Workflow<ShipBuildParams>;
}

// The repository the ship loop works on, and the branch its pull requests target. The repository
// must also be listed in adapters.code-github.options.repos.
const REPO = "acme-example/quarantine";
const BASE_BRANCH = "main";
// Paths the loop never changes, on top of the defaults (auth, billing, CI and the like).
const DENIED_PATHS = ["migrations/**"];

const context = (env: ShipEnv, name: string) => createAdapterContext({ name, env: { ...env }, config });
const operator = (env: ShipEnv) => createTelegram(context(env, "operator-telegram"));
const model = (env: ShipEnv) => createModelGateway(context(env, "llm-gateway"));
const email = (env: ShipEnv) => createResend(context(env, "email-resend"));
const sendOutreach = (env: ShipEnv) => createOutreachSender(senderDepsFromEnv(env, { config, provider: email(env), operator: operator(env) }));

// The sandbox: one Durable Object and one container per ship task. The container starts with
// internet access off and holds no credentials; every request it makes reaches ShipSandboxEgress,
// which lets through a read-only clone, package reads and the coder model, and nothing else.
// wrangler.jsonc names both classes, so they are exported under exactly these names.
const sandboxClasses = createShipSandbox<ShipEnv>({ config });
export const ShipSandbox = sandboxClasses.Sandbox;
export const ShipSandboxEgress = sandboxClasses.Egress;

// The build side: the Workflow that runs the coding agent, the gatekeeper, the risk approval
// command and the code host webhook. It calls planning.announceShipped once a production deploy
// carries a merge commit; the arrow function and the two type annotations let the sides refer to
// each other.
const build: ShipBuild<ShipEnv> = createShipBuild<ShipEnv>({
  config,
  repo: REPO,
  baseBranch: BASE_BRANCH,
  policy: pathPolicyConfig({ repo: REPO, allowedRepos: [REPO], deniedPaths: DENIED_PATHS }),
  evaluatePolicy: evaluatePathPolicy,
  announceShipped: (env, taskId, now) => planning.announceShipped(env, taskId, now),
  codeHost: (env) => createGithub(context(env, "code-github")),
  sandbox: (env) => createSandbox(context(env, "sandbox-cloudflare"), env.SHIP_SANDBOX),
  operator,
  workflow: (env) => env.SHIP_BUILD,
  // The commands the sandbox runs in the cloned repository, as argv. Scripts stay off during the
  // install; the checks command is the one your contributors run before a pull request.
  options: { install: ["npm", "ci", "--ignore-scripts"], checks: ["npm", "run", "check"], productionEnvironments: ["production"] },
});
export const ShipBuildWorkflow = build.Workflow;

// The planning side: themes, specs, approval and the "you asked, it is live" notes.
const planning: ShipPlanning<ShipEnv> = createShipPlanning<ShipEnv>({
  config,
  repo: REPO,
  baseBranch: BASE_BRANCH,
  startBuild: build.startBuild,
  readEngineeringContract: build.readEngineeringContract,
  model,
  operator,
  send: sendOutreach,
  options: { deniedPaths: DENIED_PATHS },
});

export default createWorker<ShipEnv>(config, {
  jobs: [...planning.jobs],
  // ship-approve, ship-risk-approve and the other ship commands, answered without the model.
  commands: [...planning.commands, ...build.commands],
  // POST /api/webhooks/code: pull request, check and deployment events from the code host.
  routes: build.routes,
  operator,
  model,
  email,
  sendOutreach,
  // The CHAT_QUEUE names from wrangler.jsonc.
  agent: { chatQueue: ["gtm-agent-chat"] },
});
