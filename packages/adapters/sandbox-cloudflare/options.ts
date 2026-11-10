// GTM-agents: the sandbox-cloudflare adapter's options and limits, read from
// adapters.sandbox-cloudflare.options in gtm.config.ts. None of them is secret; secrets are named
// here and read from the Worker environment by the egress entrypoint only.
import type { CodingSandboxLimits } from "@gtm-agents/core/ports";

export type ProfileName = "claude-code" | "opencode";
export type ModelApi = "anthropic" | "openai";

export const PROFILES: readonly ProfileName[] = ["claude-code", "opencode"];

/** Model requests per task, across the agent round and the repair round. */
export const MAX_MODEL_TURNS = 80;
/** What each agent round may use of MAX_MODEL_TURNS, passed to the agent CLI where it takes a limit. */
export const ROUND_TURNS = Object.freeze({ agent: 64, repair: 16 });
/** The container stops after this long without a call to its Durable Object. */
export const INACTIVITY_TIMEOUT_MS = 45 * 60 * 1000;

export const DEFAULT_LIMITS: Readonly<CodingSandboxLimits> = Object.freeze({
  maxDiffBytes: 2 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  maxFiles: 100,
  maxModelTurns: MAX_MODEL_TURNS,
});

/**
 * Model calls one task may have in flight at once. The budget gate is read before each call and
 * the cost is recorded after it, so calls in flight together can pass the gate on the same reading:
 * this bounds how far past the budget a task can run to this many calls of at most
 * MAX_OUTPUT_TOKENS each.
 */
export const MAX_CONCURRENT_MODEL_CALLS = 2;

/** What the sandbox's model calls may cost in one UTC day, across every task, in cents. */
export const DEFAULT_DAILY_SPEND_CENTS = 2000;

/** The flags the model gate always requires on. */
export const REQUIRED_FLAGS: readonly string[] = ["ship:enabled", "ship:builds_enabled"];

/** Per-command time limits, in seconds. The command is stopped at its limit. */
export const DEFAULT_TIMEOUTS = Object.freeze({ prepare: 15 * 60, agent: 40 * 60, checks: 15 * 60, collect: 120 });

export interface ModelRoute {
  api: ModelApi;
  /** The hostname the agent in the container calls, intercepted by the Worker. */
  host: string;
  /**
   * Where the Worker forwards the request, standing in for the API's /v1 prefix: the vendor's API
   * (https://api.anthropic.com/v1), or an AI Gateway provider URL (.../anthropic/v1, .../openai, .../compat).
   */
  upstream: string;
  /** The Worker secret holding the vendor key. */
  keySecret: string;
  /** True when modelBaseUrl is set: the upstream is a gateway, and only then is the gateway token sent. */
  viaGateway: boolean;
  /** With an AI Gateway upstream: the Worker secret holding the gateway token, sent as cf-aig-authorization. */
  gatewayTokenSecret: string;
  /** Leave the vendor key out and let an authenticated gateway supply the key it stores. */
  byok: boolean;
}

export interface SandboxOptions {
  profile: ProfileName;
  /** The git host the clone comes from. Only a read-only clone of the task's repository passes. */
  gitHost: string;
  /** Package registry hosts the install may read from, GET and HEAD only. */
  registryHosts: readonly string[];
  model: ModelRoute;
  /** The container instance type. */
  instance: string;
  /** The Worker secret holding the git host token for the read-only clone. */
  gitTokenSecret: string;
  limits: CodingSandboxLimits;
  timeouts: { prepare: number; agent: number; checks: number; collect: number };
  /** Flags that must read "true" for the model to be called. Any other value, or a read error, refuses. */
  requiredFlags: readonly string[];
  /**
   * The daily cap on the sandbox's model spend, in cents, enforced whatever the global budget mode.
   * The flag budget:job:ship_build:daily_cents can lower it further.
   */
  dailySpendCents: number;
  /** Model calls one task may have in flight at once (1 or MAX_CONCURRENT_MODEL_CALLS). */
  concurrentModelCalls: number;
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SECRET = /^[A-Z][A-Z0-9_]*$/;
const INSTANCE = /^(?:lite|basic|standard-[1-4])$/;

const host = (value: unknown, fallback: string): string => (typeof value === "string" && HOST.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : fallback);
const secretName = (value: unknown, fallback: string): string => (typeof value === "string" && SECRET.test(value) ? value : fallback);
const httpsBase = (value: unknown): string | null => (typeof value === "string" && /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%/-]*)?$/i.test(value) ? value.replace(/\/+$/, "") : null);

function positive(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function modelRoute(raw: Record<string, unknown>, profile: ProfileName): ModelRoute {
  const api: ModelApi = profile === "opencode" && raw.modelApi === "openai" ? "openai" : "anthropic";
  const defaults = api === "openai" ? { host: "api.openai.com", upstream: "https://api.openai.com/v1", key: "OPENAI_API_KEY" } : { host: "api.anthropic.com", upstream: "https://api.anthropic.com/v1", key: "ANTHROPIC_API_KEY" };
  const gateway = httpsBase(raw.modelBaseUrl);
  return {
    api,
    host: host(raw.modelHost, defaults.host),
    upstream: gateway ?? defaults.upstream,
    keySecret: secretName(raw.modelKeySecret, defaults.key),
    viaGateway: gateway !== null,
    gatewayTokenSecret: secretName(raw.gatewayTokenSecret, "AI_GATEWAY_TOKEN"),
    // A stored key only exists on a gateway, so byok means nothing without one.
    byok: gateway !== null && raw.byok === true,
  };
}

/** Read the adapter options, falling back to the documented defaults for anything missing or malformed. Pure. */
export function readSandboxOptions(raw: Record<string, unknown> = {}): SandboxOptions {
  const profile: ProfileName = raw.profile === "opencode" ? "opencode" : "claude-code";
  const registries = Array.isArray(raw.registryHosts) ? raw.registryHosts.map((h) => host(h, "")).filter((h) => h !== "") : [];
  const limits = typeof raw.limits === "object" && raw.limits !== null ? (raw.limits as Record<string, unknown>) : {};
  const timeouts = typeof raw.timeouts === "object" && raw.timeouts !== null ? (raw.timeouts as Record<string, unknown>) : {};
  return {
    profile,
    gitHost: host(raw.gitHost, "github.com"),
    registryHosts: registries.length > 0 ? [...new Set(registries)] : ["registry.npmjs.org"],
    model: modelRoute(raw, profile),
    instance: typeof raw.instance === "string" && INSTANCE.test(raw.instance) ? raw.instance : "standard-2",
    gitTokenSecret: secretName(raw.gitTokenSecret, "GITHUB_TOKEN"),
    // The limits can only be lowered from the defaults, never raised past them.
    limits: {
      maxDiffBytes: positive(limits.maxDiffBytes, DEFAULT_LIMITS.maxDiffBytes, DEFAULT_LIMITS.maxDiffBytes),
      maxFileBytes: positive(limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
      maxFiles: positive(limits.maxFiles, DEFAULT_LIMITS.maxFiles, DEFAULT_LIMITS.maxFiles),
      maxModelTurns: positive(limits.maxModelTurns, MAX_MODEL_TURNS, MAX_MODEL_TURNS),
    },
    timeouts: {
      prepare: positive(timeouts.prepare, DEFAULT_TIMEOUTS.prepare, 30 * 60),
      agent: positive(timeouts.agent, DEFAULT_TIMEOUTS.agent, 40 * 60),
      checks: positive(timeouts.checks, DEFAULT_TIMEOUTS.checks, 30 * 60),
      collect: DEFAULT_TIMEOUTS.collect,
    },
    // Can only be lowered, to one call at a time.
    concurrentModelCalls: positive(raw.concurrentModelCalls, MAX_CONCURRENT_MODEL_CALLS, MAX_CONCURRENT_MODEL_CALLS),
    dailySpendCents: typeof raw.dailySpendCents === "number" && Number.isInteger(raw.dailySpendCents) && raw.dailySpendCents >= 0 ? raw.dailySpendCents : DEFAULT_DAILY_SPEND_CENTS,
    // Options can add flags to the model gate, never remove the ship flags from it.
    requiredFlags: [...new Set([...REQUIRED_FLAGS, ...(Array.isArray(raw.requiredFlags) ? raw.requiredFlags.filter((f): f is string => typeof f === "string" && /^[a-z0-9_:-]{1,100}$/.test(f)) : [])])],
  };
}
