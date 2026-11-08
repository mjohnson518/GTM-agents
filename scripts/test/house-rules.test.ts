// GTM-agents: tests for the house-rule check (no em or en dashes in tracked text).
import { describe, expect, it } from "vitest";
import { scanHouseRules } from "../check-house-rules.mjs";

const emDash = String.fromCharCode(0x2014);
const enDash = String.fromCharCode(0x2013);

describe("check-house-rules", () => {
  it("rejects an em dash and reports its line and column", () => {
    const [finding] = scanHouseRules("docs/x.md", `first line\nfast${emDash}and cheap`);
    expect(finding).toMatchObject({ line: 2, rule: "house-rule" });
    expect(finding?.detail).toContain("column 5");
  });

  it("rejects an en dash", () => {
    expect(scanHouseRules("docs/x.md", `pages 3${enDash}5`)).toHaveLength(1);
  });

  it("accepts commas, colons, parentheses and plain hyphens", () => {
    expect(scanHouseRules("docs/x.md", "fast, cheap: and well-tested (mostly)")).toEqual([]);
  });
});
