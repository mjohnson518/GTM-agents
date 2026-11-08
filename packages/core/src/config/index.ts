// GTM-agents: public entry point for configuration. Safe to import from Node (the CLI) and from
// the Worker; it has no runtime dependency on Cloudflare APIs.
export { ConfigError, defineConfig } from "./define-config.ts";
export { configSchema } from "./schema.ts";
export type { GtmConfig, GtmConfigInput } from "./schema.ts";
export { CORE_SECRETS, REQUIRED_BINDINGS } from "./bindings.ts";
export type { BindingKind, BindingSpec, SecretSpec } from "./bindings.ts";
