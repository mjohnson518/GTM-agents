// GTM-agents: what sourcing must never promote: personal addresses, unverified or risky addresses
// under the strict policy, suppressed, tombstoned or opted-out people (even when rediscovered), and
// people whose evidence conflicts, which are held for a person rather than guessed at.
import { contactEmailFields, eraseContact } from "@gtm-agents/core/data";
import { cacheVerification, recordEvidence } from "@gtm-agents/core/enrichment";
import type { EmailVerifier, VerificationStatus } from "@gtm-agents/core/ports";
import { addSuppression } from "@gtm-agents/core/sending";
import { promoteStage, runDiscoveryCycle, type SourcingAdapters } from "@gtm-agents/core/sourcing";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountResult,
  fakeFinder,
  fakePeople,
  fakeSource,
  fakeVerifier,
  flagsOf,
  person,
  resetSourcingTables,
  silentLog,
  stageContext,
  uploadBrain,
} from "../../packages/core/test/sourcing-fakes.ts";

const now = new Date("2026-11-04T09:00:00.000Z");

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

async function qualified(id: string, email: string, fields: Record<string, string | null> = {}) {
  const row = { source: "fake-search", source_ref: `ref-${id}`, first_name: "Jane", last_name: "Doe", email, job_title: "VP Engineering", account_name: "Brightloop Labs", account_key: "brightloop.example", status: "qualified", ...fields };
  const keys = Object.keys(row);
  await env.DB.prepare(`INSERT INTO candidates (id, ${keys.join(", ")}) VALUES (?1, ${keys.map((_, i) => `?${i + 2}`).join(", ")})`)
    .bind(id, ...Object.values(row))
    .run();
}

const verified = (email: string, status: VerificationStatus = "deliverable") =>
  cacheVerification(env.DB, email, { status, provider: "fake-verifier", score: 95, acceptAll: false, disposable: false, reason: status, verifiedAt: now.toISOString() });

/** Run promotion with a verifier (a deliverable fake by default), or with none when given null. */
const promote = async (verifier: EmailVerifier | null = fakeVerifier("fake-verifier"), db: D1Database = env.DB) =>
  promoteStage(await stageContext(db, env.KV, { now }), 50, { policy: "strict", verifier: verifier ?? undefined });
const contactCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>())?.n ?? -1;

function cycle(adapters: SourcingAdapters, runId = "run-1") {
  return runDiscoveryCycle({ db: env.DB, kv: env.KV, flags: flagsOf(), adapters, now, job: "discovery_cycle", runId, log: silentLog, jobCapCents: 300, peoplePerAccount: 1 });
}

describe("work email only", () => {
  it("never stores, verifies or promotes a personal address a finder returns", async () => {
    const verifier = fakeVerifier("fake-verifier");
    await cycle({
      sources: [fakeSource("fake-search", [accountResult("Brightloop Labs", "brightloop.example")])],
      people: fakePeople("fake-people", { "brightloop.example": [person("Jane", "Doe", "VP Engineering", "brightloop.example", "jane@outlook.com")] }),
      finders: [fakeFinder("fake-finder", { "jane doe@brightloop.example": "jane.doe@gmail.com" })],
      verifier,
    });
    expect(verifier.calls).toEqual([]);
    expect(await contactCount()).toBe(0);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates WHERE email IS NOT NULL").first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("rejects a personal or off-domain address that reached a qualified row, and drops it", async () => {
    await qualified("c-gmail", "jane.doe@gmail.com");
    await qualified("c-other", "jane.doe@northwind.example", { source_ref: "r-other" });
    await verified("jane.doe@gmail.com");
    await verified("jane.doe@northwind.example");
    expect((await promote()).rejected).toBe(2);
    expect(await contactCount()).toBe(0);
    const emails = await env.DB.prepare("SELECT email FROM candidates").all<{ email: string | null }>();
    expect(emails.results.every((r) => r.email === null)).toBe(true);
  });

  it("rejects an address that does not parse", async () => {
    await qualified("c-bad", "jane doe at brightloop");
    expect((await promote()).rejected).toBe(1);
    expect(await contactCount()).toBe(0);
  });
});

describe("the strict verification policy", () => {
  it("promotes only a deliverable address", async () => {
    const cases: Array<[string, VerificationStatus]> = [
      ["risky@brightloop.example", "risky"],
      ["unknown@brightloop.example", "unknown"],
      ["bounce@brightloop.example", "undeliverable"],
    ];
    for (const [i, [email, status]] of cases.entries()) {
      await qualified(`c-${status}`, email, { first_name: `Person${i}`, last_name: "Test", source_ref: `r-${status}` });
      await verified(email, status);
    }
    await promote();
    expect(await contactCount()).toBe(0);
    const statuses = await env.DB.prepare("SELECT id, status FROM candidates ORDER BY id").all();
    expect(statuses.results).toEqual([
      { id: "c-risky", status: "rejected" },
      { id: "c-undeliverable", status: "rejected" },
      { id: "c-unknown", status: "qualified" },
    ]);
  });

  it("does not promote an address it could not verify, whether there is no verifier or the verifier fails", async () => {
    await qualified("c-unverified", "jane.doe@brightloop.example");
    await promote(null);
    const broken = { name: "broken", verify: () => Promise.reject(new Error("verifier down")) };
    await promote(broken);
    expect(await contactCount()).toBe(0);
    expect(await env.DB.prepare("SELECT status FROM candidates").first()).toEqual({ status: "qualified" });
  });
});

describe("suppression, tombstones and opt-outs", () => {
  it("never promotes a suppressed address, or another subaddress of the same mailbox", async () => {
    await addSuppression(env.DB, { email: "jane@brightloop.example", reason: "opt_out" });
    await qualified("c-sup", "jane+eng@brightloop.example");
    await verified("jane+eng@brightloop.example");
    expect((await promote()).rejected).toBe(1);
    expect(await contactCount()).toBe(0);
    expect(await env.DB.prepare("SELECT email, qualification_notes FROM candidates").first()).toEqual({ email: null, qualification_notes: "the address is suppressed" });
  });

  it("never re-adds an erased person, even when a new search rediscovers them", async () => {
    const people = fakePeople("fake-people", { "brightloop.example": [person("Jane", "Doe", "VP Engineering", "brightloop.example")] });
    const finder = fakeFinder("fake-finder", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    const verifier = fakeVerifier("fake-verifier");
    await cycle({ sources: [fakeSource("search-a", [accountResult("Brightloop Labs", "brightloop.example")])], people, finders: [finder], verifier });
    expect(await contactCount()).toBe(1);
    await eraseContact(env.DB, "jane.doe@brightloop.example", { source: "operator" });
    expect(await contactCount()).toBe(0);

    await cycle({ sources: [fakeSource("search-b", [accountResult("Brightloop Labs", "brightloop.example", "another-ref")])], people, finders: [finder], verifier }, "run-2");
    expect(await contactCount()).toBe(0);
    const rediscovered = await env.DB.prepare("SELECT status, email, qualification_notes FROM candidates WHERE source = 'search-b'").first();
    expect(rediscovered).toEqual({ status: "rejected", email: null, qualification_notes: "the address is suppressed" });
    // The erased address was never verified again.
    expect(verifier.calls).toEqual(["jane.doe@brightloop.example"]);
  });

  it("never promotes a tombstone written from a hash alone", async () => {
    const fields = await contactEmailFields("jane.doe@brightloop.example");
    await env.DB.prepare("INSERT INTO erasure_tombstones (email_sha256, source, erased_at) VALUES (?1, 'product', ?2)").bind(fields?.email_sha256, now.toISOString()).run();
    await qualified("c-tomb", "jane.doe@brightloop.example");
    await verified("jane.doe@brightloop.example");
    await promote();
    expect(await contactCount()).toBe(0);
  });

  it("holds every candidate when the suppression check cannot be read", async () => {
    await qualified("c-held", "jane.doe@brightloop.example");
    await verified("jane.doe@brightloop.example");
    const failing = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM suppression")) throw new Error("D1_ERROR: suppression unavailable");
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const stats = await promote(fakeVerifier("fake-verifier"), failing);
    expect(stats).toMatchObject({ promoted: 0, held: 1 });
    expect(await contactCount()).toBe(0);
    expect(await env.DB.prepare("SELECT status FROM candidates").first()).toEqual({ status: "qualified" });
  });
});

describe("evidence conflicts", () => {
  it("holds a candidate whose providers disagree, and promotes it only after a person resolves the conflict", async () => {
    await qualified("c-conflict", "jane.doe@brightloop.example");
    await verified("jane.doe@brightloop.example");
    await recordEvidence(env.DB, { candidateId: "c-conflict", field: "job_title", value: "VP Engineering", provider: "source-a", now });
    await recordEvidence(env.DB, { candidateId: "c-conflict", field: "job_title", value: "Engineering Manager", provider: "source-b", now });
    expect((await promote()).held).toBe(1);
    expect(await contactCount()).toBe(0);
    await env.DB.prepare("UPDATE contact_evidence SET resolved_at = ?1, resolved_by = 'operator'").bind(now.toISOString()).run();
    expect((await promote()).promoted).toBe(1);
  });

  it("holds an existing contact when a new source disagrees, and does not overwrite what is on file", async () => {
    const finder = fakeFinder("fake-finder", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    const verifier = fakeVerifier("fake-verifier");
    await cycle({
      sources: [fakeSource("search-a", [accountResult("Brightloop Labs", "brightloop.example")])],
      people: fakePeople("people-a", { "brightloop.example": [person("Jane", "Doe", "VP Engineering", "brightloop.example")] }),
      finders: [finder],
      verifier,
    });
    await cycle(
      {
        sources: [fakeSource("search-b", [accountResult("Brightloop Labs", "brightloop.example", "ref-b")])],
        people: fakePeople("people-b", { "brightloop.example": [person("Jane", "Doe", "Engineering Manager", "brightloop.example")] }),
        finders: [finder],
        verifier,
      },
      "run-2",
    );
    const contact = await env.DB.prepare("SELECT id, job_title FROM contacts").first<{ id: string; job_title: string }>();
    expect(contact?.job_title).toBe("VP Engineering");
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM contact_evidence WHERE contact_id = ?1 AND conflict = 1 AND resolved_at IS NULL").bind(contact?.id).first<{ n: number }>();
    expect(open?.n).toBe(2);
    expect(await env.DB.prepare("SELECT status FROM candidates WHERE source = 'search-b'").first()).toEqual({ status: "duplicate" });
  });
});
