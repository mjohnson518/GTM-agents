// GTM-agents: root Vitest configuration. Each project is one hermetic suite; `npm test` runs them all.
// packages/core runs inside the Workers runtime (workerd) with local D1, KV and R2 bindings.
// Behavior evals have their own configuration (tests/evals/vitest.config.ts) and run with `npm run eval`.
import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve(root, "packages/core/migrations"));
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
          test: {
            name: "cli",
            environment: "node",
            include: ["packages/cli/test/**/*.test.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: resolve(root, "packages/core/test/wrangler.test.jsonc") },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "core",
            include: ["packages/core/test/**/*.test.ts"],
            setupFiles: ["packages/core/test/setup.ts"],
          },
        },
      ],
    },
  };
});
