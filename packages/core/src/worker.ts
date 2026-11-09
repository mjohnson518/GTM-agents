// GTM-agents: createWorker(), which turns a deployment's config, jobs, queue consumers and routes
// into the Worker's fetch, scheduled and queue handlers.
//
// Built in:
//   - GET /health, and /admin/* served from the ASSETS binding;
//   - bearer authentication on every /api/* route except /api/webhooks/*, which verify their own
//     signatures (an unset GATEWAY_TOKEN answers 503: the gate fails closed);
//   - POST /api/webhooks/operator and the chat queue consumer, which run the operator agent when
//     the `operator` and `model` factories are given and the operator:agent_enabled flag is on;
//   - POST /api/webhooks/email, the email provider's delivery events (answers 503 until the `email`
//     factory is given), and GET and POST /u/:token, the one-click unsubscribe link (GET confirms,
//     POST opts out). docs/SENDING.md covers both;
//   - POST /api/webhooks/mail, the mailbox's push wake-up (shared secret first; answers 503 until
//     MAIL_PUSH_SECRET and the `inbox` factory are set), and the email() entry point for mail that
//     Cloudflare Email Routing delivers, when `inboundEmail` is given. docs/INBOX.md covers both.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GtmConfig } from "./config/schema.ts";
import type { Env } from "./env.ts";
import { bearerAuth } from "./http/auth.ts";
import { normalizeCron } from "./jobs/cron.ts";
import { inRunOrder, runJobsConcurrently, type JobOutcome, type JobRunner } from "./jobs/loop.ts";
import { MAX_JOB_DURATION_MS, SCHEDULER_CRON, createJobRegistry, type FlagReader, type JobContext, type JobDefinition, type JobLogger, type JobRegistry, type RegisteredJob } from "./jobs/registry.ts";
import { createInboundEmailHandler, type InboundEmailHandler, type InboundEmailOptions } from "./inbox/email-handler.ts";
import { MAIL_WEBHOOK_PATH, createInboxPushWebhook } from "./inbox/webhook.ts";
import { createChatConsumer, isChatMessage } from "./operator/chat.ts";
import { OPERATOR_WEBHOOK_PATH, createOperatorWebhook } from "./operator/webhook.ts";
import type { EmailProvider, InboxProvider } from "./ports/email.ts";
import type { ModelGateway } from "./ports/model.ts";
import type { OperatorChannel } from "./ports/operator.ts";
import type { SendOutreach } from "./sending/types.ts";
import { createCronHealthJob } from "./runtime/cron-health.ts";
import { createJobRunner } from "./runtime/job-runner.ts";
import { UNSUBSCRIBE_ROUTE, createUnsubscribeHandlers } from "./sending/unsubscribe.ts";
import { EMAIL_WEBHOOK_PATH, createEmailWebhook } from "./sending/webhook.ts";

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
  /** Registers the cron health check as a job on this schedule, for example "30 10,15 * * *". */
  cronHealth?: { schedule: string; graceMs?: number };
  /**
   * Called after every scheduled invocation with the trigger's cron string and the outcomes of the
   * jobs that were due (empty when nothing was due that minute), for observability.
   */
  onScheduled?: (cron: string, outcomes: JobOutcome[]) => void;
}

export interface GtmWorker<E extends Env = Env> extends ExportedHandler<E> {
  readonly app: AppType<E>;
  readonly registry: JobRegistry<E>;
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
    return c.env.ASSETS.fetch(c.req.raw);
  });

  // Every /api/* route needs the bearer token, except webhooks, which verify their own signatures.
  app.use("/api/*", bearerAuth());

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
    ...(options.agent?.fetch ? { fetch: options.agent.fetch } : {}),
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

  const chatQueues = [options.agent?.chatQueue ?? DEFAULT_CHAT_QUEUE].flat();
  const chatConsumer = createChatConsumer<E>(agentOptions);
  const queueConsumers: Record<string, QueueConsumer<E>> = {
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

  // `now` is when the job starts (never before its scheduled minute), not the trigger's scheduled
  // time: a job may wait for a free slot before it starts, and a send window must be checked
  // against the real clock.
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

  return {
    app,
    registry,
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    ...(emailHandler ? { email: (message, env, ctx) => emailHandler(message, env, ctx) } : {}),
    // One trigger fires every minute (SCHEDULER_CRON). The jobs to run are the ones whose own
    // schedule matches the minute of scheduledTime (UTC); controller.cron is logged, never matched,
    // so a manual or extra trigger cannot pick a different set of jobs. They run concurrently
    // (DUE_JOB_CONCURRENCY at a time, longest ceiling first), each under its own ceiling, and a job
    // that could not finish within SCHEDULED_WALL_BUDGET_MS is recorded as not started. A minute
    // with nothing due returns before any binding is touched.
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
      if (normalizeCron(controller.cron) !== SCHEDULER_CRON) {
        log.warn("scheduled invocation from a trigger other than the per-minute one; due jobs run by scheduled time, so an extra trigger runs them again", { cron: controller.cron, jobs });
      }
      log.info("running due jobs", { cron: controller.cron, at: at.toISOString(), jobs });
      const deadline = Date.now() + SCHEDULED_WALL_BUDGET_MS;
      const run = runJobsConcurrently(ordered, makeContext(env, at), runner, (settled) => ctx.waitUntil(settled), { deadline })
        .then((outcomes) => {
          for (const o of outcomes) if (o.status === "failed") log.error("scheduled job failed", { cron: controller.cron, job: o.job, error: o.error ?? "unknown error" });
          options.onScheduled?.(controller.cron, outcomes);
        })
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
