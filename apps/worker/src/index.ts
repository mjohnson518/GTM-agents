// GTM-agents: the deployable Worker.
//
// Everything specific to your company lives in gtm.config.ts, brain/ and templates/. This file only
// wires them into the runtime: the adapters, the jobs you enable, the queue consumers and any extra
// routes. Durable Object classes must be exported from here so the bindings in wrangler.jsonc
// resolve.
//
// Every capability below is off until you turn its flag on in KV (`gtm doctor` lists them): the chat
// agent behind operator:agent_enabled, discovery behind discovery:enabled, and so on. Adapters are
// built per request or per job run, so a secret is read only when it is used.
import { createWorker, type Env } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createSourcingJobs } from "@gtm-agents/core/sourcing";
import { createAdapter as createExa } from "@gtm-agents/adapters/data-exa";
import { createAdapter as createHunter } from "@gtm-agents/adapters/data-hunter";
import { createAdapter as createModelGateway } from "@gtm-agents/adapters/llm-gateway";
import { createAdapter as createTelegram } from "@gtm-agents/adapters/operator-telegram";
import config from "../gtm.config.ts";

export { FollowupAgent, OperatorGateway } from "@gtm-agents/core/durable-objects";

const context = (env: Env, name: string) => createAdapterContext({ name, env: { ...env }, config });

// Sourcing and enrichment: discovery, the email waterfall, prescore and fit scoring.
const sourcing = createSourcingJobs<Env>({
  adapters(env) {
    const hunter = createHunter(context(env, "data-hunter"));
    return {
      sources: [createExa(context(env, "data-exa"))],
      people: hunter,
      finders: [hunter],
      verifier: hunter,
      model: createModelGateway(context(env, "llm-gateway")),
    };
  },
});

export default createWorker(config, {
  // Scheduled work. `gtm setup` generates the cron triggers in wrangler.jsonc from these schedules.
  jobs: [...sourcing],

  // Queue consumers, keyed by the queue names in wrangler.jsonc. The chat queue is wired by `agent`.
  queueConsumers: {},

  // The operator channel carries chat, approvals, job failure pages and cron health pages.
  operator: (env) => createTelegram(context(env, "operator-telegram")),
  model: (env) => createModelGateway(context(env, "llm-gateway")),
  // The CHAT_QUEUE names from wrangler.jsonc, one per environment.
  agent: { chatQueue: ["gtm-chat", "gtm-chat-staging"] },

  // Watches every critical job and pages when one is missed or failing.
  cronHealth: { schedule: "30 10,15 * * *" },
});
