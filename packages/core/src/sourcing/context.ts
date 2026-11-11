// GTM-agents: what every sourcing stage receives: the database, flags, brain, spend gate and adapters.
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { ContactFinder, EmailVerifier } from "../ports/contact.ts";
import type { CompanyResearchSource, DiscoverySource, PeopleProvider } from "../ports/discovery.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { SourcingBrain } from "./brain.ts";
import type { SpendGate } from "./spend.ts";

/** The adapters a deployment gives the sourcing jobs. Each is optional except where a stage needs it. */
export interface SourcingAdapters {
  /** Discovery sources searched by the cycle, in order. */
  sources: readonly DiscoverySource[];
  /** Finds people at an account a search turned up. Without it, account candidates are rejected. */
  people?: PeopleProvider;
  /** Email finders, in waterfall order. The first always runs; the rest need discovery:email_waterfall_enabled. */
  finders: readonly ContactFinder[];
  /** Verifies found addresses. Without it, nothing verifies and nothing is promoted. */
  verifier?: EmailVerifier;
  /** The model gateway, for the optional account fit score. */
  model?: ModelGateway;
  /** Company research, for the optional account research job. Without it, the job does nothing. */
  research?: CompanyResearchSource;
}

export interface StageContext {
  db: D1Database;
  flags: FlagReader;
  brain: SourcingBrain;
  gate: SpendGate;
  now: Date;
  job: string;
  runId?: string;
  signal?: AbortSignal;
  log: JobLogger;
}
