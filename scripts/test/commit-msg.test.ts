// GTM-agents: tests for the shared commit message check.
import { describe, expect, it } from "vitest";
import { checkCommitMessage } from "../check-commit-msg.mjs";

describe("check-commit-msg", () => {
  it("accepts a short capitalized subject, with or without a body", () => {
    expect(checkCommitMessage("Add suppression list\n")).toEqual([]);
    expect(checkCommitMessage("Add suppression list\n\nExplains why.\n")).toEqual([]);
  });

  it("ignores git's comment lines", () => {
    expect(checkCommitMessage("# Please enter the commit message\nAdd taint model\n")).toEqual([]);
  });

  it("rejects an empty message", () => {
    expect(checkCommitMessage("# only comments\n\n")).toEqual(["the commit message is empty"]);
  });

  it("rejects a lowercase subject, a trailing period and an overlong subject", () => {
    expect(checkCommitMessage("add taint model")).toHaveLength(1);
    expect(checkCommitMessage("Add taint model.")).toHaveLength(1);
    expect(checkCommitMessage(`Add ${"x".repeat(80)}`)).toHaveLength(1);
  });
});
