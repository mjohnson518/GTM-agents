// GTM-agents: the search stage turns brain and operator queries into deduplicated raw candidates,
// rejects results with no company domain, respects the backlog gate, and pays only through the gate.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { brainQueryId, planQueries, resolveAccountByName, searchStage } from "../src/sourcing/search.ts";
import { accountResult, fakeSource, resetSourcingTables, stageContext, uploadBrain } from "./sourcing-fakes.ts";

const limits = { searches: 5, resultsPerSearch: 10, rawBacklogMax: 300 };

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

async function candidates() {
  const { results } = await env.DB.prepare("SELECT source, source_ref, status, account_key, account_name, query_id, qualification_notes, attributes FROM candidates ORDER BY source_ref").all<
    Record<string, string | null>
  >();
  return results;
}

describe("planQueries", () => {
  it("registers each brain query once per source and runs the least recently run first", async () => {
    const ctx = await stageContext(env.DB, env.KV);
    const first = await planQueries(env.DB, ctx.brain, ["fake-search"], 5, ctx.now);
    expect(first.map((q) => q.text)).toEqual(ctx.brain.queries.map((q) => q.query));
    expect(first[1]).toMatchObject({ kind: "account", segment: "monorepo teams", intent: "trigger" });
    await env.DB.prepare("UPDATE discovery_queries SET last_run_at = ?2 WHERE id = ?1").bind(first[0]?.id, ctx.now.toISOString()).run();
    const second = await planQueries(env.DB, ctx.brain, ["fake-search"], 1, ctx.now);
    expect(second[0]?.id).toBe(first[1]?.id);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM discovery_queries").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("never revives a deactivated query, and runs operator-added person queries", async () => {
    const ctx = await stageContext(env.DB, env.KV);
    const killed = await brainQueryId("fake-search", ctx.brain.queries[0]?.query ?? "");
    await env.DB.prepare("INSERT INTO discovery_queries (id, query, source, is_active, deactivated_reason) VALUES (?1, ?2, 'fake-search', 0, 'low conversion')")
      .bind(killed, ctx.brain.queries[0]?.query)
      .run();
    await env.DB.prepare("INSERT INTO discovery_queries (id, query, source, search_type) VALUES ('op-1', 'staff engineers who own CI', 'fake-search', 'person')").run();
    const planned = await planQueries(env.DB, ctx.brain, ["fake-search"], 10, ctx.now);
    expect(planned.map((q) => q.id)).not.toContain(killed);
    expect(planned.find((q) => q.id === "op-1")?.kind).toBe("person");
  });
});

describe("searchStage", () => {
  it("stores results as raw candidates, deduplicated by source and provider id, with the query recorded", async () => {
    const source = fakeSource("fake-search", [accountResult("Brightloop Labs", "brightloop.example"), accountResult("Northwind Tools", "www.northwind.example")]);
    const ctx = await stageContext(env.DB, env.KV);
    const stats = await searchStage(ctx, [source], limits);
    expect(stats).toMatchObject({ searches: 2, inserted: 2, duplicates: 2 });
    const rows = await candidates();
    expect(rows.map((r) => [r.status, r.account_key])).toEqual([
      ["raw", "brightloop.example"],
      ["raw", "northwind.example"],
    ]);
    expect(rows[0]?.query_id).toMatch(/^kw_/);
    const queries = await env.DB.prepare("SELECT total_results, last_run_at FROM discovery_queries ORDER BY total_results DESC").all<{ total_results: number; last_run_at: string }>();
    expect(queries.results.map((q) => q.total_results)).toEqual([2, 0]);
  });

  it("stores results with no company domain or on the never list as rejected, so they are not reconsidered", async () => {
    const source = fakeSource("fake-search", [
      accountResult("A personal blog", "gmail.com", "r-personal"),
      accountResult("A hosted site", "brightloop.github.io", "r-shared"),
      accountResult("Globex", "globex.example", "r-never"),
      { ...accountResult("No domain at all", "x.example", "r-none"), domain: undefined, url: "not a url" },
    ]);
    const ctx = await stageContext(env.DB, env.KV);
    const stats = await searchStage(ctx, [source], { ...limits, searches: 1 });
    expect(stats).toMatchObject({ inserted: 0, rejected: 4 });
    const rows = await candidates();
    expect(rows.every((r) => r.status === "rejected")).toBe(true);
    expect(rows.find((r) => r.source_ref === "r-never")?.qualification_notes).toMatch(/never list/);
  });

  it("sends the never list and low-fit accounts as exclusions, with the query's segment", async () => {
    await env.DB.prepare("INSERT INTO account_fit (account_key, status, fit_score) VALUES ('lowfit.example', 'scored', 3)").run();
    const source = fakeSource("fake-search", []);
    await searchStage(await stageContext(env.DB, env.KV), [source], limits);
    expect(source.queries[0]?.excludeDomains?.sort()).toEqual(["globex.example", "lowfit.example"]);
    expect(source.queries[1]?.segment).toBe("monorepo teams");
    expect(source.queries[0]?.limit).toBe(10);
  });

  it("pays for no new search while the raw backlog is over its limit", async () => {
    const source = fakeSource("fake-search", [accountResult("Brightloop Labs", "brightloop.example")]);
    const ctx = await stageContext(env.DB, env.KV);
    await searchStage(ctx, [source], limits);
    source.queries.length = 0;
    const stats = await searchStage(ctx, [source], { ...limits, rawBacklogMax: 0 });
    expect(stats.skipped).toMatch(/backlog/);
    expect(source.queries).toHaveLength(0);
  });

  it("starts no further search once the run has written its row ceiling", async () => {
    const source = fakeSource("fake-search", [accountResult("Brightloop Labs", "brightloop.example"), accountResult("Northwind Tools", "northwind.example")]);
    const stats = await searchStage(await stageContext(env.DB, env.KV), [source], { ...limits, maxRows: 1 });
    expect(stats.inserted).toBe(1);
    expect(source.queries).toHaveLength(1);
  });

  it("records each search's cost against the job and run", async () => {
    await searchStage(await stageContext(env.DB, env.KV, { runId: "run-search" }), [fakeSource("fake-search", [], 0.0125)], { ...limits, searches: 1 });
    const cost = await env.DB.prepare("SELECT provider, capability, job, run_id, cost_micro_cents FROM cost_events").first();
    expect(cost).toMatchObject({ provider: "fake-search", capability: "search", job: "discovery_cycle", run_id: "run-search", cost_micro_cents: 12_500 });
  });

  it("stops using a source after an error that will not go away", async () => {
    let calls = 0;
    const broken = {
      name: "fake-search",
      search: () => {
        calls += 1;
        return Promise.reject(new Error("invalid key"));
      },
    };
    const stats = await searchStage(await stageContext(env.DB, env.KV), [broken], limits);
    expect(stats.errors).toBe(1);
    expect(calls).toBe(1);
  });

  it("resolves a person's company name to a known account only when exactly one matches", async () => {
    await env.DB.prepare("INSERT INTO accounts (account_key, name) VALUES ('brightloop.example', 'Brightloop Labs')").run();
    expect(await resolveAccountByName(env.DB, "Brightloop Labs")).toBe("brightloop.example");
    expect(await resolveAccountByName(env.DB, "Unknown Co")).toBeNull();
    const source = fakeSource("fake-people-search", [
      { kind: "person", name: "Jane Doe", title: "VP Engineering", accountName: "Brightloop Labs", url: "https://profiles.example/in/jane", evidence: [], providerRef: "p-1" },
      { kind: "person", name: "John Roe", title: "CTO", accountName: "Nobody Knows Inc", evidence: [], providerRef: "p-2" },
    ]);
    await env.DB.prepare("INSERT INTO discovery_queries (id, query, source, search_type) VALUES ('op-p', 'engineering leaders', 'fake-people-search', 'person')").run();
    await searchStage(await stageContext(env.DB, env.KV), [source], limits);
    const rows = await env.DB.prepare("SELECT source_ref, status, first_name, last_name, job_title, account_key FROM candidates WHERE source = 'fake-people-search' ORDER BY source_ref").all();
    expect(rows.results).toEqual([
      { source_ref: "p-1", status: "raw", first_name: "Jane", last_name: "Doe", job_title: "VP Engineering", account_key: "brightloop.example" },
      { source_ref: "p-2", status: "rejected", first_name: "John", last_name: "Roe", job_title: "CTO", account_key: null },
    ]);
  });
});
