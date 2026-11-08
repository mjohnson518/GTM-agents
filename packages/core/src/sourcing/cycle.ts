// GTM-agents: one discovery cycle: search, enrich, qualify, promote.
//
// The stages run in order, each bounded by its own per-run ceiling flag, and all share one spend
// gate, so the job's daily cap stops paid calls wherever they are. A stage that is stopped by the
// budget leaves its rows for the next run; the free stages after it still run, so work already
// paid for (enriched candidates) is still qualified and promoted.
//
// With no approved personas in the brain, nothing can pass person fit, so enrichment, qualification
// and promotion are skipped: rather than pay for lookups whose results would all be rejected, or
// reject paid-for candidates because of a missing brain. A degraded brain (one that could not be
// read whole, see brain.ts) skips every stage, search included.
import type { KVReader } from "../brain/load.ts";
import { enrichStage, type EnrichStats } from "../enrichment/enrich.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { loadSourcingBrain } from "./brain.ts";
import type { SourcingAdapters, StageContext } from "./context.ts";
import { SOURCING_FLAGS, SOURCING_LIMITS, readCeiling, readPromotionPolicy } from "./flags.ts";
import { promoteStage, type PromoteStats } from "./promote.ts";
import { qualifyStage, type QualifyStats } from "./qualify.ts";
import { searchStage, type SearchStats } from "./search.ts";
import { createSpendGate } from "./spend.ts";

export interface DiscoveryCycleInput {
  db: D1Database;
  kv: KVReader | undefined;
  flags: FlagReader;
  adapters: SourcingAdapters;
  now: Date;
  job: string;
  runId?: string;
  signal?: AbortSignal;
  log: JobLogger;
  /** The job's ceilings.maxSpendCents. */
  jobCapCents?: number;
  /** People kept per account candidate. */
  peoplePerAccount: number;
  /** New candidate rows the search stage may write in one run (the job's ceilings.maxRows). */
  maxRows?: number;
}

export interface DiscoveryCycleResult {
  brainVersion: string;
  search: SearchStats;
  enrich: EnrichStats | { skipped: string };
  qualify: QualifyStats | { skipped: string };
  promote: PromoteStats | { skipped: string };
  /** Why paid calls stopped, or null. */
  spendStopped: string | null;
  paidCalls: number;
}

export async function runDiscoveryCycle(input: DiscoveryCycleInput): Promise<DiscoveryCycleResult> {
  const brain = await loadSourcingBrain(input.kv);
  const gate = createSpendGate({
    db: input.db,
    flags: input.flags,
    job: input.job,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.jobCapCents !== undefined ? { jobCapCents: input.jobCapCents } : {}),
    log: input.log,
  });
  const ctx: StageContext = {
    db: input.db,
    flags: input.flags,
    brain,
    gate,
    now: input.now,
    job: input.job,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    log: input.log,
  };
  const [searches, resultsPerSearch, rawBacklogMax, enrichLimit, qualifyLimit, promoteLimit] = await Promise.all([
    readCeiling(input.flags, SOURCING_FLAGS.searchesPerCycle, SOURCING_LIMITS.searchesPerCycle, input.log),
    readCeiling(input.flags, SOURCING_FLAGS.resultsPerSearch, SOURCING_LIMITS.resultsPerSearch, input.log),
    readCeiling(input.flags, SOURCING_FLAGS.rawBacklogMax, SOURCING_LIMITS.rawBacklogMax, input.log),
    readCeiling(input.flags, SOURCING_FLAGS.enrichPerCycle, SOURCING_LIMITS.enrichPerCycle, input.log),
    readCeiling(input.flags, SOURCING_FLAGS.qualifyPerCycle, SOURCING_LIMITS.qualifyPerCycle, input.log),
    readCeiling(input.flags, SOURCING_FLAGS.promotePerCycle, SOURCING_LIMITS.promotePerCycle, input.log),
  ]);

  if (brain.degraded) {
    const skipped = { skipped: "the brain could not be read whole (a locked component is edited, a draft or invalid); nothing runs until it is re-locked" };
    const search: SearchStats = { searches: 0, inserted: 0, duplicates: 0, rejected: 0, errors: 0, budgetStopped: false, skipped: skipped.skipped };
    return { brainVersion: brain.version, search, enrich: skipped, qualify: skipped, promote: skipped, spendStopped: null, paidCalls: 0 };
  }
  const search = await searchStage(ctx, input.adapters.sources, { searches, resultsPerSearch, rawBacklogMax, ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}) });
  if (brain.personas.length === 0) {
    const skipped = { skipped: "no approved personas in the brain, so no title can pass person fit" };
    return { brainVersion: brain.version, search, enrich: skipped, qualify: skipped, promote: skipped, spendStopped: gate.stopped, paidCalls: gate.calls };
  }
  const enrich = await enrichStage(ctx, input.adapters, enrichLimit, { peoplePerAccount: input.peoplePerAccount });
  const qualify = await qualifyStage(ctx, qualifyLimit);
  const policy = await readPromotionPolicy(input.flags);
  const promote = await promoteStage(ctx, promoteLimit, { policy, verifier: input.adapters.verifier });
  return { brainVersion: brain.version, search, enrich, qualify, promote, spendStopped: gate.stopped, paidCalls: gate.calls };
}

/** A one-line summary for the run row. */
export function summarizeCycle(result: DiscoveryCycleResult): string {
  const enrich = "skipped" in result.enrich ? `enrich skipped (${result.enrich.skipped})` : `enriched ${result.enrich.enriched}, rejected ${result.enrich.rejected}, duplicate ${result.enrich.duplicate}`;
  const search = result.search.skipped ? `search skipped (${result.search.skipped})` : `${result.search.searches} searches, ${result.search.inserted} new`;
  return [
    search,
    enrich,
    "skipped" in result.qualify ? "qualify skipped" : `qualified ${result.qualify.qualified}, borderline ${result.qualify.borderline}`,
    "skipped" in result.promote ? "promote skipped" : `promoted ${result.promote.promoted}, held ${result.promote.held}`,
    `${result.paidCalls} paid calls`,
    ...(result.spendStopped ? [`stopped: ${result.spendStopped}`] : []),
  ].join("; ");
}
