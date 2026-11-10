// GTM-agents: createWorker(), which turns a deployment's config, jobs, queue consumers and routes
// into the Worker's fetch, scheduled and queue handlers.
//
// Built in:
//   - GET /health, and /admin/* served from the ASSETS binding, with headers that forbid framing;
//   - bearer authentication on every /api/* route except /api/webhooks/*, which verify their own
//     signatures (an unset GATEWAY_TOKEN answers 503: the gate fails closed);
//   - POST /api/webhooks/operator and the chat queue consumer, which run the operator agent when
//     the `operator` and `model` factories are given and the operator:agent_enabled flag is on,
//     with any chat commands optional modules contribute (`commands`);
//   - POST /api/webhooks/email, the email provider's delivery events (answers 503 until the `email`
//     factory is given), and GET and POST /u/:token, the one-click unsubscribe link (GET confirms,
//     POST opts out). docs/SENDING.md covers both;
//   - POST /api/webhooks/mail, the mailbox's push wake-up (shared secret first; answers 503 until
//     MAIL_PUSH_SECRET and the `inbox` factory are set), and the email() entry point for mail that
//     Cloudflare Email Routing delivers, when `inboundEmail` is given. docs/INBOX.md covers both;
//   - POST /api/webhooks/product (the host's signed events; 503 until PRODUCT_WEBHOOK_SECRET and the
//     `lifecycle` wiring are set) and POST /api/webhooks/billing (through the billing adapter; 503
//     until `lifecycle.billing` is given), and the EVENTS_QUEUE consumer that routes what they
//     record. docs/LIFECYCLE.md covers them;
//   - the JOBS_QUEUE consumer and its dead-letter consumer, when the binding is declared: each due
//     job runs in its own queue invocation (packages/core/src/jobs/queue.ts);
//   - GET /ws, the operator dashboard's WebSocket: Cloudflare Access verified at the Worker (no
//     bearer token), then handed to the OperatorGateway Durable Object. It answers 503 until the
//     admin section and the admin:enabled flag are set. docs/DASHBOARD.md covers it.
import type { TemplateFile } from "./templates/index.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GtmConfig } from "./config/schema.ts";
import type { Env } from "./env.ts";
import { bearerAuth } from "./http/auth.ts";
import { normalizeCron } from "./jobs/cron.ts";
import { inRunOrder, isFlagOn, runJobsConcurrently, type JobOutcome, type JobRunner } from "./jobs/loop.ts";
import { JOBS_QUEUE_FLAG, createJobsConsumer, createJobsDeadLetterConsumer, enqueueDueJobs, isJobMessage, runClaimedJobs } from "./jobs/queue.ts";
import { MAX_JOB_DURATION_MS, SCHEDULER_CRON, createJobRegistry, type FlagReader, type JobContext, type JobDefinition, type JobLogger, type JobRegistry, type RegisteredJob } from "./jobs/registry.ts";
import { createInboundEmailHandler, type InboundEmailHandler, type InboundEmailOptions } from "./inbox/email-handler.ts";
import { MAIL_WEBHOOK_PATH, createInboxPushWebhook } from "./inbox/webhook.ts";
import { createChatConsumer, isChatMessage } from "./operator/chat.ts";
import type { ModuleCommand } from "./operator/module-commands.ts";
import { OPERATOR_WEBHOOK_PATH, createOperatorWebhook } from "./operator/webhook.ts";
import type { EmailProvider, InboxProvider } from "./ports/email.ts";
import type { ModelGateway } from "./ports/model.ts";
import type { OperatorChannel } from "./ports/operator.ts";
import type { SendOutreach } from "./sending/types.ts";
import { createCronHealthJob } from "./runtime/cron-health.ts";
import { createJobRunner } from "./runtime/job-runner.ts";
import { UNSUBSCRIBE_ROUTE, createUnsubscribeHandlers } from "./sending/unsubscribe.ts";
import { EMAIL_WEBHOOK_PATH, createEmailWebhook } from "./sending/webhook.ts";
import { BILLING_WEBHOOK_PATH, createBillingWebhook } from "./billing/webhook.ts";
import { createEventConsumer, isEventMessage } from "./events/consumer.ts";
import type { LifecycleWiring } from "./lifecycle/jobs.ts";
import { PRODUCT_WEBHOOK_PATH, createProductWebhook } from "./product-bridge/webhook.ts";
import { GATEWAY_PATH, createGatewayRoute } from "./gateway/route.ts";
import { registerGateway, type DashboardExtensions } from "./gateway/wiring.ts";

export const MAX_BODY_BYTES = 100 * 1024;

/**
 * Wall time one scheduled invocation plans for. Cloudflare ends a cron invocation after 15 minutes;
 * a due job whose ceiling would run past this budget is not started, and its run row says why.
 */
export const SCHEDULED_WALL_BUDGET_MS = MAX_JOB_DURATION_MS;

/**
 * The chat queue's name when `agent.chatQueue` is not set. `gtm setup` names the queue it creates
 * `<worker>-chat` and prints that name; list it (one per environment) in `agent.chatQueue`.
 */
export const DEFAULT_CHAT_QUEUE = "gtm-chat";

/** The events queue's name when `lifecycle.eventsQueue` is not set. `gtm setup` names it `<worker>-events`. */
export const DEFAULT_EVENTS_QUEUE = "gtm-events";

/** The jobs queue's name when `scheduler.jobsQueue` is not set. `gtm setup` names it `<worker>-jobs`. */
export const DEFAULT_JOBS_QUEUE = "gtm-jobs";

/** The jobs dead-letter queue's name when `scheduler.deadLetterQueue` is not set. `gtm setup` names it `<worker>-jobs-dlq`. */
export const DEFAULT_JOBS_DEAD_LETTER_QUEUE = "gtm-jobs-dlq";

export interface SchedulerOptions {
  /**
   * The name of the queue bound as JOBS_QUEUE, as declared in wrangler.jsonc, or a list when each
   * environment uses its own. Defaults to "gtm-jobs".
   */
  jobsQueue?: string | readonly string[];
  /** The jobs queue's dead-letter queue, or a list. Defaults to "gtm-jobs-dlq". */
  deadLetterQueue?: string | readonly string[];
}

export interface OperatorAgentWorkerOptions {
  /**
   * The name of the queue bound as CHAT_QUEUE, as declared in wrangler.jsonc, or a list when each
   * environment uses its own (production and staging). Defaults to "gtm-chat".
   */
  chatQueue?: string | readonly string[];
  /** Model rounds per turn. Defaults to 8. */
  maxRounds?: number;
  /** Output tokens per model call. Defaults to 8192. */
  maxTokens?: number;
  /** Templates bundled with the Worker, for the experiment commands; without them templates come from KV. */
  templates?: readonly TemplateFile[];
  /** The reply window given to createReplyJobs, so /scorecard counts owed replies the same way. */
  owedWindowDays?: number;
  /** The fetch web_fetch uses. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export type AppType<E extends Env = Env> = Hono<{ Bindings: E }>;

export type QueueConsumer<E extends Env = Env> = (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void>;

export interface CreateWorkerOptions<E extends Env = Env> {
  jobs?: Array<JobDefinition<E> | RegisteredJob<E>>;
  /** Consumers keyed by queue name, as declared in wrangler.jsonc. */
  queueConsumers?: Record<string, QueueConsumer<E>>;
  /** Extra routes, mounted after the built-in ones. */
  routes?: (app: AppType<E>) => void;
  /**
   * Replaces the default job runner, the fault-tolerant runner (halt, flags and budget checks, run
   * rows, failure pages).
   */
  runner?: JobRunner<E>;
  /**
   * The operator channel: failure and cron health pages, the operator webhook and the chat agent's
   * replies and approval requests. Return undefined (or throw) when it is not configured.
   */
  operator?: (env: E) => OperatorChannel | undefined;
  /** The model gateway the hub agent calls. Without it, chat commands work but tasks are declined. */
  model?: (env: E) => ModelGateway | undefined;
  /**
   * The email provider: verifies and parses delivery webhooks at /api/webhooks/email. Return
   * undefined (or throw) when it is not configured; the route then answers 503. The send function
   * and the delivery jobs take the same factory (see createOutreachSender and createDeliveryJobs).
   */
  email?: (env: E) => EmailProvider | undefined;
  /**
   * The send function the operator's `batch-release-<id>-<code>` command hands approved drafts to,
   * usually createOutreachSender(senderDepsFromEnv(...)). Without it, releases are refused.
   */
  sendOutreach?: (env: E) => SendOutreach | undefined;
  /**
   * The warm mailbox: the push webhook at /api/webhooks/mail polls it when woken. Return undefined
   * (or throw) when it is not configured; the route then answers 503. The inbox jobs take the same
   * factory (see createInboxJobs).
   */
  inbox?: (env: E) => InboxProvider | undefined;
  /**
   * Mail delivered by Cloudflare Email Routing: with this set, the Worker exports an email()
   * handler that records each message through the same intake as polled mail (docs/INBOX.md).
   */
  inboundEmail?: InboundEmailOptions<E>;
  /** Limits and wiring for the operator chat agent. */
  agent?: OperatorAgentWorkerOptions;
  /** The jobs queue's names, so its batches and its dead-letter batches reach the right consumer. */
  scheduler?: SchedulerOptions;
  /** Registers the cron health check as a job on this schedule, for example "30 10,15 * * *". */
  cronHealth?: { schedule: string; graceMs?: number };
  /**
   * The product bridge, billing and the event spine (createLifecycle from "@gtm-agents/core/lifecycle"):
   * its routers back the product and billing webhooks and the EVENTS_QUEUE consumer. Register its
   * jobs in `jobs` too. Without it both webhooks answer 503.
   */
  lifecycle?: LifecycleWiring<E>;
  /**
   * Optional sources for the operator dashboard (docs/DASHBOARD.md): proposal sources such as
   * learnings, fitness scores, and the link-intake status.
   */
  dashboard?: DashboardExtensions<E>;
  /**
   * Operator chat commands contributed by optional modules (packages/modules), for example the ship
   * module's commands. Each is matched in the chat consumer after the allowlist, the agent flag and
   * every built-in command, and never reaches the model; /help lists their help lines. Register the
   * module's jobs in `jobs`.
   */
  commands?: ReadonlyArray<ModuleCommand<E>>;
  /**
   * Called with the trigger's cron string and the outcomes of the jobs that ran, for observability:
   * after every scheduled invocation (empty when nothing was due that minute, or when every due job
   * went to the jobs queue), and, with the jobs queue, once per job its consumer ran.
   */
  onScheduled?: (cron: string, outcomes: JobOutcome[]) => void;
}

export interface GtmWorker<E extends Env = Env> extends ExportedHandler<E> {
  readonly app: AppType<E>;
  readonly registry: JobRegistry<E>;
}

/**
 * Headers on every /admin/* response: the dashboard may not be framed by any page (a meta tag
 * cannot set frame-ancestors), and content types are not sniffed. The dashboard's own
 * Content-Security-Policy still applies; browsers enforce both.
 */
export const ADMIN_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

function withAdminHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(ADMIN_RESPONSE_HEADERS)) out.headers.set(name, value);
  return out;
}

export function consoleLogger(scope: Record<string, unknown> = {}): JobLogger {
  const write = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) =>
    console[level](JSON.stringify({ level, msg, ...scope, ...(data ?? {}) }));
  return {
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
  };
}

/** Flags live in KV. Reads throw when KV is unavailable, so each caller can fail in its own direction. */
export function kvFlagReader(kv: KVNamespace | undefined): FlagReader {
  return {
    get: async (key) => {
      if (!kv) throw new Error("the KV binding is missing");
      return kv.get(key);
    },
  };
}

export function createWorker<E extends Env = Env>(config: GtmConfig, options: CreateWorkerOptions<E> = {}): GtmWorker<E> {
  const runner: JobRunner<E> = options.runner ?? createJobRunner<E>(options.operator ? { operator: options.operator } : {});
  const jobs: Array<JobDefinition<E> | RegisteredJob<E>> = [...(options.jobs ?? [])];
  if (options.cronHealth) {
    jobs.push(
      createCronHealthJob<E>({
        schedule: options.cronHealth.schedule,
        registry: () => registry,
        runner,
        ...(options.operator ? { operator: options.operator } : {}),
        ...(options.cronHealth.graceMs !== undefined ? { graceMs: options.cronHealth.graceMs } : {}),
      }),
    );
  }
  const registry = createJobRegistry<E>(jobs);
  const log = consoleLogger({ service: "gtm-agents" });
  const app: AppType<E> = new Hono<{ Bindings: E }>();

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "payload_too_large", maxBytes: MAX_BODY_BYTES }, 413),
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, service: "gtm-agents" }));

  app.get("/admin", (c) => c.redirect("/admin/", 301));
  app.all("/admin/*", async (c) => {
    if (!c.env.ASSETS) return c.json({ error: "not_found" }, 404);
    return withAdminHeaders(await c.env.ASSETS.fetch(c.req.raw));
  });

  // Every /api/* route needs the bearer token, except webhooks, which verify their own signatures.
  app.use("/api/*", bearerAuth());

  // The operator dashboard's WebSocket. Cloudflare Access is the authentication: the token is
  // verified here, before the upgrade reaches the OperatorGateway Durable Object.
  registerGateway<E>({
    config,
    registry: () => registry,
    ...(options.operator ? { operator: options.operator } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.email ? { email: options.email } : {}),
    ...(options.inbox ? { inbox: options.inbox } : {}),
    lifecycle: options.lifecycle !== undefined,
    agent: {
      ...(options.agent?.maxRounds !== undefined ? { maxRounds: options.agent.maxRounds } : {}),
      ...(options.agent?.maxTokens !== undefined ? { maxTokens: options.agent.maxTokens } : {}),
      ...(options.agent?.templates ? { templates: options.agent.templates } : {}),
      ...(options.agent?.fetch ? { fetch: options.agent.fetch } : {}),
      ...(options.agent?.owedWindowDays !== undefined ? { owedWindowDays: options.agent.owedWindowDays } : {}),
    },
    extensions: options.dashboard ?? {},
    ...(options.commands && options.commands.length > 0 ? { commands: options.commands } : {}),
  });
  app.get(GATEWAY_PATH, createGatewayRoute<E>(config, { log: consoleLogger({ service: "gtm-agents", scope: "dashboard" }) }));

  const agentOptions = {
    config,
    operator: (env: E) => options.operator?.(env),
    ...(options.model ? { model: options.model } : {}),
    ...(options.sendOutreach ? { sendOutreach: options.sendOutreach } : {}),
    // The release commands send through these: follow-up steps through the email provider, approved
    // replies through the warm mailbox. Without them those commands refuse rather than send.
    ...(options.email ? { email: options.email } : {}),
    ...(options.inbox ? { inbox: options.inbox } : {}),
    ...(options.agent?.maxRounds !== undefined ? { maxRounds: options.agent.maxRounds } : {}),
    ...(options.agent?.maxTokens !== undefined ? { maxTokens: options.agent.maxTokens } : {}),
    ...(options.agent?.owedWindowDays !== undefined ? { owedWindowDays: options.agent.owedWindowDays } : {}),
    ...(options.agent?.fetch ? { fetch: options.agent.fetch } : {}),
    ...(options.agent?.templates ? { templates: options.agent.templates } : {}),
    ...(options.commands && options.commands.length > 0 ? { commands: options.commands } : {}),
    logger: consoleLogger({ service: "gtm-agents", scope: "operator" }),
  };
  app.post(OPERATOR_WEBHOOK_PATH, createOperatorWebhook<E>(agentOptions));

  // Delivery: provider events (signature checked by the adapter before anything else) and the
  // unsubscribe link, which lives outside /api/ so mail clients reach it without a token.
  const deliveryLog = consoleLogger({ service: "gtm-agents", scope: "delivery" });
  app.post(EMAIL_WEBHOOK_PATH, createEmailWebhook<E>({ ...(options.email ? { email: options.email } : {}), ...(options.operator ? { operator: options.operator } : {}), logger: deliveryLog }));
  const unsubscribe = createUnsubscribeHandlers<E>({ config, ...(options.operator ? { operator: options.operator } : {}), logger: deliveryLog });
  app.get(UNSUBSCRIBE_ROUTE, (c) => unsubscribe.get(c));
  app.post(UNSUBSCRIBE_ROUTE, (c) => unsubscribe.post(c));

  // Inbox: the mailbox's push wake-up (shared secret checked before anything else) and, when
  // configured, the email() entry point for mail Email Routing delivers.
  const inboxLog = consoleLogger({ service: "gtm-agents", scope: "inbox" });
  app.post(MAIL_WEBHOOK_PATH, createInboxPushWebhook<E>({ config, ...(options.inbox ? { inbox: options.inbox } : {}), ...(options.operator ? { operator: options.operator } : {}), logger: inboxLog }));
  const emailHandler: InboundEmailHandler<E> | undefined = options.inboundEmail
    ? createInboundEmailHandler<E>(config, { ...(options.operator ? { operator: options.operator } : {}), logger: inboxLog, ...options.inboundEmail })
    : undefined;

  // Lifecycle: the product bridge's push and the billing provider's webhook (each verifies its
  // signature before anything else, and answers 503 until configured), and the events queue.
  const lifecycleLog = consoleLogger({ service: "gtm-agents", scope: "lifecycle" });
  const lifecycle = options.lifecycle;
  app.post(PRODUCT_WEBHOOK_PATH, createProductWebhook<E>({ ...(lifecycle ? { routers: lifecycle.routers } : {}), logger: lifecycleLog }));
  app.post(BILLING_WEBHOOK_PATH, createBillingWebhook<E>({ ...(lifecycle?.billing ? { billing: lifecycle.billing } : {}), ...(lifecycle ? { routers: lifecycle.routers } : {}), logger: lifecycleLog }));
  const eventConsumer = lifecycle ? createEventConsumer<E>({ routers: lifecycle.routers, flags: (env) => kvFlagReader(env.KV), log: lifecycleLog }) : undefined;
  const eventQueues = eventConsumer ? [lifecycle?.eventsQueue ?? DEFAULT_EVENTS_QUEUE].flat() : [];

  const chatQueues = [options.agent?.chatQueue ?? DEFAULT_CHAT_QUEUE].flat();
  const chatConsumer = createChatConsumer<E>(agentOptions);

  // `now` is when the job starts (never before its scheduled minute), not the trigger's scheduled
  // time: a job may wait for a free slot or in the queue before it starts, and a send window must be
  // checked against the real clock.
  const makeContext = (env: E, at: Date) => (job: RegisteredJob<E>, signal: AbortSignal): JobContext<E> => ({
    env,
    config,
    job: job.name,
    now: new Date(Math.max(Date.now(), at.getTime())),
    signal,
    ceilings: job.ceilings,
    flags: kvFlagReader(env.KV),
    log: consoleLogger({ service: "gtm-agents", job: job.name }),
  });
  const report = (cron: string, outcomes: JobOutcome[]) => {
    for (const o of outcomes) if (o.status === "failed") log.error("scheduled job failed", { cron, job: o.job, error: o.error ?? "unknown error" });
    try {
      options.onScheduled?.(cron, outcomes);
    } catch (err) {
      log.error("onScheduled failed", { cron, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // The jobs queue: one job per invocation, claimed per (job, minute); and its dead-letter queue,
  // which records and pages what never ran.
  const schedulerLog = consoleLogger({ service: "gtm-agents", scope: "scheduler" });
  const jobsQueues = [options.scheduler?.jobsQueue ?? DEFAULT_JOBS_QUEUE].flat();
  const jobsDeadLetterQueues = [options.scheduler?.deadLetterQueue ?? DEFAULT_JOBS_DEAD_LETTER_QUEUE].flat();
  const jobsConsumer = createJobsConsumer<E>({
    registry,
    runner,
    db: (env) => env.DB,
    makeContext,
    log: schedulerLog,
    onOutcome: (outcome) => report(SCHEDULER_CRON, [outcome]),
  });
  const jobsDeadLetterConsumer = createJobsDeadLetterConsumer<E>({
    registry,
    db: (env) => env.DB,
    kv: (env) => env.KV,
    ...(options.operator ? { operator: options.operator } : {}),
    log: schedulerLog,
  });

  const queueConsumers: Record<string, QueueConsumer<E>> = {
    ...Object.fromEntries(jobsQueues.map((name) => [name, jobsConsumer])),
    ...Object.fromEntries(jobsDeadLetterQueues.map((name) => [name, jobsDeadLetterConsumer])),
    ...(eventConsumer ? Object.fromEntries(eventQueues.map((name) => [name, eventConsumer])) : {}),
    ...Object.fromEntries(chatQueues.map((name) => [name, chatConsumer])),
    // A consumer the deployment registers under the same name replaces the built-in one.
    ...(options.queueConsumers ?? {}),
  };

  options.routes?.(app);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    log.error("unhandled error", { path: new URL(c.req.url).pathname, error: err.message });
    return c.json({ error: "internal_error" }, 500);
  });

  return {
    app,
    registry,
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    ...(emailHandler ? { email: (message, env, ctx) => emailHandler(message, env, ctx) } : {}),
    // One trigger fires every minute (SCHEDULER_CRON). The jobs to run are the ones whose own
    // schedule matches the minute of scheduledTime (UTC); controller.cron is logged, never matched,
    // so a manual or extra trigger cannot pick a different set of jobs. They run concurrently
    // (DUE_JOB_CONCURRENCY at a time, longest ceiling first), each under its own ceiling, and a job
    // that could not finish within SCHEDULED_WALL_BUDGET_MS is recorded as not started. With a
    // JOBS_QUEUE binding and scheduler:queue_enabled on (an unreadable flag counts as off, which is
    // the in-process path above), the due jobs are sent to the queue instead, one message each, and its
    // consumer runs each in its own invocation; jobs the queue would not take run here, claimed per
    // (job, minute) so a half-sent batch never runs a job twice. A minute with nothing due returns
    // before any binding is touched.
    scheduled: (controller, env, ctx) => {
      const at = new Date(controller.scheduledTime);
      const due = registry.dueAt(at);
      if (due.length === 0) {
        try {
          options.onScheduled?.(controller.cron, []);
        } catch (err) {
          log.error("onScheduled failed", { cron: controller.cron, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      const ordered = inRunOrder(due);
      const jobs = ordered.map((j) => j.name);
      const binding = env.JOBS_QUEUE;
      if (normalizeCron(controller.cron) !== SCHEDULER_CRON) {
        log.warn(
          binding
            ? "scheduled invocation from a trigger other than the per-minute one; with the jobs queue on, queued jobs are claimed per minute, so its duplicates do nothing"
            : "scheduled invocation from a trigger other than the per-minute one; due jobs run by scheduled time, so an extra trigger runs them again",
          { cron: controller.cron, jobs },
        );
      }
      const deadline = Date.now() + SCHEDULED_WALL_BUDGET_MS;
      const track = (settled: Promise<unknown>) => ctx.waitUntil(settled);
      const dispatch = async (): Promise<JobOutcome[]> => {
        const queue = binding && isFlagOn(await kvFlagReader(env.KV).get(JOBS_QUEUE_FLAG).catch(() => null)) ? binding : undefined;
        if (!queue) {
          log.info("running due jobs", { cron: controller.cron, at: at.toISOString(), jobs });
          return runJobsConcurrently(ordered, makeContext(env, at), runner, track, { deadline });
        }
        const sent = await enqueueDueJobs(queue, ordered, at);
        if (sent.enqueued.length > 0) log.info("due jobs sent to the jobs queue", { cron: controller.cron, at: at.toISOString(), jobs: sent.enqueued.map((j) => j.name) });
        if (sent.failed.length === 0) return [];
        log.error("the jobs queue did not take these jobs; running them in this invocation", { cron: controller.cron, jobs: sent.failed.map((j) => j.name), error: sent.error ?? "unknown error" });
        return runClaimedJobs(sent.failed, at, { db: env.DB, makeContext: makeContext(env, at), runner, track, log, deadline });
      };
      const run = dispatch()
        .then((outcomes) => report(controller.cron, outcomes))
        .catch((err: unknown) => log.error("scheduled handler failed", { cron: controller.cron, error: err instanceof Error ? err.message : String(err) }));
      ctx.waitUntil(run);
    },
    queue: async (batch, env, ctx) => {
      let consumer = Object.hasOwn(queueConsumers, batch.queue) ? queueConsumers[batch.queue] : undefined;
      // A chat queue whose name differs from agent.chatQueue (a renamed queue in wrangler.jsonc)
      // still reaches the chat consumer when every message is a chat message, rather than being
      // retried until it is dropped.
      if (!consumer && batch.messages.length > 0 && batch.messages.every((m) => isChatMessage(m.body))) {
        log.warn("chat messages arrived on a queue not listed in agent.chatQueue; handling them as chat", { queue: batch.queue });
        consumer = chatConsumer;
      }
      // Likewise a jobs queue renamed in wrangler.jsonc. Its dead-letter queue carries the same
      // messages; `gtm setup` names it with a -dlq suffix, and a dead-letter batch is only recorded
      // and paged, never run.
      if (!consumer && batch.messages.length > 0 && batch.messages.every((m) => isJobMessage(m.body))) {
        const deadLetter = batch.queue.endsWith("-dlq");
        log.warn("job messages arrived on a queue not listed in scheduler; handling them by the queue's name", { queue: batch.queue, as: deadLetter ? "dead letters" : "jobs" });
        consumer = deadLetter ? jobsDeadLetterConsumer : jobsConsumer;
      }
      // Likewise an events queue renamed in wrangler.jsonc: event messages carry only a row id, which
      // the spine re-reads from the database before acting.
      if (!consumer && eventConsumer && batch.messages.length > 0 && batch.messages.every((m) => isEventMessage(m.body))) {
        log.warn("event messages arrived on a queue not listed in lifecycle.eventsQueue; routing them as events", { queue: batch.queue });
        consumer = eventConsumer;
      }
      if (!consumer) {
        // Retry rather than drop: after the queue's retry limit, messages move to its dead-letter queue.
        log.warn("no consumer registered for this queue; retrying the batch", { queue: batch.queue, messages: batch.messages.length });
        batch.retryAll();
        return;
      }
      await consumer(batch, env, ctx);
    },
  };
}
