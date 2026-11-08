// GTM-agents: tests for the Markdown link check.
import { describe, expect, it } from "vitest";
import { checkLinks } from "../check-doc-links.mjs";

const existing = new Set(["README.md", "docs/ARCHITECTURE.md", "docs", "examples/brains"]);
const exists = (p: string) => existing.has(p);

describe("check-doc-links", () => {
  it("accepts relative links that resolve, with or without anchors", () => {
    const md = "See [architecture](ARCHITECTURE.md#bindings) and [home](../README.md) and [brains](../examples/brains/).";
    expect(checkLinks("docs/INTERFACES.md", md, exists)).toEqual([]);
  });

  it("reports a broken relative link with its line", () => {
    const [finding] = checkLinks("docs/INTERFACES.md", "intro\n[roadmap](ROADMAP.md)", exists);
    expect(finding).toMatchObject({ line: 2, rule: "broken-link" });
  });

  it("ignores external links, anchors, inline code and fenced code", () => {
    const md = [
      "[site](https://example.com) [mail](mailto:hi@acme.example) [top](#top)",
      "`[not a link](missing.md)`",
      "```",
      "[also not](missing.md)",
      "```",
    ].join("\n");
    expect(checkLinks("README.md", md, exists)).toEqual([]);
  });
});
