// GTM-agents: types shared by every port. docs/INTERFACES.md is the reference for this contract.

export const TAINT_LEVELS = ["none", "metadata", "structured", "full"] as const;
export type TaintLevel = (typeof TAINT_LEVELS)[number];

export interface AdapterLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface AdapterContext {
  /** Named secret from the Worker environment; throws if it is missing and the manifest requires it. */
  secret(name: string): string;
  /** Optional secret; undefined when unset. */
  optionalSecret(name: string): string | undefined;
  /** Injected fetch. Core wraps it with timeouts and outbound logging. */
  fetch: typeof fetch;
  now(): Date;
  logger: AdapterLogger;
  /** Non-secret adapter options from gtm.config.ts (`adapters.<name>.options`). */
  options: Record<string, unknown>;
}

export interface Cost {
  provider: string;
  capability: string;
  credits?: number;
  usd?: number;
  /** Rows, tokens, emails: whatever the price table counts. */
  units?: number;
}

export type AdapterErrorCode = "auth" | "rate_limited" | "quota" | "not_found" | "invalid" | "unavailable" | "timeout" | "unknown";

/** Tokens a vendor billed for a call that then failed. */
export interface BilledUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  /**
   * What the vendor billed before the call failed, when the adapter knows it: a model stream cut
   * off, aborted or ended by an error after it started. Core records its cost, so a failed call is
   * still counted against the budget. Undefined when nothing was billed or it cannot be known.
   */
  readonly usage: BilledUsage | undefined;

  constructor(message: string, code: AdapterErrorCode, retryable: boolean, options: { retryAfterMs?: number; cause?: unknown; usage?: BilledUsage } = {}) {
    super(message, { cause: options.cause });
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.usage = options.usage;
  }
}

export interface Page<T> {
  items: T[];
  /** Undefined when there is no next page. */
  cursor?: string;
  cost?: Cost;
}

export interface Evidence {
  url?: string;
  /** Short; core sanitizes it before storage. */
  quote?: string;
  provider: string;
  /** ISO 8601. */
  retrievedAt: string;
}
