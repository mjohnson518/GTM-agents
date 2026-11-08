// GTM-agents: the one title classifier decides person fit, persona, seat and seniority from the brain.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyTitle, compareTitleClasses, seniorityOf, titleKey } from "../src/scoring/titles.ts";
import { loadSourcingBrain, type SourcingBrain } from "../src/sourcing/brain.ts";
import { uploadBrain } from "./sourcing-fakes.ts";

let brain: SourcingBrain;
beforeAll(async () => {
  await uploadBrain(env.KV);
  brain = await loadSourcingBrain(env.KV);
});

const classify = (title: string | null) => classifyTitle(title, brain.personas, { never: brain.never });

describe("classifyTitle", () => {
  it("keeps a title that contains a persona's title phrase, with that persona's seat", () => {
    expect(classify("VP Engineering")).toMatchObject({ decision: "keep", persona: "economic-buyer", seat: "decision_maker", seniority: "vp" });
    expect(classify("Senior Engineering Manager")).toMatchObject({ decision: "keep", persona: "engineering-manager", seat: "influencer" });
  });

  it("folds common spellings before matching", () => {
    expect(classify("Vice President of Engineering").decision).toBe("keep");
    expect(classify("SVP, Engineering").persona).toBe("economic-buyer");
    expect(classify("Sr. Engineering Mgr").persona).toBe("engineering-manager");
    expect(titleKey("Head of the Platform")).toBe("head platform");
  });

  it("prefers the longest matching phrase, then the higher seat", () => {
    expect(classify("CTO and Head of Engineering").persona).toBe("economic-buyer");
    expect(classify("Staff Engineer, Platform Lead").persona).toBe("platform-champion");
  });

  it("drops a title on the never list and a title with no persona phrase or seniority", () => {
    expect(classify("Agency Owner and VP Engineering")).toMatchObject({ decision: "drop", reason: "the title is on the never list" });
    expect(classify("Account Executive").decision).toBe("drop");
  });

  it("treats a persona exclusion as no match for that persona", () => {
    expect(classify("Engineering Manager Intern").persona).toBeNull();
  });

  it("leaves a title with only a persona seniority, or no title at all, as maybe", () => {
    expect(classify("Director of Sales")).toMatchObject({ decision: "maybe", seniority: "director" });
    expect(classify(null)).toMatchObject({ decision: "maybe", reason: "no title" });
    expect(classify("   ").decision).toBe("maybe");
  });

  it("lets a cached review settle a maybe, never a persona match", () => {
    const reviews = new Map<string, "keep" | "drop">([[titleKey("Director of Sales"), "keep"], [titleKey("VP Engineering"), "drop"]]);
    expect(classifyTitle("Director of Sales", brain.personas, { reviews }).decision).toBe("keep");
    expect(classifyTitle("VP Engineering", brain.personas, { reviews }).decision).toBe("keep");
  });

  it("matches nothing with no personas, so nothing can be kept", () => {
    expect(classifyTitle("VP Engineering", []).decision).toBe("drop");
  });
});

describe("seniorityOf", () => {
  it("reads the seniority a title states", () => {
    expect(["CTO", "Chief Technology Officer", "Co-founder"].map(seniorityOf)).toEqual(["c_level", "c_level", "c_level"]);
    expect(["Vice President, Product", "Head of Data", "Director of QA", "Engineering Manager", "Team Lead", "Staff Engineer", "Engineer"].map(seniorityOf)).toEqual([
      "vp",
      "head",
      "director",
      "manager",
      "lead",
      "senior",
      "individual",
    ]);
    expect(seniorityOf("Chief of Staff")).not.toBe("c_level");
  });
});

describe("compareTitleClasses", () => {
  it("orders keep first, then decision makers, then seniority", () => {
    const sorted = ["Staff Engineer", "Director of Sales", "VP Engineering", "Account Executive", "Engineering Manager"]
      .map((t) => ({ t, c: classify(t) }))
      .sort((a, b) => compareTitleClasses(a.c, b.c))
      .map((x) => x.t);
    expect(sorted).toEqual(["VP Engineering", "Engineering Manager", "Staff Engineer", "Director of Sales", "Account Executive"]);
  });
});
