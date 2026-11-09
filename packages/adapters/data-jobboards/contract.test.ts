// GTM-agents: contract tests for the public job boards adapter. Every response is recorded and
// synthetic: the boards, tokens and postings are invented.
import { manifestSchema } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import manifest from "./manifest.json";
import { BOARD_HOSTS, boardUrl, createAdapter, roleKind } from "./index.ts";

const now = new Date("2026-11-04T12:00:00.000Z");
const adapterWith = (routes: RecordedRoute[]) => {
  const recorded = recordedFetch(routes);
  return { recorded, adapter: createAdapter(testContext({ fetch: recorded.fetch, now })) };
};

const greenhouse = {
  jobs: [
    { id: 1, title: "Senior Platform Engineer", first_published: "2026-10-30T10:00:00-04:00", updated_at: "2026-11-03T10:00:00Z", departments: [{ name: "Engineering" }] },
    { id: 2, title: "Staff Software Engineer, Build Systems", updated_at: "2026-11-04T10:00:00Z" },
    { id: 3, title: "Account Executive", updated_at: "2026-10-01T10:00:00Z" },
    { id: 4, title: "Data Scientist", updated_at: "2026-09-01T10:00:00Z" },
  ],
};
const lever = [
  { id: "a", text: "Product Designer", createdAt: Date.parse("2026-10-29T00:00:00Z"), categories: { team: "Design" } },
  { id: "b", text: "Customer Success Manager", createdAt: Date.parse("2026-10-15T00:00:00Z") },
];
const ashby = { jobs: [{ id: "x", title: "Recruiter", publishedAt: "2026-10-25T00:00:00Z", isListed: true }, { id: "y", title: "Hidden role", isListed: false }] };

describe("the job boards adapter", () => {
  let globalFetch: { mock: { calls: unknown[] }; mockRestore(): void };
  beforeEach(() => {
    globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("adapters use ctx.fetch, never the global fetch");
    });
  });
  afterEach(() => {
    const calls = globalFetch.mock.calls.length;
    globalFetch.mockRestore();
    expect(calls, "the adapter called the global fetch").toBe(0);
  });

  it("ships a valid manifest", () => {
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.name).toBe(createAdapter(testContext()).name);
    expect(parsed.requiredSecrets).toEqual([]);
  });

  it("counts Greenhouse postings by role kind and never returns a title", async () => {
    const { recorded, adapter } = adapterWith([{ method: "GET", url: "https://boards-api.greenhouse.io/v1/boards/brightloop/jobs", respond: json(greenhouse) }]);
    const result = await adapter.openings("greenhouse", "brightloop");
    expect(recorded.calls).toHaveLength(1);
    expect(result).toMatchObject({ status: "found", total: 4, counts: { engineering: 2, sales: 1, data: 1 }, latestPostedAt: "2026-10-30T14:00:00.000Z", boardUrl: "https://boards.greenhouse.io/brightloop" });
    const text = JSON.stringify(result);
    for (const job of greenhouse.jobs) expect(text).not.toContain(job.title);
  });

  it("never dates a Greenhouse posting by its last edit", async () => {
    const { adapter } = adapterWith([{ url: "https://boards-api.greenhouse.io/v1/boards/edited/jobs", respond: json({ jobs: [{ id: 9, title: "Engineer", updated_at: "2026-11-04T10:00:00Z" }] }) }]);
    const result = await adapter.openings("greenhouse", "edited");
    expect(result.status).toBe("found");
    expect(result.latestPostedAt).toBeUndefined();
  });

  it("reads Lever and Ashby boards, skipping unlisted Ashby postings", async () => {
    const { adapter } = adapterWith([
      { method: "GET", url: "https://api.lever.co/v0/postings/quillstack?mode=json", respond: json(lever) },
      { method: "GET", url: "https://api.ashbyhq.com/posting-api/job-board/quillstack", respond: json(ashby) },
    ]);
    expect(await adapter.openings("lever", "quillstack")).toMatchObject({ status: "found", total: 2, counts: { design: 1, customer_success: 1 }, latestPostedAt: "2026-10-29T00:00:00.000Z" });
    expect(await adapter.openings("ashby", "quillstack")).toMatchObject({ status: "found", total: 1, counts: { people: 1 } });
  });

  it("reads a missing board, and a redirect, as no board", async () => {
    const { adapter } = adapterWith([
      { url: "https://boards-api.greenhouse.io/v1/boards/none/jobs", respond: json({ error: "not found" }, { status: 404 }) },
      { url: "https://api.lever.co/v0/postings/moved?mode=json", respond: new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }) },
    ]);
    expect((await adapter.openings("greenhouse", "none")).status).toBe("not_found");
    expect((await adapter.openings("lever", "moved")).status).toBe("not_found");
  });

  it("maps other failures to AdapterErrors", async () => {
    const { adapter } = adapterWith([
      { url: "https://api.ashbyhq.com/posting-api/job-board/busy", respond: json({}, { status: 429 }) },
      { url: "https://api.ashbyhq.com/posting-api/job-board/down", respond: new Response("down", { status: 503 }) },
      { url: "https://api.ashbyhq.com/posting-api/job-board/odd", respond: json({ unexpected: true }) },
    ]);
    await expect(adapter.openings("ashby", "busy")).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    await expect(adapter.openings("ashby", "down")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await expect(adapter.openings("ashby", "odd")).rejects.toMatchObject({ code: "unknown" });
  });

  it("refuses a token that could reach another host or path, before any request", async () => {
    const { recorded, adapter } = adapterWith([]);
    for (const token of ["../admin", "evil.example/x", "a?b=1", "a#b", "UPPER", "", "x".repeat(64), "a/b", "@evil.example", "a%2f"]) {
      await expect(adapter.openings("greenhouse", token)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(recorded.calls).toHaveLength(0);
  });

  it("only ever builds URLs on the three board hosts", () => {
    for (const board of ["greenhouse", "lever", "ashby"] as const) {
      const url = boardUrl(board, "acme");
      expect(url).not.toBeNull();
      expect(new URL(url as string).hostname).toBe(BOARD_HOSTS[board]);
    }
  });

  it("classifies titles into role kinds", () => {
    expect(roleKind("Site Reliability Engineer")).toBe("engineering");
    expect(roleKind("Head of Growth Marketing")).toBe("marketing");
    expect(roleKind("Office Manager")).toBe("operations");
    expect(roleKind("Chef")).toBe("other");
  });

  it("polls account domains as hiring signals with counts only", async () => {
    const { adapter } = adapterWith([
      { url: "https://boards-api.greenhouse.io/v1/boards/brightloop/jobs", respond: json(greenhouse) },
      { url: "https://api.lever.co/v0/postings/brightloop?mode=json", respond: json({}, { status: 404 }) },
      { url: "https://api.ashbyhq.com/posting-api/job-board/brightloop", respond: json({}, { status: 404 }) },
    ]);
    const page = await adapter.poll({ since: "2026-10-01T00:00:00.000Z", accountDomains: ["brightloop.example"], limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: "hiring", accountDomain: "brightloop.example", summary: "4 open roles", url: "https://boards.greenhouse.io/brightloop" });
  });
});
