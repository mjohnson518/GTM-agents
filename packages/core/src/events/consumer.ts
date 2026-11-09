// GTM-agents: the EVENTS_QUEUE consumer. Each message carries only an events row id; the consumer
// routes it through the spine (spine.ts), which reads the row and the payload itself, so nothing in
// a message is trusted beyond the id it names.
//
// A message is acknowledged once its event is routed, already routed, parked, leased by another
// router, waiting on a flag, or unknown. Only a failed attempt is retried, with a growing delay; the
// spine counts attempts in the database and parks the event after the fifth, and the sweep catches
// anything the queue drops.
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { routeEvent, type EventRouters, type RouteContext } from "./spine.ts";

/** True for a message the events queue carries: an object whose only required field is an events row id. */
export function isEventMessage(body: unknown): body is { id: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  // Row ids are "<source>:<provider id>" (spine.ts, eventRowId).
  return typeof b.id === "string" && b.id.length <= 300 && /^[a-z][a-z-]{0,30}:\S/.test(b.id) && !("updateId" in b) && !("chatId" in b);
}

export interface EventConsumerOptions<E> {
  routers: (env: E) => EventRouters<E>;
  flags: (env: E) => FlagReader;
  log: JobLogger;
  now?: () => Date;
}

export function createEventConsumer<E extends { DB: D1Database; BUCKET?: R2Bucket }>(options: EventConsumerOptions<E>): (batch: MessageBatch, env: E) => Promise<void> {
  return async (batch, env) => {
    const ctx: RouteContext<E> = { env, db: env.DB, bucket: env.BUCKET ?? null, now: (options.now ?? (() => new Date()))(), flags: options.flags(env), log: options.log };
    const routers = options.routers(env);
    for (const message of batch.messages) {
      if (!isEventMessage(message.body)) {
        options.log.warn("a message on the events queue is not an event; dropping it", { queue: batch.queue });
        message.ack();
        continue;
      }
      const outcome = await routeEvent(ctx, routers, message.body.id);
      if (outcome === "failed") message.retry({ delaySeconds: Math.min(300, 30 * Math.max(1, message.attempts)) });
      else message.ack();
    }
  };
}
