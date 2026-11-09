// GTM-agents: the signal and scale jobs a deployment registers.
//
//   createSignalJobs({ adapters: (env) => ({ discovery, similar, news, boards, people }), options })
//
// returns one job per source, each behind its own flag (all default off), each bounded by ceilings
// (rows, spend, time) and leaving a run row through the job runner. None of them calls a model.
//   signal_websets        weekdays 10:00 UTC  signals:websets_enabled        create weekly, poll daily
//   signal_monitor_drain  every 30 minutes    signals:monitors_enabled       up to 500 hits a run
//   signal_news           weekdays 07:00 UTC  signals:news_enabled           funding and leadership
//   signal_hiring_boards  weekdays 06:00 UTC  signals:hiring_boards_enabled  20 accounts a run
//   signal_lookalikes     Tue and Thu 11:00   signals:lookalikes_enabled     30 inserts a run
//   signal_coverage_fill  weekdays 12:00 UTC  signals:coverage_fill_enabled  5 accounts, 2 people each
//   intent_scoring        daily 02:30 UTC     scoring:intent_enabled         shadow until enforced
// Paid calls go through one spend gate per run with the job's daily cap. Each job re-reads its own
// flag (failing closed), so calling run() directly with the flag off does nothing. A source whose
// adapter is not wired skips with a summary saying so. Candidates these jobs write wait for the
// discovery cycle (discovery:enabled) to enrich, qualify and promote them.
import { MONITOR_SECRET_NAME } from "./monitors.ts";
import { parseCron } from "../jobs/cron.ts";
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { DiscoverySource, PeopleProvider } from "../ports/discovery.ts";
import { runIntentScoring } from "../scoring/intent.ts";
import { loadSourcingBrain, type SourcingBrain } from "../sourcing/brain.ts";
import { readFlagOn } from "../sourcing/flags.ts";
import type { SourcingEnv } from "../sourcing/jobs.ts";
import { createSpendGate, type SpendGate } from "../sourcing/spend.ts";
import { runCoverageFill } from "./coverage.ts";
import { SIGNAL_FLAGS, SIGNAL_LIMITS } from "./flags.ts";
import { runHiringBoards } from "./hiring.ts";
import { runLookalikes } from "./lookalikes.ts";
import { drainMonitorItems, type MonitorConfig } from "./monitors.ts";
import { runNewsSignals, type NewsQuery } from "./news.ts";
import type { HiringBoardSource, NewsSource, RoleKind, SimilarSource } from "./ports.ts";
import { runWebsets, type WebsetSpec } from "./websets.ts";

export const SIGNAL_JOBS = Object.freeze({
  websets: "signal_websets",
  monitors: "signal_monitor_drain",
  news: "signal_news",
  hiringBoards: "signal_hiring_boards",
  lookalikes: "signal_lookalikes",
  coverageFill: "signal_coverage_fill",
  intent: "intent_scoring",
});

export interface SignalAdapters {
  /** A DiscoverySource with the watch capability, for websets. */
  discovery?: DiscoverySource;
  similar?: SimilarSource;
  news?: NewsSource;
  boards?: HiringBoardSource;
  people?: PeopleProvider;
}

export interface SignalJobOptions {
  websets: readonly WebsetSpec[];
  monitors: readonly MonitorConfig[];
  newsQueries?: readonly NewsQuery[];
  roleKinds?: readonly RoleKind[];
  /** Worst-case dollars per webset item (the item and its email enrichment), reserved at creation. */
  websetItemUsd: number;
  /** Daily spend caps, in cents. */
  websetsMaxSpendCents: number;
  newsMaxSpendCents: number;
  lookalikesMaxSpendCents: number;
  coverageMaxSpendCents: number;
  schedules: Readonly<Record<keyof typeof SIGNAL_JOBS, string>>;
}

export const DEFAULT_SIGNAL_JOB_OPTIONS: Readonly<SignalJobOptions> = Object.freeze({
  websets: [],
  monitors: [],
  websetItemUsd: 0.09,
  websetsMaxSpendCents: 200,
  newsMaxSpendCents: 50,
  lookalikesMaxSpendCents: 50,
  coverageMaxSpendCents: 100,
  schedules: Object.freeze({
    websets: "0 10 * * MON-FRI",
    monitors: "*/30 * * * *",
    news: "0 7 * * MON-FRI",
    hiringBoards: "0 6 * * MON-FRI",
    lookalikes: "0 11 * * TUE,THU",
    coverageFill: "0 12 * * MON-FRI",
    intent: "30 2 * * *",
  }),
});

export interface SignalDeps<E extends SourcingEnv = SourcingEnv> {
  /** Build the adapters for one run. Called inside the job, after its gates have passed. */
  adapters(env: E): SignalAdapters;
  options?: Partial<Omit<SignalJobOptions, "schedules">> & { schedules?: Partial<SignalJobOptions["schedules"]> };
}

export function createSignalJobs<E extends SourcingEnv>(deps: SignalDeps<E>): RegisteredJob<E>[] {
  const options: SignalJobOptions = {
    ...DEFAULT_SIGNAL_JOB_OPTIONS,
    ...(deps.options ?? {}),
    schedules: { ...DEFAULT_SIGNAL_JOB_OPTIONS.schedules, ...(deps.options?.schedules ?? {}) },
  };
  for (const schedule of Object.values(options.schedules)) parseCron(schedule);
  for (const m of options.monitors) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(m.key) || !MONITOR_SECRET_NAME.test(m.secretName)) throw new Error(`monitor ${m.key}: keys are lowercase slugs, and secretName names a Worker secret starting with MONITOR_`);
    if (m.results !== "company_sites" && m.results !== "articles") throw new Error(`monitor ${m.key}: results must be company_sites or articles`);
  }

  const gateFor = (ctx: JobContext<E>, cap: number): SpendGate =>
    createSpendGate({ db: ctx.env.DB, flags: ctx.flags, job: ctx.job, ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}), jobCapCents: cap, log: ctx.log });
  const brainFor = async (ctx: JobContext<E>): Promise<SourcingBrain | null> => {
    const brain = await loadSourcingBrain(ctx.env.KV);
    return brain.degraded ? null : brain;
  };
  const stopped = (gate: SpendGate) => (gate.stopped ? `; stopped: ${gate.stopped}` : "");

  const websets = defineJob<E>({
    name: SIGNAL_JOBS.websets,
    schedule: options.schedules.websets,
    flag: SIGNAL_FLAGS.websets,
    ceilings: { maxDurationMs: 300_000, maxRows: SIGNAL_LIMITS.websetItemsPerRun, maxSpendCents: options.websetsMaxSpendCents },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.websets))) return { summary: "flag off" };
      const source = deps.adapters(ctx.env).discovery;
      if (!source?.createWatch || !source.pollWatch) return { summary: "no discovery source with websets configured" };
      const brain = await brainFor(ctx);
      if (!brain) return { summary: "skipped: the brain could not be read whole" };
      const gate = gateFor(ctx, options.websetsMaxSpendCents);
      const r = await runWebsets({ db: ctx.env.DB, source, specs: options.websets, brain, gate, now: ctx.now, maxRows: ctx.ceilings.maxRows ?? SIGNAL_LIMITS.websetItemsPerRun, itemUsd: options.websetItemUsd, maxReserveUsd: options.websetsMaxSpendCents / 100, log: ctx.log, signal: ctx.signal });
      return { summary: `created ${r.created}, polled ${r.polled}, ${r.inserted} raw, ${r.qualified} qualified, ${r.rejected} rejected, ${r.duplicates} duplicate${stopped(gate)}`, rows: r.inserted + r.qualified + r.rejected };
    },
  });

  const monitors = defineJob<E>({
    name: SIGNAL_JOBS.monitors,
    schedule: options.schedules.monitors,
    flag: SIGNAL_FLAGS.monitors,
    ceilings: { maxDurationMs: 120_000, maxRows: SIGNAL_LIMITS.monitorDrainPerRun },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.monitors))) return { summary: "flag off" };
      const brain = await brainFor(ctx);
      if (!brain) return { summary: "skipped: the brain could not be read whole" };
      const r = await drainMonitorItems({ db: ctx.env.DB, monitors: options.monitors, brain, now: ctx.now, limit: ctx.ceilings.maxRows ?? SIGNAL_LIMITS.monitorDrainPerRun, log: ctx.log, signal: ctx.signal });
      return { summary: `processed ${r.processed}: ${r.inserted} new, ${r.duplicate} duplicate, ${r.skipped} skipped`, rows: r.processed };
    },
  });

  const news = defineJob<E>({
    name: SIGNAL_JOBS.news,
    schedule: options.schedules.news,
    flag: SIGNAL_FLAGS.news,
    ceilings: { maxDurationMs: 120_000, maxRows: SIGNAL_LIMITS.newsQueriesPerRun * SIGNAL_LIMITS.newsResultsPerQuery, maxSpendCents: options.newsMaxSpendCents },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.news))) return { summary: "flag off" };
      const source = deps.adapters(ctx.env).news;
      if (!source) return { summary: "no news source configured" };
      const gate = gateFor(ctx, options.newsMaxSpendCents);
      const r = await runNewsSignals({ db: ctx.env.DB, source, gate, now: ctx.now, ...(options.newsQueries ? { queries: options.newsQueries } : {}), log: ctx.log, signal: ctx.signal });
      return { summary: `${r.searches} searches, ${r.hits} hits, ${r.recorded} signals${stopped(gate)}`, rows: r.hits };
    },
  });

  const hiring = defineJob<E>({
    name: SIGNAL_JOBS.hiringBoards,
    schedule: options.schedules.hiringBoards,
    flag: SIGNAL_FLAGS.hiringBoards,
    ceilings: { maxDurationMs: 180_000, maxRows: SIGNAL_LIMITS.hiringAccountsPerRun * 3 },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.hiringBoards))) return { summary: "flag off" };
      const source = deps.adapters(ctx.env).boards;
      if (!source) return { summary: "no hiring-board source configured" };
      const r = await runHiringBoards({ db: ctx.env.DB, source, now: ctx.now, ...(options.roleKinds ? { roleKinds: options.roleKinds } : {}), log: ctx.log, signal: ctx.signal });
      return { summary: `${r.accounts} accounts, ${r.boards} boards, ${r.signals} signals`, rows: r.accounts };
    },
  });

  const lookalikes = defineJob<E>({
    name: SIGNAL_JOBS.lookalikes,
    schedule: options.schedules.lookalikes,
    flag: SIGNAL_FLAGS.lookalikes,
    ceilings: { maxDurationMs: 180_000, maxRows: SIGNAL_LIMITS.lookalikeInsertsPerRun, maxSpendCents: options.lookalikesMaxSpendCents },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.lookalikes))) return { summary: "flag off" };
      const source = deps.adapters(ctx.env).similar;
      if (!source) return { summary: "no find-similar source configured" };
      const brain = await brainFor(ctx);
      if (!brain) return { summary: "skipped: the brain could not be read whole" };
      const gate = gateFor(ctx, options.lookalikesMaxSpendCents);
      const r = await runLookalikes({ db: ctx.env.DB, source, brain, gate, now: ctx.now, maxRows: ctx.ceilings.maxRows ?? SIGNAL_LIMITS.lookalikeInsertsPerRun, log: ctx.log, signal: ctx.signal });
      return { summary: `${r.seeds} seeds, ${r.searches} searches, ${r.inserted} new, ${r.skipped} skipped${stopped(gate)}`, rows: r.inserted };
    },
  });

  const coverage = defineJob<E>({
    name: SIGNAL_JOBS.coverageFill,
    schedule: options.schedules.coverageFill,
    flag: SIGNAL_FLAGS.coverageFill,
    ceilings: { maxDurationMs: 180_000, maxRows: SIGNAL_LIMITS.coverageAccountsPerRun * SIGNAL_LIMITS.coveragePeoplePerAccount, maxSpendCents: options.coverageMaxSpendCents },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.coverageFill))) return { summary: "flag off" };
      const people = deps.adapters(ctx.env).people;
      if (!people) return { summary: "no people provider configured" };
      const brain = await brainFor(ctx);
      if (!brain) return { summary: "skipped: the brain could not be read whole" };
      if (brain.personas.length === 0) return { summary: "skipped: no approved personas in the brain" };
      const gate = gateFor(ctx, options.coverageMaxSpendCents);
      const r = await runCoverageFill({ db: ctx.env.DB, people, brain, gate, now: ctx.now, maxRows: ctx.ceilings.maxRows ?? 10, log: ctx.log, signal: ctx.signal });
      return { summary: `${r.eligible} eligible, ${r.claimed} filled, ${r.inserted} people${stopped(gate)}`, rows: r.inserted };
    },
  });

  const intent = defineJob<E>({
    name: SIGNAL_JOBS.intent,
    schedule: options.schedules.intent,
    flag: SIGNAL_FLAGS.intent,
    ceilings: { maxDurationMs: 120_000, maxRows: SIGNAL_LIMITS.intentContactsPerRun },
    rerunnable: true,
    async run(ctx) {
      if (!(await readFlagOn(ctx.flags, SIGNAL_FLAGS.intent))) return { summary: "flag off" };
      const brain = await brainFor(ctx);
      if (!brain) return { summary: "skipped: the brain could not be read whole" };
      const written = await runIntentScoring({ db: ctx.env.DB, brain, now: ctx.now, limit: ctx.ceilings.maxRows ?? SIGNAL_LIMITS.intentContactsPerRun, signal: ctx.signal });
      return { summary: `scored ${written} contacts (shadow unless intent_score:enforce is on)`, rows: written };
    },
  });

  return [websets, monitors, news, hiring, lookalikes, coverage, intent];
}
