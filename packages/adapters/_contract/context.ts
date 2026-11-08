// GTM-agents: an AdapterContext for contract tests: named secrets, an injected fetch, a fixed clock
// and a logger that records instead of printing.
import type { AdapterContext } from "@gtm-agents/core/ports";

export interface TestContextOptions {
  secrets?: Record<string, string>;
  fetch?: typeof fetch;
  options?: Record<string, unknown>;
  now?: Date;
}

export interface TestContext extends AdapterContext {
  logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }>;
}

export function testContext(opts: TestContextOptions = {}): TestContext {
  const secrets = opts.secrets ?? {};
  const logs: TestContext["logs"] = [];
  const log = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    logs.push({ level, msg, ...(data ? { data } : {}) });
  };
  return {
    logs,
    secret(name) {
      const value = secrets[name];
      if (value === undefined) throw new Error(`missing secret ${name}`);
      return value;
    },
    optionalSecret: (name) => secrets[name],
    fetch:
      opts.fetch ??
      (() => {
        throw new Error("this test gave the adapter no fetch");
      }),
    now: () => opts.now ?? new Date("2026-11-04T12:00:00.000Z"),
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    options: opts.options ?? {},
  };
}
