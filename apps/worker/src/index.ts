// GTM-agents: the deployable Worker.
//
// Everything specific to your company lives in gtm.config.ts, brain/ and templates/. This file only
// wires them into the runtime: the jobs you enable, the queue consumers and any extra routes.
// Durable Object classes must be exported from here so the bindings in wrangler.jsonc resolve.
import { createWorker } from "@gtm-agents/core";
import config from "../gtm.config.ts";

export { FollowupAgent, OperatorGateway } from "@gtm-agents/core/durable-objects";

export default createWorker(config, {
  // Scheduled work. `gtm setup` generates the cron triggers in wrangler.jsonc from these schedules.
  jobs: [],

  // Queue consumers, keyed by the queue names in wrangler.jsonc.
  queueConsumers: {},
});
