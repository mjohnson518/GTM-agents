// GTM-agents: root Vitest configuration. Each project is one hermetic suite; `npm test` runs them all.
// Behavior evals have their own configuration (tests/evals/vitest.config.ts) and run with `npm run eval`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/test/**/*.test.ts"],
        },
      },
    ],
  },
});
