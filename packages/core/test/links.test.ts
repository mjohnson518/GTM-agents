// GTM-agents: tests for the one definition of a link (packages/core/src/shared/links.ts) and the
// checks that read it.
import { describe, expect, it } from "vitest";
import { editProblems } from "../src/learning/brain-edit.ts";
import { createLearningProposal } from "../src/learning/proposals.ts";
import { defang, hasLink, snippetProblems } from "../src/learning/text.ts";
import { proposalNote } from "../src/signals/competitors.ts";
import { containsLink, linksIn } from "../src/shared/links.ts";

describe("what counts as a link", () => {
  it("finds full URLs, www. links and bare hosts on any top-level domain, with their paths", () => {
    expect(linksIn("See https://news.example/a, www.acme.example and globex-login.ru or acme.click/offer.")).toEqual([
      "https://news.example/a",
      "www.acme.example",
      "globex-login.ru",
      "acme.click/offer",
    ]);
  });

  it("does not count an address, an abbreviation, a version or a figure", () => {
    for (const text of ["Write to ops@acme.example.", "Fewer reruns, e.g. on Monday.", "Sold in the U.S. first.", "Version 1.2 ships.", "3.5x faster builds."]) expect(containsLink(text), text).toBe(false);
  });
});

describe("the self-improvement checks use the same definition", () => {
  it("refuses a brain edit or a snippet naming a host the old fixed list missed, and an address", () => {
    const before = [{ id: "globex", fields: { name: "Globex", positioning: "A CI dashboard." } }];
    for (const positioning of ["Confirm at globex-login.ru today.", "Pricing is at acme.click/plans.", "Write to sales@globex.example."]) {
      const problems = editProblems({ component: "competitors", before, after: [{ id: "globex", fields: { name: "Globex", positioning } }], knownText: "" });
      expect(problems, positioning).toContain("field globex.positioning holds a link");
    }
    expect(snippetProblems("Book at acme.click/now.")).toContain("it holds a link or a host name");
    expect(hasLink("Plain words only.")).toBe(false);
  });

  it("breaks every link in an example kept as data", () => {
    expect(defang("Go to acme.click/offer or https://news.example/a")).toBe("Go to acme[.]click/offer or hxxps://news[.]example/a");
    expect(defang("Mirror at ftp://evil.example or see docs/evil.example")).toBe("Mirror at ftp://evil[.]example or see docs/evil[.]example");
  });

  it("is wider than the outbound definition: any scheme, and a host joined to a path, dots or a dash", () => {
    for (const text of ["see docs/globex-login.ru", "moved...globex-login.ru", "ftp://globex-login.ru", "a globex.ru-hosted mirror", "-evil.example", "open ftp://intranet/files"]) {
      expect(hasLink(text), text).toBe(true);
      expect(proposalNote(text), text).toBe("");
      expect(snippetProblems(text), text).toContain("it holds a link or a host name");
    }
  });

  it("lets a search query name a product such as Next.js, but never a URL", async () => {
    const { env } = await import("cloudflare:workers");
    const query = (q: string) => createLearningProposal(env.DB, { kind: "discovery_query", payload: { source: "exa", query: q }, proposedBy: "retrospective" }, new Date("2026-11-17T09:00:00.000Z"));
    expect((await query("Next.js platform teams hiring")).ok).toBe(true);
    expect(await query("teams listed at https://jobs.example/next")).toMatchObject({ ok: false });
  });

  it("never blocks an edit for text already served unchanged, only for what the edit changes", () => {
    const before = [
      { id: "vercelish", fields: { name: "Vercelish", positioning: "Hosting for Next.js apps." } },
      { id: "globex", fields: { name: "Globex", positioning: "A CI dashboard." } },
    ];
    const after = [before[0]!, { id: "globex", fields: { name: "Globex", positioning: "A CI dashboard that retries failed tests." } }];
    expect(editProblems({ component: "competitors", before, after, knownText: "" })).toEqual([]);
    const changed = [{ id: "vercelish", fields: { name: "Vercelish", positioning: "Hosting for Next.js and Nuxt apps." } }, before[1]!];
    expect(editProblems({ component: "competitors", before, after: changed, knownText: "" })).toContain("field vercelish.positioning holds a link");
  });
});
