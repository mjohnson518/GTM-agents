// GTM-agents: the deployable Worker.
//
// Everything specific to your company lives in gtm.config.ts, brain/ and templates/. This file only
// wires them into the runtime: the adapters, the jobs you enable, the queue consumers and any extra
// routes. Durable Object classes must be exported from here so the bindings in wrangler.jsonc
// resolve.
//
// Every capability below is off until you turn its flag on in KV (`gtm doctor` lists them): the chat
// agent behind operator:agent_enabled, discovery behind discovery:enabled, the cold batch behind
// cold_batch:enabled, real sends behind delivery:enabled, mailbox intake behind inbox:enabled,
// reply triage and drafting behind the replies:* flags, follow-ups behind sequences:enabled, and
// the scorecard and digests behind the ops:* flags, calendar sync behind convert:calendar_enabled,
// and product events and billing behind lifecycle:enabled and billing:enabled.
// Adapters are built per request or per job run, so a secret is read only when it is used.
import { createWorker, kvFlagReader, type Env } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createConvertJobs } from "@gtm-agents/core/convert";
import { createExperimentJobs } from "@gtm-agents/core/experiments";
import { createOutreachJobs } from "@gtm-agents/core/outreach";
import { createAutonomyJobs } from "@gtm-agents/core/autonomy/runtime";
import { createInboxJobs } from "@gtm-agents/core/inbox";
import { createLearningJobs, learningDashboard } from "@gtm-agents/core/learning";
import { createLifecycle, createLifecycleFollowups } from "@gtm-agents/core/lifecycle";
import { createReplyJobs } from "@gtm-agents/core/replies";
import { createReportJobs } from "@gtm-agents/core/reports";
import { createRetentionJob } from "@gtm-agents/core/runtime";
import { createDeliveryJobs, createOutreachSender, readColdVolume, senderDepsFromEnv } from "@gtm-agents/core/sending";
import { createSequenceJobs } from "@gtm-agents/core/sequences";
import { createSignalJobs, handleMonitorWebhook, type MonitorConfig } from "@gtm-agents/core/signals";
import { createSourcingJobs } from "@gtm-agents/core/sourcing";
import { createAdapter as createExa, parseMonitorDelivery, verifyMonitorSignature } from "@gtm-agents/adapters/data-exa";
import { createAdapter as createJobBoards } from "@gtm-agents/adapters/data-jobboards";
import { createAdapter as createHunter } from "@gtm-agents/adapters/data-hunter";
import { createAdapter as createStripe } from "@gtm-agents/adapters/billing-stripe";
import { createAdapter as createGoogleCalendar } from "@gtm-agents/adapters/calendar-google";
import { createAdapter as createRoutedMail } from "@gtm-agents/adapters/email-cloudflare";
import { createAdapter as createResend } from "@gtm-agents/adapters/email-resend";
import { createAdapter as createGmail } from "@gtm-agents/adapters/inbox-gmail";
import { createAdapter as createModelGateway } from "@gtm-agents/adapters/llm-gateway";
import { createAdapter as createTelegram } from "@gtm-agents/adapters/operator-telegram";
import config from "../gtm.config.ts";

export { FollowupAgent, OperatorGateway } from "@gtm-agents/core/durable-objects";

const context = (env: Env, name: string) => createAdapterContext({ name, env: { ...env }, config });
const operator = (env: Env) => createTelegram(context(env, "operator-telegram"));
const model = (env: Env) => createModelGateway(context(env, "llm-gateway"));
const email = (env: Env) => createResend(context(env, "email-resend"));
// The warm mailbox: replies arrive here, reply drafts are mirrored here, and approved replies are sent
// from here. Cold mail and follow-ups never go through it.
const inbox = (env: Env) => createGmail(context(env, "inbox-gmail"));
// The calendar, read-only: only event times and attendees, never titles or descriptions.
const calendar = (env: Env) => createGoogleCalendar(context(env, "calendar-google"));

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

// Signals: websets, search monitors, dated news, hiring boards, responder lookalikes and coverage fill,
// each behind its own signals:* flag (docs/SIGNALS.md). Add your monitors here: each names its key, the
// Worker secret that signs its deliveries, and whether its results are company sites or articles.
const monitors: readonly MonitorConfig[] = [];
const signals = createSignalJobs<Env>({
  adapters(env) {
    const exa = createExa(context(env, "data-exa"));
    return { discovery: exa, similar: exa, news: exa, boards: createJobBoards(context(env, "data-jobboards")), people: createHunter(context(env, "data-hunter")) };
  },
  options: { monitors },
});

// Outreach: the daily cold batch, with today's volume from the warm-up ramp.
const outreach = createOutreachJobs<Env>({
  send: sendOutreach,
  volume: async (env, { flags }) => (await readColdVolume({ kv: env.KV, flags })).volume,
  model,
  operator,
});

// Experiments: evaluation twice a day and the weekly rule-based self-review, behind experiments:* flags
// (docs/EXPERIMENTS.md). Nothing changes copy or weights without your approval.
const experiments = createExperimentJobs<Env>({
  operator,
  volume: async (env, { flags }) => (await readColdVolume({ kv: env.KV, flags })).volume,
  options: { signalSources: [] },
});

// Delivery: the deferred queue replay, the bounce monitor, the ramp and liveness.
const delivery = createDeliveryJobs<Env>({ email, operator });

// Inbox: polling, the safety-net sweep and the push watch renewal. No model calls.
const inboxJobs = createInboxJobs<Env>({ inbox, operator });

// How long a reply counts as owed. The reply jobs, the reports and /scorecard share it.
const owedWindowDays = 14;

// Replies: triage, drafting, approved sends, mailbox mirroring and the reply-owed reminders.
const replies = createReplyJobs<Env>({ model, inbox, operator, options: { owedWindowDays } });

// Sequences: the follow-up sweep and the weekend stale-sequence check.
const sequences = createSequenceJobs<Env>({ email, operator, model });

// Reports: the daily scorecard, the Monday funnel digest and the weekday cost digest. No model calls.
const reports = createReportJobs<Env>({ operator, options: { owedWindowDays } });

// Convert: calendar sync, meeting follow-ups and deal handoff briefs. Nothing is sent automatically.
const convert = createConvertJobs<Env>({ calendar, operator });

// Lifecycle: product events and billing move contacts and deals (docs/LIFECYCLE.md). The events
// queues are the EVENTS_QUEUE names gtm setup creates. Pass `billing: (env) => adapter` once you have
// a BillingProvider adapter; MRR comes from the amounts billing events carry.
const lifecycle = createLifecycle<Env>({
  eventsQueue: ["gtm-agent-events", "gtm-agent-staging-events"],
  billing: (env) => createStripe(context(env, "billing-stripe")),
});

// Lifecycle follow-ups: nudges to product users from approved lifecycle templates, each under its
// autonomy class; offers (upgrade, win-back) are always drafts a person approves.
const followups = createLifecycleFollowups<Env>({ send: sendOutreach, model, operator });

// Autonomy: the weekly review proposes level changes (behind autonomy_review:enabled; only a person
// confirms them), and the hourly watch demotes a class after an incident. Demotion has no flag.
const autonomy = createAutonomyJobs<Env>({ operator });

// Self-improvement: edit mining, the voice profile, the retrospective, agent review, objection
// answers, fitness, the benchmark and evolution, each behind its own learning:* flag. Every loop only
// proposes; a person approves the exact text (docs/LEARNING.md).
const learning = createLearningJobs<Env>({ model, operator });

// Housekeeping: old run rows are deleted daily once ops:retention_enabled is on.
const retention = createRetentionJob<Env>();

export default createWorker(config, {
  // Scheduled work. One per-minute cron trigger runs whichever of these jobs is due that minute.
  jobs: [...sourcing, ...signals, ...outreach, ...delivery, ...inboxJobs, ...replies, ...sequences, ...reports, ...convert, ...lifecycle.jobs, ...followups.jobs, ...autonomy, ...experiments, ...learning, retention],

  // Queue consumers, keyed by the queue names in wrangler.jsonc. The chat queue is wired by `agent`.
  queueConsumers: {},

  // Search monitor deliveries: each is verified against its own Worker secret before anything is read.
  routes(app) {
    app.post("/api/webhooks/search/:key", (c) =>
      handleMonitorWebhook(c.req.raw, c.req.param("key"), {
        db: c.env.DB,
        flags: kvFlagReader(c.env.KV),
        monitors,
        secret: (name) => {
          const value = (c.env as unknown as Record<string, unknown>)[name];
          return typeof value === "string" && value.length > 0 ? value : undefined;
        },
        verify: verifyMonitorSignature,
        parse: parseMonitorDelivery,
        now: new Date(),
      }),
    );
  },

  // The operator channel carries chat, approvals, batch releases, job failure pages and cron health pages.
  operator,
  model,
  email,
  sendOutreach,
  inbox,
  lifecycle,
  // The operator dashboard at /admin, behind Cloudflare Access (docs/DASHBOARD.md): learning
  // proposals, fitness and the learnings summary come from the learning module.
  dashboard: learningDashboard<Env>(),
  // Mail that Cloudflare Email Routing delivers to this Worker. Add `forwardTo` with a verified
  // destination address to keep a copy in a mailbox (docs/INBOX.md).
  inboundEmail: { parser: (env) => createRoutedMail(context(env, "email-cloudflare")) },
  // The CHAT_QUEUE names from wrangler.jsonc, one per environment (`gtm setup` names them
  // <worker name>-chat). Change these if you rename the Worker or the queues.
  agent: { chatQueue: ["gtm-agent-chat", "gtm-agent-staging-chat"], owedWindowDays },

  // The JOBS queue names from wrangler.jsonc (`gtm setup` names them <worker name>-jobs and -jobs-dlq).
  // With scheduler:queue_enabled on, each due job runs in its own queue consumer invocation.
  scheduler: { jobsQueue: ["gtm-agent-jobs", "gtm-agent-staging-jobs"], deadLetterQueue: ["gtm-agent-jobs-dlq", "gtm-agent-staging-jobs-dlq"] },

  // Watches every critical job and pages when one is missed or failing.
  cronHealth: { schedule: "30 10,15 * * *" },
});
