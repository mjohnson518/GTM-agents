// GTM-agents: what the OperatorGateway Durable Object needs from the deployment, and the optional
// sources other modules plug into the dashboard.
//
// The Durable Object is constructed by the runtime, not by createWorker, so createWorker registers
// its configuration and factories here when the Worker module loads. The object reads them back
// per request. Until something is registered, /ws answers 503.
import type { GtmConfig } from "../config/schema.ts";
import type { Env } from "../env.ts";
import type { JobRegistry } from "../jobs/registry.ts";
import type { EmailProvider, InboxProvider } from "../ports/email.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { TemplateFile } from "../templates/store.ts";
import type { Proposal } from "./protocol.ts";

/** A source of proposals the dashboard lists, approves and rejects. Each source owns its own rules. */
export interface ProposalSource {
  source: Proposal["source"];
  /** Open proposals, newest first. Ids are the source's own; the gateway prefixes them with the source. */
  list(now: Date): Promise<Proposal[]>;
  /** The proposal as it stands now, re-read from the source's store, or null. */
  get(id: string, now: Date): Promise<Proposal | null>;
  /**
   * Apply it through the source's own approval path. The gateway has already checked the operator's
   * shown digest against the read that returned `sourceDigest` (the `digest` field of `get`), so a
   * source that binds approvals to content approves exactly that digest, never a fresh read's.
   */
  approve(id: string, input: { actor: string; confirmCode?: string; sourceDigest: string; now: Date }): Promise<{ ok: boolean; message: string }>;
  reject(id: string, input: { actor: string; reason?: string; now: Date }): Promise<{ ok: boolean; message: string }>;
}

/** Daily fitness scores, from the self-improvement module once it is installed. */
export interface FitnessSource {
  trend(days: number, now: Date): Promise<Array<{ day: string; score: number | null; dimensions: Record<string, number | null> }>>;
}

/** The learning module's summary and session search, once it is installed. */
export interface LearningSource {
  summary(now: Date): Promise<Record<string, unknown>>;
  historySearch?(q: string, limit: number, now: Date): Promise<Array<{ sessionKey: string; at: string; snippet: string }>>;
}

/** The link-intake module's status, once it is installed. */
export interface LinkTriageSource {
  status(now: Date): Promise<Record<string, unknown>>;
}

/** Optional dashboard sources, given to createWorker as `dashboard`. */
export interface DashboardExtensions<E extends Env = Env> {
  /** More proposal sources, for example learnings from the self-improvement module. */
  proposals?: Array<(env: E) => ProposalSource | undefined>;
  fitness?: (env: E) => FitnessSource | undefined;
  learning?: (env: E) => LearningSource | undefined;
  linkTriage?: (env: E) => LinkTriageSource | undefined;
}

export interface GatewayWiring<E extends Env = Env> {
  config: GtmConfig;
  registry: () => JobRegistry<E>;
  operator?: (env: E) => OperatorChannel | undefined;
  model?: (env: E) => ModelGateway | undefined;
  email?: (env: E) => EmailProvider | undefined;
  inbox?: (env: E) => InboxProvider | undefined;
  /** True when the deployment wired the product bridge (createWorker's `lifecycle`). */
  lifecycle: boolean;
  agent: { maxRounds?: number; maxTokens?: number; templates?: readonly TemplateFile[]; fetch?: typeof fetch; owedWindowDays?: number };
  extensions: DashboardExtensions<E>;
}

let registered: GatewayWiring<Env> | undefined;

/** Called by createWorker. The last registration wins (one Worker module registers once). */
export function registerGateway<E extends Env>(wiring: GatewayWiring<E>): void {
  registered = wiring as unknown as GatewayWiring<Env>;
}

export function gatewayWiring<E extends Env = Env>(): GatewayWiring<E> | undefined {
  return registered;
}

/** Build an adapter, treating a throw (a missing secret) as not configured. */
export function tryBuild<E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined {
  try {
    return factory?.(env) ?? undefined;
  } catch {
    return undefined;
  }
}
