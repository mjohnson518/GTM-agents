// GTM-agents: createWorker(), which turns a deployment's config, jobs, queue consumers and routes
// into the Worker's fetch, scheduled and queue handlers.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GtmConfig } from "./config/schema.ts";
import type { Env } from "./env.ts";
import { runScheduledJobs, type JobOutcome, type JobRunner } from "./jobs/loop.ts";
import { createJobRegistry, type FlagReader, type JobContext, type JobDefinition, type JobLogger, type JobRegistry, type RegisteredJob } from "./jobs/registry.ts";
import type { OperatorChannel } from "./ports/operator.ts";
import { createCronHealthJob } from "./runtime/cron-health.ts";
import { createJobRunner } from "./runtime/job-runner.ts";

export const MAX_BODY_BYTES = 100 * 1024;

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
  /** The operator channel for failure and cron health pages. */
  operator?: (env: E) => OperatorChannel | undefined;
  /** Registers the cron health check as a job on this schedule, for example "30 10,15 * * *". */
  cronHealth?: { schedule: string; graceMs?: number };
  /** Called with each scheduled run's outcomes, for observability. */
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

  options.routes?.(app);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    log.error("unhandled error", { path: new URL(c.req.url).pathname, error: err.message });
    return c.json({ error: "internal_error" }, 500);
  });

  const makeContext = (env: E, now: Date) => (job: RegisteredJob<E>, signal: AbortSignal): JobContext<E> => ({
    env,
    config,
    job: job.name,
    now,
    signal,
    ceilings: job.ceilings,
    flags: kvFlagReader(env.KV),
    log: consoleLogger({ service: "gtm-agents", job: job.name }),
  });

  return {
    app,
    registry,
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    scheduled: (controller, env, ctx) => {
      const run = runScheduledJobs(registry, controller.cron, makeContext(env, new Date(controller.scheduledTime)), runner, (settled) => ctx.waitUntil(settled))
        .then((outcomes) => {
          if (outcomes.length === 0) log.warn("no jobs registered for this cron trigger", { cron: controller.cron });
          options.onScheduled?.(controller.cron, outcomes);
        })
        .catch((err: unknown) => log.error("scheduled handler failed", { cron: controller.cron, error: err instanceof Error ? err.message : String(err) }));
      ctx.waitUntil(run);
    },
    queue: async (batch, env, ctx) => {
      const consumer = options.queueConsumers?.[batch.queue];
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
