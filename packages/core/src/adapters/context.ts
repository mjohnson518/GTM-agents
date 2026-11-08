// GTM-agents: the AdapterContext core hands to each adapter's createAdapter(ctx).
//
// It gives an adapter what it needs to call its vendor:
//   - secret(name) reads a named secret from the Worker environment and throws when it is missing
//     (any secret in the environment is readable, so adapters are reviewed code, not a sandbox),
//     so a misconfigured adapter fails at its first call instead of sending half-authenticated
//     requests; optionalSecret(name) returns undefined instead;
//   - fetch is the injected fetch, wrapped with a time-out (and the caller's abort signal) and with
//     outbound logging of method, host and status, never of headers or bodies;
//   - options are the adapter's non-secret options from gtm.config.ts (adapters.<name>.options).
import type { GtmConfig } from "../config/schema.ts";
import type { AdapterContext, AdapterLogger } from "../ports/types.ts";

export const DEFAULT_ADAPTER_TIMEOUT_MS = 20_000;

export interface AdapterContextOptions {
  /** The adapter's name, as in gtm.config.ts and its manifest. */
  name: string;
  /** Where secrets are read from: the Worker environment. */
  env: Readonly<Record<string, unknown>>;
  config?: Pick<GtmConfig, "adapters">;
  /** The underlying fetch. Defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  logger?: AdapterLogger;
}

function consoleAdapterLogger(name: string): AdapterLogger {
  const write = (level: "debug" | "info" | "warn" | "error") => (msg: string, data?: Record<string, unknown>) =>
    console[level === "debug" ? "log" : level](JSON.stringify({ level, adapter: name, msg, ...(data ?? {}) }));
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export function createAdapterContext(options: AdapterContextOptions): AdapterContext {
  const logger = options.logger ?? consoleAdapterLogger(options.name);
  const baseFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const read = (name: string): string | undefined => {
    const value = options.env[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const signals = [AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])];
    const started = Date.now();
    const host = URL.canParse(request.url) ? new URL(request.url).host : "unparseable";
    try {
      const response = await baseFetch(request, { signal: AbortSignal.any(signals) });
      logger.debug("outbound request", { method: request.method, host, status: response.status, ms: Date.now() - started });
      return response;
    } catch (error) {
      logger.warn("outbound request failed", { method: request.method, host, ms: Date.now() - started, timeout: error instanceof DOMException && error.name === "TimeoutError" });
      throw error;
    }
  };
  return {
    secret(name) {
      const value = read(name);
      if (value === undefined) throw new Error(`adapter ${options.name} needs the secret ${name}; set it with wrangler secret put ${name}`);
      return value;
    },
    optionalSecret: (name) => read(name),
    fetch: wrappedFetch,
    now: options.now ?? (() => new Date()),
    logger,
    options: { ...(options.config?.adapters[options.name]?.options ?? {}) },
  };
}
