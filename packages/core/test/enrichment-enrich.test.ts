// GTM-agents: the enrichment stage: the fit gate before any paid call, the right person at an account,
// undecided titles left unpaid, retries for failed lookups, and the budget leaving work for later.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { jobCapKey } from "../src/budget/gate.ts";
import { MAX_ENRICH_ATTEMPTS, enrichStage } from "../src/enrichment/enrich.ts";
import { insertCandidate } from "../src/sourcing/candidates.ts";
import type { SourcingAdapters } from "../src/sourcing/context.ts";
import { fakeFinder, fakePeople, fakeVerifier, flagsOf, person, resetSourcingTables, stageContext, uploadBrain } from "./sourcing-fakes.ts";

const now = new Date("2026-11-04T09:00:00.000Z");

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

const account = (ref: string, domain: string) =>
  insertCandidate(env.DB, { source: "fake-search", sourceRef: ref, searchType: "account", accountName: domain, accountKey: domain, status: "raw" }, now);

async function row(ref: string) {
  return env.DB.prepare("SELECT status, first_name, job_title, email, qualification_notes, attributes FROM candidates WHERE source_ref = ?1").bind(ref).first<Record<string, string | null>>();
}

const enrich = async (adapters: SourcingAdapters, flags = flagsOf()) => enrichStage(await stageContext(env.DB, env.KV, { now, flags }), adapters, 40, { peoplePerAccount: 2 });

describe("enrichStage", () => {
  it("never swaps a named person without a title for someone else, and pays nothing for them", async () => {
    await insertCandidate(env.DB, { source: "fake-search", sourceRef: "p-1", searchType: "person", firstName: "Jane", lastName: "Doe", accountKey: "brightloop.example", status: "raw" }, now);
    const people = fakePeople("fake-people", { "brightloop.example": [person("Sam", "Lee", "VP Engineering", "brightloop.example")] });
    const finder = fakeFinder("fake-finder", {});
    await enrich({ sources: [], people, finders: [finder], verifier: fakeVerifier("fake-verifier") });
    expect(await row("p-1")).toMatchObject({ status: "enriched", first_name: "Jane", job_title: null, email: null });
    expect(people.calls).toHaveLength(0);
    expect(finder.calls).toHaveLength(0);
  });

  it("checks the fit gate before any paid call", async () => {
    await account("a-never", "globex.example");
    await account("a-low", "lowfit.example");
    await env.DB.prepare("INSERT INTO account_fit (account_key, status, fit_score) VALUES ('lowfit.example', 'scored', 2)").run();
    const people = fakePeople("fake-people", {});
    const stats = await enrich({ sources: [], people, finders: [] });
    expect(stats.rejected).toBe(2);
    expect(people.calls).toHaveLength(0);
    expect((await row("a-low"))?.qualification_notes).toMatch(/below 5/);
  });

  it("keeps the best person at an account and turns the next match into a new candidate", async () => {
    await account("a-1", "brightloop.example");
    const people = fakePeople("fake-people", {
      "brightloop.example": [
        person("Sam", "Lee", "Staff Engineer", "brightloop.example", "sam.lee@brightloop.example"),
        person("Jane", "Doe", "CTO", "brightloop.example"),
        person("Kim", "Ray", "Engineering Manager", "brightloop.example", "kim@gmail.com"),
      ],
    });
    await enrich({ sources: [], people, finders: [fakeFinder("fake-finder", { "jane doe@brightloop.example": "jane.doe@brightloop.example" })], verifier: fakeVerifier("fake-verifier") });
    expect(await row("a-1")).toMatchObject({ status: "enriched", first_name: "Jane", job_title: "CTO", email: "jane.doe@brightloop.example" });
    const extra = await env.DB.prepare("SELECT first_name, email, email_source, status, search_type FROM candidates WHERE source = 'fake-people'").all();
    // Kim (a manager) ranks after Jane (the decision maker) and before Sam (senior); with
    // peoplePerAccount 2 only Kim is kept, and the personal address offered for Kim is dropped.
    expect(extra.results).toEqual([{ first_name: "Kim", email: null, email_source: null, status: "raw", search_type: "person" }]);
  });

  it("enriches an undecided title without any paid email lookup", async () => {
    await insertCandidate(env.DB, { source: "fake-search", sourceRef: "p-maybe", searchType: "person", firstName: "Lee", lastName: "Hart", jobTitle: "Director of Sales", accountKey: "brightloop.example", status: "raw" }, now);
    const finder = fakeFinder("fake-finder", { "lee hart@brightloop.example": "lee@brightloop.example" });
    await enrich({ sources: [], finders: [finder] });
    expect(await row("p-maybe")).toMatchObject({ status: "enriched", email: null });
    const attributes = JSON.parse(String((await row("p-maybe"))?.attributes)) as { person_fit?: { decision?: string } };
    expect(attributes.person_fit?.decision).toBe("maybe");
    expect(finder.calls).toHaveLength(0);
  });

  it("retries a failed people lookup on later runs, then rejects", async () => {
    await account("a-retry", "brightloop.example");
    const broken = { name: "broken-people", searchPeople: () => Promise.reject(new Error("unavailable")), matchPerson: () => Promise.resolve({ record: null }) };
    for (let i = 1; i < MAX_ENRICH_ATTEMPTS; i++) {
      await enrich({ sources: [], people: broken, finders: [] });
      expect((await row("a-retry"))?.status).toBe("raw");
    }
    await enrich({ sources: [], people: broken, finders: [] });
    expect((await row("a-retry"))?.status).toBe("rejected");
  });

  it("leaves candidates raw, with their progress, when the budget stops paid calls", async () => {
    await account("a-budget", "brightloop.example");
    const people = fakePeople("fake-people", { "brightloop.example": [person("Jane", "Doe", "CTO", "brightloop.example")] });
    const stats = await enrich({ sources: [], people, finders: [] }, flagsOf({ [jobCapKey("discovery_cycle")]: "0" }));
    expect(stats.budgetStopped).toBe(true);
    expect(people.calls).toHaveLength(0);
    expect((await row("a-budget"))?.status).toBe("raw");
  });
});
