// GTM-agents: behavior evals. Deterministic scenarios that score outbound text and decisions
// without network access. Run with `npm run eval`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "evals",
    environment: "node",
    include: ["tests/evals/**/*.eval.ts"],
  },
});
