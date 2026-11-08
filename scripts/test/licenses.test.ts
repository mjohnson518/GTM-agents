// GTM-agents: tests for the production dependency license check.
import { describe, expect, it } from "vitest";
import { isAllowedLicense, productionPackages } from "../check-licenses.mjs";

describe("check-licenses", () => {
  it("accepts permissive licenses and SPDX OR expressions with one permissive alternative", () => {
    expect(isAllowedLicense("MIT")).toBe(true);
    expect(isAllowedLicense("BSD-3-Clause")).toBe(true);
    expect(isAllowedLicense("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(isAllowedLicense({ type: "ISC" })).toBe(true);
  });

  it("rejects copyleft, unknown and missing licenses, and AND expressions with a non-permissive part", () => {
    expect(isAllowedLicense("GPL-3.0-only")).toBe(false);
    expect(isAllowedLicense("(MIT AND GPL-3.0-only)")).toBe(false);
    expect(isAllowedLicense("UNLICENSED")).toBe(false);
    expect(isAllowedLicense(undefined)).toBe(false);
    expect(isAllowedLicense("(MIT OR Apache-2.0) AND GPL-3.0-only")).toBe(false);
  });

  it("sees the production dependencies of every workspace", () => {
    const names = productionPackages().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["hono", "zod", "lit"]));
    expect(names).not.toContain("vitest");
  });
});
