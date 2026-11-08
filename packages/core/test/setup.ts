// GTM-agents: applies the D1 migrations before the core tests run, so every test sees the schema
// a fresh deployment would have.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
