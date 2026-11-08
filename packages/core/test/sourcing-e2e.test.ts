// GTM-agents: the milestone gate, end to end: a search turns up accounts, enrichment finds the right
// people and verifies their work addresses, the fit gate and qualification sort them, and promotion
// leaves contacts holding verified work emails. Every company, person and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runDiscoveryCycle } from "../src/sourcing/cycle.ts";
import { SOURCING_FLAGS } from "../src/sourcing/flags.ts";
import { accountKey } from "../src/data/keys.ts";
import { accountResult, fakeFinder, fakePeople, fakeSource, fakeVerifier, flagsOf, person, resetSourcingTables, silentLog, uploadBrain } from "./sourcing-fakes.ts";

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

describe("a discovery cycle, end to end", () => {
  it("does nothing at all, search included, when a locked brain component cannot be served", async () => {
    // icp.md edited after locking: its never list would silently be empty, so nothing runs.
    await env.KV.put("brain:file:icp", "---\ncomponent: icp\nstatus: draft\nversion: 2\nupdated: 2026-11-02\n---\n");
    const source = fakeSource("fake-search", [accountResult("Globex", "globex.example")]);
    const result = await runDiscoveryCycle({
      db: env.DB,
      kv: env.KV,
      flags: flagsOf(),
      adapters: { sources: [source], finders: [] },
      now: new Date("2026-11-04T09:00:00.000Z"),
      job: "discovery_cycle",
      log: silentLog,
      peoplePerAccount: 1,
    });
    expect(result.search.skipped).toMatch(/brain could not be read whole/);
    expect(source.queries).toHaveLength(0);
  });

  it("ends with qualified contacts holding verified work emails, and nothing else promoted", async () => {
    const source = fakeSource("fake-search", [
      accountResult("Brightloop Labs", "brightloop.example"),
      accountResult("Northwind Tools", "northwind.example"),
      accountResult("Contoso Agency", "contoso.example"),
      accountResult("Globex", "globex.example"),
      accountResult("A personal blog", "gmail.com", "r-gmail"),
    ]);
    const people = fakePeople("fake-people", {
      "brightloop.example": [
        person("Jane", "Doe", "VP Engineering", "brightloop.example"),
        person("Sam", "Lee", "Staff Engineer", "brightloop.example", "sam.lee@brightloop.example"),
        person("Pat", "Kim", "Account Executive", "brightloop.example"),
      ],
      "northwind.example": [person("Ada", "Park", "Head of Engineering", "northwind.example", "ada.park@gmail.com")],
      "contoso.example": [person("Max", "Fox", "Recruiter", "contoso.example")],
    });
    const finder = fakeFinder("fake-finder", {
      "jane doe@brightloop.example": "jane.doe@brightloop.example",
      "ada park@northwind.example": "ada.park@northwind.example",
    });
    const verifier = fakeVerifier("fake-verifier", { "ada.park@northwind.example": "risky" });
    const flags = flagsOf({ [SOURCING_FLAGS.enabled]: "true" });
    const cycle = (runId: string) =>
      runDiscoveryCycle({
        db: env.DB,
        kv: env.KV,
        flags,
        adapters: { sources: [source], people, finders: [finder], verifier },
        now: new Date("2026-11-04T09:00:00.000Z"),
        job: "discovery_cycle",
        runId,
        log: silentLog,
        jobCapCents: 300,
        peoplePerAccount: 2,
      });

    const first = await cycle("run-1");
    expect(first.search).toMatchObject({ searches: 2, inserted: 3, rejected: 2 });
    // Brightloop gets Jane; Sam becomes a new candidate for the next cycle.
    expect("promoted" in first.promote ? first.promote.promoted : -1).toBe(1);

    const second = await cycle("run-2");
    expect("promoted" in second.promote ? second.promote.promoted : -1).toBe(1);

    const { results: contacts } = await env.DB.prepare("SELECT email, first_name, job_title, account_key, verification_status, warmth, email_confidence FROM contacts ORDER BY email").all<
      Record<string, string>
    >();
    expect(contacts).toEqual([
      { email: "jane.doe@brightloop.example", first_name: "Jane", job_title: "VP Engineering", account_key: "brightloop.example", verification_status: "deliverable", warmth: "cold", email_confidence: "high" },
      { email: "sam.lee@brightloop.example", first_name: "Sam", job_title: "Staff Engineer", account_key: "brightloop.example", verification_status: "deliverable", warmth: "cold", email_confidence: "high" },
    ]);
    for (const c of contacts) expect(accountKey(c.email)).toBe(c.account_key);

    const { results: candidates } = await env.DB.prepare("SELECT account_key, first_name, status, email FROM candidates ORDER BY account_key, first_name").all<Record<string, string | null>>();
    const byAccount = (key: string | null) => candidates.filter((c) => c.account_key === key).map((c) => c.status);
    expect(byAccount("brightloop.example").sort()).toEqual(["promoted", "promoted"]);
    // Northwind's address verified risky: qualified, but not promoted under the strict policy.
    expect(candidates.find((c) => c.account_key === "northwind.example")).toMatchObject({ status: "rejected", email: "ada.park@northwind.example" });
    // No one at Contoso matches a persona; Globex is on the never list; gmail.com is not a company.
    expect(byAccount("contoso.example")).toEqual(["rejected"]);
    expect(byAccount("globex.example")).toEqual(["rejected"]);
    expect(byAccount(null)).toEqual(["rejected"]);
    // The personal address the people provider offered for Ada was never stored anywhere.
    const leaked = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates WHERE email LIKE '%gmail.com'").first<{ n: number }>();
    expect(leaked?.n).toBe(0);
    expect(verifier.calls).not.toContain("ada.park@gmail.com");

    const evidence = await env.DB.prepare("SELECT field FROM contact_evidence WHERE contact_id IS NOT NULL ORDER BY field").all<{ field: string }>();
    expect(new Set(evidence.results.map((e) => e.field))).toEqual(new Set(["email", "employer_domain", "job_title"]));
    const spend = await env.DB.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT run_id) AS runs FROM cost_events WHERE job = 'discovery_cycle'").first<{ n: number; runs: number }>();
    expect(spend?.runs).toBe(2);
    expect(spend?.n).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first()).toEqual({ n: 1 });
  });
});
