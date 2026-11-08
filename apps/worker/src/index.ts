// GTM-agents: the deployable Worker.
//
// Everything specific to your company lives in gtm.config.ts, brain/ and templates/. This file only
// wires them into the runtime: the adapters, the jobs you enable, the queue consumers and any extra
// routes. Durable Object classes must be exported from here so the bindings in wrangler.jsonc
// resolve.
//
// Every capability below is off until you turn its flag on in KV (`gtm doctor` lists them): the chat
// agent behind operator:agent_enabled, discovery behind discovery:enabled, the cold batch behind
// cold_batch:enabled, and real sends behind delivery:enabled. Adapters are built per request or per
// job run, so a secret is read only when it is used.
import { createWorker, type Env } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createOutreachJobs } from "@gtm-agents/core/outreach";
import { createDeliveryJobs, createOutreachSender, readColdVolume, senderDepsFromEnv } from "@gtm-agents/core/sending";
import { createSourcingJobs } from "@gtm-agents/core/sourcing";
import { createAdapter as createExa } from "@gtm-agents/adapters/data-exa";
import { createAdapter as createHunter } from "@gtm-agents/adapters/data-hunter";
import { createAdapter as createResend } from "@gtm-agents/adapters/email-resend";
import { createAdapter as createModelGateway } from "@gtm-agents/adapters/llm-gateway";
import { createAdapter as createTelegram } from "@gtm-agents/adapters/operator-telegram";
import config from "../gtm.config.ts";

export { FollowupAgent, OperatorGateway } from "@gtm-agents/core/durable-objects";

const context = (env: Env, name: string) => createAdapterContext({ name, env: { ...env }, config });
const operator = (env: Env) => createTelegram(context(env, "operator-telegram"));
const model = (env: Env) => createModelGateway(context(env, "llm-gateway"));
const email = (env: Env) => createResend(context(env, "email-resend"));

// The send function: every boundary check (halt, kill switch, suppression, lint, verification,
// approval digest, send window, caps, circuit breaker) runs inside it.
const sendOutreach = (env: Env) => createOutreachSender(senderDepsFromEnv(env, { config, provider: email(env), operator: operator(env) }));

// Sourcing and enrichment: discovery, the email waterfall, prescore and fit scoring.
const sourcing = createSourcingJobs<Env>({
  adapters(env) {
    const hunter = createHunter(context(env, "data-hunter"));
    return { sources: [createExa(context(env, "data-exa"))], people: hunter, finders: [hunter], verifier: hunter, model: model(env) };
  },
});

// Outreach: the daily cold batch, with today's volume from the warm-up ramp.
const outreach = createOutreachJobs<Env>({
  send: sendOutreach,
  volume: async (env, { flags }) => (await readColdVolume({ kv: env.KV, flags })).volume,
  model,
  operator,
});

// Delivery: the deferred queue replay, the bounce monitor, the ramp and liveness.
const delivery = createDeliveryJobs<Env>({ email, operator });

export default createWorker(config, {
  // Scheduled work. `gtm setup` generates the cron triggers in wrangler.jsonc from these schedules.
  jobs: [...sourcing, ...outreach, ...delivery],

  // Queue consumers, keyed by the queue names in wrangler.jsonc. The chat queue is wired by `agent`.
  queueConsumers: {},

  // The operator channel carries chat, approvals, batch releases, job failure pages and cron health pages.
  operator,
  model,
  email,
  sendOutreach,
  // The CHAT_QUEUE names from wrangler.jsonc, one per environment.
  agent: { chatQueue: ["gtm-chat", "gtm-chat-staging"] },

  // Watches every critical job and pages when one is missed or failing.
  cronHealth: { schedule: "30 10,15 * * *" },
});
