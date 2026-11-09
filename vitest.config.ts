// GTM-agents: root Vitest configuration. Each project is one hermetic suite; `npm test` runs them all.
// packages/core and the security suite run inside the Workers runtime (workerd) with local D1, KV and
// R2 bindings.
// Behavior evals have their own configuration (tests/evals/vitest.config.ts) and run with `npm run eval`.
import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve(root, "packages/core/migrations"));
  // Suites that need the Workers runtime share one set of local bindings and the migrations.
  const workers = () =>
    cloudflareTest({
      wrangler: { configPath: resolve(root, "packages/core/test/wrangler.test.jsonc") },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    });
  return {
    test: {
      projects: [
        {
          test: {
            name: "scripts",
            environment: "node",
            include: ["scripts/test/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "contract",
            environment: "node",
            include: ["tests/contract/**/*.test.ts"],
          },
        },
        {
          // Adapter contract tests: hermetic, with recorded responses instead of the network.
          test: {
            name: "adapters",
            environment: "node",
            include: ["packages/adapters/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "cli",
            environment: "node",
            include: ["packages/cli/test/**/*.test.ts"],
          },
        },
        {
          // The dashboard's pure parts: the RPC client, state, formatting, URL checks and page hygiene.
          test: {
            name: "admin",
            environment: "node",
            include: ["apps/admin/test/**/*.test.ts"],
          },
        },
        {
          plugins: [workers()],
          test: {
            name: "core",
            include: ["packages/core/test/**/*.test.ts"],
            setupFiles: ["packages/core/test/setup.ts"],
          },
        },
        {
          // The security contract: properties every tool and every send path must keep.
          plugins: [workers()],
          test: {
            name: "security",
            include: ["tests/security/**/*.test.ts"],
            setupFiles: ["packages/core/test/setup.ts"],
          },
        },
      ],
    },
  };
});
