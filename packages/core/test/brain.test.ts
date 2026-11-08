// GTM-agents: tests for brain parsing, validation, the lock file and slice assembly.
import { describe, expect, it } from "vitest";
import { assembleSlice, renderComponent } from "../src/brain/assemble.ts";
import { TASK_SPECS } from "../src/brain/components.ts";
import { computeLock, parseLock, serializeLock } from "../src/brain/lock.ts";
import { parseBrainFile } from "../src/brain/parse.ts";
import { validateBrain } from "../src/brain/validate.ts";
import { brainFile, commercialBody, factsBody, personasBody, pillarsBody } from "./fixtures.ts";

const errors = (issues: Array<{ severity: string; message: string }>) => issues.filter((i) => i.severity === "error").map((i) => i.message);

describe("parseBrainFile", () => {
  it("parses frontmatter and typed items, and ignores notes before the first item", () => {
    const parsed = parseBrainFile("personas.md", brainFile("personas", personasBody));
    expect(errors(parsed.issues)).toEqual([]);
    expect(parsed.frontmatter).toMatchObject({ component: "personas", status: "approved", version: 1 });
    expect(parsed.items.map((i) => i.id)).toEqual(["economic-buyer", "platform-champion"]);
    expect(parsed.items[0]?.value).toMatchObject({ titles: ["VP Engineering", "Head of Engineering", "CTO"], seniority: ["c_level", "vp", "head"] });
  });

  it("rejects a file name that is not a component", () => {
    expect(errors(parseBrainFile("pricing.md", brainFile("commercial", commercialBody)).issues).join()).toMatch(/not a brain component/);
  });

  it("rejects a frontmatter component that does not match the file name", () => {
    expect(errors(parseBrainFile("facts.md", brainFile("voice", factsBody)).issues).join()).toMatch(/frontmatter says component/);
  });

  it("reports unknown fields, missing fields, bad enum values and stray lines with their line numbers", () => {
    const body = ["## bad-persona", "- role: wizard", "- seat: decision_maker", "- favorite_color: blue", "this line is not a bullet"].join("\n");
    const parsed = parseBrainFile("personas.md", brainFile("personas", body));
    const messages = errors(parsed.issues).join("\n");
    expect(messages).toMatch(/unknown field "favorite_color"/);
    expect(messages).toMatch(/missing required field "titles"/);
    expect(messages).toMatch(/role/);
    expect(messages).toMatch(/every line is a `- key: value` bullet/);
    expect(parsed.issues.every((i) => i.line > 0)).toBe(true);
  });

  it("rejects text longer than two sentences and em dashes", () => {
    const dash = String.fromCharCode(0x2014);
    const body = ["## wordy", "- kind: trend", `- text: One. Two. Three${dash}four.`].join("\n");
    const messages = errors(parseBrainFile("market-profile.md", brainFile("market-profile", body)).issues).join("\n");
    expect(messages).toMatch(/one or two sentences/);
    expect(messages).toMatch(/dashes/);
  });
});

describe("validateBrain", () => {
  const files = () => [
    { name: "README.md", content: "# Notes\n" },
    { name: "personas.md", content: brainFile("personas", personasBody) },
    { name: "facts.md", content: brainFile("facts", factsBody) },
    { name: "message-pillars.md", content: brainFile("message-pillars", pillarsBody) },
    { name: "commercial.md", content: brainFile("commercial", commercialBody) },
  ];

  it("accepts a valid partial brain, warning about missing components", async () => {
    const result = await validateBrain(files());
    expect(errors(result.issues)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.severity === "warning" && i.file === "icp.md")).toBe(true);
    expect(result.approved.map((f) => f.name).sort()).toEqual(["commercial.md", "facts.md", "message-pillars.md", "personas.md"]);
  });

  it("rejects a reference to an item that does not exist", async () => {
    const bad = files().map((f) => (f.name === "message-pillars.md" ? { ...f, content: f.content.replace("proof: median-setup", "proof: no-such-fact") } : f));
    expect(errors((await validateBrain(bad)).issues).join()).toMatch(/no-such-fact/);
  });

  it("rejects URLs outside url fields and prices outside commercial", async () => {
    const extra = [
      { name: "voice.md", content: brainFile("voice", "## link\n- kind: do\n- text: Point people to https://acme.example for details.") },
      { name: "objections.md", content: brainFile("objections", "## price\n- objection: Too expensive.\n- response: It costs $400 a month, less than one engineer-day.") },
    ];
    const messages = errors((await validateBrain([...files(), ...extra])).issues).join("\n");
    expect(messages).toMatch(/URLs are only allowed/);
    expect(messages).toMatch(/prices belong in commercial/);
  });

  it("requires never items in the ICP to name domains, accounts or titles", async () => {
    const icp = brainFile("icp", "## no-agencies\n- kind: never\n- text: We do not sell to agencies.");
    expect(errors((await validateBrain([{ name: "icp.md", content: icp }])).issues).join()).toMatch(/never item needs/);
  });

  it("does not serve or lock a draft", async () => {
    const result = await validateBrain([{ name: "facts.md", content: brainFile("facts", factsBody, { status: "draft" }) }]);
    expect(result.approved).toEqual([]);
    expect(result.issues.some((i) => i.message.includes("draft"))).toBe(true);
  });

  it("checks the lock: missing entries, changed files and a tampered hash", async () => {
    const all = files();
    const lock = await computeLock((await validateBrain(all)).approved);
    expect(errors((await validateBrain(all, { lock })).issues)).toEqual([]);

    const changed = all.map((f) => (f.name === "facts.md" ? { ...f, content: f.content.replace("under an hour", "in minutes") } : f));
    expect(errors((await validateBrain(changed, { lock })).issues).join()).toMatch(/changed since it was locked/);

    const tampered = { ...lock, hash: "0".repeat(64) };
    expect(errors((await validateBrain(all, { lock: tampered })).issues).join()).toMatch(/lock hash/);

    const noLock = await validateBrain(all, { lock: null });
    expect(noLock.issues.some((i) => i.severity === "warning" && i.message.includes("no lock file"))).toBe(true);
  });

  it("round-trips the lock through its file format", async () => {
    const lock = await computeLock([{ name: "facts.md", content: "x" }]);
    expect(parseLock(serializeLock(lock))).toEqual(lock);
    expect(parseLock("not json")).toBeNull();
    expect(parseLock(null)).toBeNull();
  });
});

describe("assembleSlice", () => {
  const facts = parseBrainFile("facts.md", brainFile("facts", factsBody));
  const commercial = parseBrainFile("commercial.md", brainFile("commercial", commercialBody));
  const personas = parseBrainFile("personas.md", brainFile("personas", personasBody));

  it("starts with the version header and names what is missing", () => {
    const servable = new Map([["facts", renderComponent("facts", 1, facts.items)]] as const);
    const slice = assembleSlice("replies", "3f9a1c0b7d2e", servable);
    expect(slice.text.startsWith("GTM BRAIN (version 3f9a1c0b7d2e, operator-approved; task: replies)")).toBe(true);
    expect(slice.included).toEqual(["facts"]);
    expect(slice.missing).toEqual(["objections", "competitors", "voice", "stack"]);
    expect(slice.text).toContain("Do not fill these in from memory");
    expect(slice.bytes).toBeLessThanOrEqual(TASK_SPECS.replies.budgetBytes);
  });

  it("never gives commercial terms to a prospect-facing writer", () => {
    const servable = new Map([
      ["commercial", renderComponent("commercial", 1, commercial.items)],
      ["personas", renderComponent("personas", 1, personas.items)],
    ] as const);
    expect(assembleSlice("outreach", "v", servable).text).not.toContain("Team");
    expect(assembleSlice("close", "v", servable).included).toEqual(["commercial"]);
  });

  it("drops a whole component that does not fit, rather than cutting it", () => {
    const huge = `### icp (v1)\n${"- filler: text: lorem\n".repeat(200)}`;
    const slice = assembleSlice("fit", "v", new Map([["icp", huge]] as const));
    expect(slice.included).toEqual([]);
    expect(slice.text).not.toContain("filler");
    expect(slice.missing).toEqual(["icp"]);
  });

  it("names every component as missing when nothing is servable", () => {
    const slice = assembleSlice("strategist", "unlocked", new Map());
    expect(slice.included).toEqual([]);
    expect(slice.text).toContain("Missing from the brain for this task: market-profile, icp, personas, message-pillars, competitors, commercial.");
    expect(slice.bytes).toBeLessThanOrEqual(TASK_SPECS.strategist.budgetBytes);
  });
});
