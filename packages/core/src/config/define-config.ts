// GTM-agents: defineConfig(), the typed entry point for gtm.config.ts.
import { z } from "zod";
import { configSchema, type GtmConfig, type GtmConfigInput } from "./schema.ts";

export class ConfigError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[], pretty: string) {
    super(`gtm.config.ts is invalid:\n${pretty}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Validate a deployment's configuration, apply defaults and return it frozen. Throws ConfigError. */
export function defineConfig(input: GtmConfigInput): GtmConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) throw new ConfigError(result.error.issues, z.prettifyError(result.error));
  return deepFreeze(result.data);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
