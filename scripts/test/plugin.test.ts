// GTM-agents: tests for the Claude Code plugin check.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_BLOB, anchorsOf, checkPlugins } from "../check-plugin.mjs";
import { repoRoot } from "../lib/files.mjs";

const SKILL = ["---", "name: hello", "description: Say hello. Use when the person asks for a greeting.", "---", "", "# Hello", "", `Read [the guide](${REPO_BLOB}docs/GUIDE.md#getting-started).`, ""].join("\n");

/** A repository with a marketplace, one plugin, one skill and the doc it links to. */
function repo(overrides: { marketplace?: unknown; manifest?: unknown; skill?: string; skillDir?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gtm-plugin-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(".claude-plugin/marketplace.json", JSON.stringify(overrides.marketplace ?? { name: "acme", owner: { name: "Acme maintainers" }, plugins: [{ name: "acme", source: "./plugins/acme" }] }));
  write("plugins/acme/.claude-plugin/plugin.json", JSON.stringify(overrides.manifest ?? { name: "acme", version: "0.1.0", description: "Acme skills." }));
  write(`plugins/acme/skills/${overrides.skillDir ?? "hello"}/SKILL.md`, overrides.skill ?? SKILL);
  write("docs/GUIDE.md", "# Guide\n\n## Getting started\n\nText.\n");
  return root;
}

const details = (root: string) => checkPlugins(root).map((f) => f.detail);

describe("check-plugin", () => {
  it("accepts a marketplace, plugin and skill that install and read as intended", () => {
    expect(checkPlugins(repo())).toEqual([]);
  });

  it("reports an entry whose name differs from the plugin's manifest", () => {
    expect(details(repo({ manifest: { name: "acme-tools", version: "0.1.0", description: "x" } }))).toEqual([expect.stringMatching(/differs from the marketplace entry "acme"/)]);
  });

  it("reports a source that leaves the repository or does not exist", () => {
    const leaves = { name: "acme", owner: { name: "o" }, plugins: [{ name: "acme", source: "./../plugins/acme" }] };
    expect(details(repo({ marketplace: leaves }))).toEqual([expect.stringMatching(/contains \.\./)]);
    const missing = { name: "acme", owner: { name: "o" }, plugins: [{ name: "acme", source: "./plugins/other" }] };
    expect(details(repo({ marketplace: missing }))).toEqual([expect.stringMatching(/does not exist/)]);
  });

  it("reports a marketplace without an owner", () => {
    expect(details(repo({ marketplace: { name: "acme", plugins: [{ name: "acme", source: "./plugins/acme" }] } }))).toEqual(["needs owner.name"]);
  });

  it("reports a skill whose name differs from its folder, or whose description is missing or too long", () => {
    expect(details(repo({ skillDir: "greet" }))).toEqual([expect.stringMatching(/differs from its folder "greet"/)]);
    expect(details(repo({ skill: SKILL.replace(/description: .*\n/, "") }))).toEqual(["needs a description"]);
    expect(details(repo({ skill: SKILL.replace(/description: .*/, `description: ${"x".repeat(1100)}`) }))).toEqual([expect.stringMatching(/keep it to 1024/)]);
  });

  it("reports a relative link that leaves the plugin, and a GitHub link to a missing file or heading", () => {
    expect(details(repo({ skill: `${SKILL}See [the guide](../../../../docs/GUIDE.md).\n` }))).toEqual([expect.stringMatching(/leaves the plugin folder/)]);
    expect(details(repo({ skill: `${SKILL}See [missing](${REPO_BLOB}docs/NOPE.md).\n` }))).toEqual(["docs/NOPE.md does not exist in this repository"]);
    expect(details(repo({ skill: `${SKILL}See [anchor](${REPO_BLOB}docs/GUIDE.md#nowhere).\n` }))).toEqual(["docs/GUIDE.md has no heading #nowhere"]);
  });

  it("derives GitHub's anchors, with numbered repeats", () => {
    expect([...anchorsOf("## 9. Staged rollout\n### 4.2 The domain and the sending subdomain\n## Notes\n## Notes\n```\n## not a heading\n```\n")]).toEqual([
      "9-staged-rollout",
      "42-the-domain-and-the-sending-subdomain",
      "notes",
      "notes-1",
    ]);
  });

  it("passes the repository's own marketplace and plugin", () => {
    expect(checkPlugins(repoRoot())).toEqual([]);
  });
});
