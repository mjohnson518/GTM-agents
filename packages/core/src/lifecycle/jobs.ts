// GTM-agents: the lifecycle's scheduled jobs, and the wiring a deployment hands to createWorker.
//
//   event_sweep          every 5 minutes        (none)                       routes unrouted events older
//                                                                           than 5 minutes (100 a run);
//                                                                           each source's own flags decide
//                                                                           what routes, so with
//                                                                           lifecycle:enabled off only
//                                                                           erasures do
//   lifecycle_checks     hourly at :20          lifecycle:enabled            stalled and dormant moves
//                                                                           (200 of each a run)
//   lifecycle_reconcile  03:15 UTC daily        lifecycle:reconcile_enabled  the signed pull (3 pages of
//                                                                           200 per resource); with
//                                                                           lifecycle:enabled off it reads
//                                                                           deletions only
//   mrr_snapshot         23:55 UTC daily        lifecycle:enabled            one mrr_snapshots row a day
//   event_retention      03:50 UTC daily        lifecycle:enabled            deletes routed payloads older
//                                                                           than 90 days (500 a run)
// None calls a model or spends. Each is bounded by its ceilings and safe to rerun.
import { createBillingRouter } from "../billing/route.ts";
import type { PriceList } from "../billing/mrr.ts";
import type { Env } from "../env.ts";
import { purgeRoutedPayloads, sweepEvents, type EventRouters } from "../events/spine.ts";
import { defineJob, type RegisteredJob } from "../jobs/registry.ts";
import type { BillingProvider } from "../ports/business.ts";
import { createProductRouter } from "../product-bridge/route.ts";
import { reconcileProduct } from "../product-bridge/reconcile.ts";
import { readSwitch } from "../sending/flags.ts";
import { runLifecycleChecks, snapshotMrr } from "./checks.ts";
import { LIFECYCLE_FLAGS, LIFECYCLE_LIMITS } from "./flags.ts";

export const LIFECYCLE_SCHEDULES = Object.freeze({
  sweep: "*/5 * * * *",
  checks: "20 * * * *",
  reconcile: "15 3 * * *",
  mrr: "55 23 * * *",
  retention: "50 3 * * *",
});

export interface LifecycleOptions<E> {
  /** Monthly list price in cents per plan name: the MRR fallback, and what makes a plan change an upgrade or a downgrade. */
  prices?: PriceList;
  /** The billing adapter behind POST /api/webhooks/billing. Without it that route answers 503. */
  billing?: (env: E) => BillingProvider | undefined;
  /** The fetch the nightly pull uses. Defaults to the global fetch. */
  fetch?: typeof fetch;
  schedules?: Partial<typeof LIFECYCLE_SCHEDULES>;
  /**
   * The name of the queue bound as EVENTS_QUEUE, as declared in wrangler.jsonc, or a list when each
   * environment uses its own. Defaults to "gtm-events".
   */
  eventsQueue?: string | readonly string[];
}

/** What createWorker takes as `lifecycle`, and the jobs to register. */
export interface LifecycleWiring<E> {
  jobs: RegisteredJob<E>[];
  /** The spine's routers: product events and billing events. */
  routers: (env: E) => EventRouters<E>;
  billing?: (env: E) => BillingProvider | undefined;
  eventsQueue?: string | readonly string[];
}

export function createLifecycle<E extends Env>(options: LifecycleOptions<E> = {}): LifecycleWiring<E> {
  const schedules = { ...LIFECYCLE_SCHEDULES, ...(options.schedules ?? {}) };
  const product = createProductRouter<E>(options.prices ? { prices: options.prices } : {});
  const billing = createBillingRouter<E>(options.prices ? { prices: options.prices } : {});
  const routers = (): EventRouters<E> => ({ product, billing });
  const jobs: RegisteredJob<E>[] = [
    defineJob<E>({
      name: "event_sweep",
      schedule: schedules.sweep,
      // No job flag: an erasure that arrived while the lifecycle is off must still be repaired if
      // its first routing failed. The routers' own flags keep everything else waiting. An events
      // table with nothing unrouted costs one indexed read.
      ceilings: { maxRows: LIFECYCLE_LIMITS.sweepRows, maxDurationMs: 120_000 },
      rerunnable: true,
      async run(ctx) {
        const result = await sweepEvents({ env: ctx.env, db: ctx.env.DB, bucket: ctx.env.BUCKET, now: ctx.now, flags: ctx.flags, log: ctx.log }, routers(), { limit: ctx.ceilings.maxRows ?? LIFECYCLE_LIMITS.sweepRows, signal: ctx.signal });
        return { rows: result.seen, summary: `${result.routed} of ${result.seen} unrouted events routed, ${result.parked} parked` };
      },
    }),
    defineJob<E>({
      name: "lifecycle_checks",
      schedule: schedules.checks,
      flag: LIFECYCLE_FLAGS.enabled,
      ceilings: { maxRows: LIFECYCLE_LIMITS.checkRows * 2, maxDurationMs: 120_000 },
      rerunnable: true,
      async run(ctx) {
        const result = await runLifecycleChecks({ db: ctx.env.DB, now: ctx.now, signal: ctx.signal });
        return { rows: result.stalled + result.dormant, summary: `${result.stalled} stalled, ${result.dormant} dormant, ${result.failed} failed` };
      },
    }),
    defineJob<E>({
      name: "lifecycle_reconcile",
      schedule: schedules.reconcile,
      flag: LIFECYCLE_FLAGS.reconcile,
      ceilings: { maxRows: LIFECYCLE_LIMITS.pullPages * LIFECYCLE_LIMITS.pullPageSize * 3, maxDurationMs: 10 * 60_000 },
      rerunnable: true,
      async run(ctx) {
        // Deletions are a compliance repair and run whatever lifecycle:enabled says; users and
        // feedback only while it is on.
        const full = await readSwitch(ctx.flags, LIFECYCLE_FLAGS.enabled);
        const report = await reconcileProduct({
          ...(full ? {} : { only: ["deletions" as const] }),
          db: ctx.env.DB,
          kv: ctx.env.KV,
          bucket: ctx.env.BUCKET,
          appUrl: ctx.env.PRODUCT_APP_URL,
          readSecret: ctx.env.PRODUCT_READ_SECRET,
          flags: ctx.flags,
          now: ctx.now,
          log: ctx.log,
          fetch: options.fetch ?? ((input, init) => fetch(input, init)),
          signal: ctx.signal,
        });
        if (report.status === "skipped") return { rows: 0, summary: `skipped: ${report.reason ?? "not configured"}` };
        const summary = `${report.rows} rows: ${report.deletions} erased, ${report.signups} signed up, ${report.activations} activated, ${report.feedback} feedback, ${report.refused} refused, ${report.recordErrors} bad rows`;
        if (report.status === "partial" && report.rows === 0) throw new Error(`the pull failed: ${report.errors.slice(0, 3).join("; ")}`);
        return { rows: report.rows, summary };
      },
    }),
    defineJob<E>({
      name: "mrr_snapshot",
      schedule: schedules.mrr,
      flag: LIFECYCLE_FLAGS.enabled,
      ceilings: { maxRows: 1, maxDurationMs: 30_000 },
      rerunnable: true,
      async run(ctx) {
        const snapshot = await snapshotMrr(ctx.env.DB, ctx.now);
        return { rows: 1, summary: `${snapshot.date}: ${snapshot.paying} paying, ${snapshot.mrrCents} cents MRR` };
      },
    }),
    defineJob<E>({
      name: "event_retention",
      schedule: schedules.retention,
      flag: LIFECYCLE_FLAGS.enabled,
      ceilings: { maxRows: LIFECYCLE_LIMITS.payloadRetentionRows, maxDurationMs: 120_000 },
      rerunnable: true,
      async run(ctx) {
        const purged = await purgeRoutedPayloads({ db: ctx.env.DB, bucket: ctx.env.BUCKET }, { now: ctx.now, days: LIFECYCLE_LIMITS.payloadRetentionDays, limit: ctx.ceilings.maxRows ?? LIFECYCLE_LIMITS.payloadRetentionRows });
        return { rows: purged, summary: `${purged} routed payloads deleted` };
      },
    }),
  ];
  return { jobs, routers, ...(options.billing ? { billing: options.billing } : {}), ...(options.eventsQueue ? { eventsQueue: options.eventsQueue } : {}) };
}
