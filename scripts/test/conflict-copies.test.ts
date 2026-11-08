// GTM-agents: tests for the conflict-copy check.
import { describe, expect, it } from "vitest";
import { isConflictCopy } from "../check-conflict-copies.mjs";

describe("check-conflict-copies", () => {
  it.each([
    "packages/core/src/index 2.ts",
    "docs/README 3.md",
    "notes (1).md",
    "config (Ada's conflicted copy 2026-01-02).json",
    "src/app.sync-conflict-20260101-120000-ABC.ts",
    "LICENSE 2",
  ])("flags %s", (path) => {
    expect(isConflictCopy(path)).toBe(true);
  });

  it.each(["packages/core/src/index.ts", "migrations/0002_event_effects.sql", "docs/ADR-2.md", "v2/file.ts"])(
    "accepts %s",
    (path) => {
      expect(isConflictCopy(path)).toBe(false);
    },
  );
});
