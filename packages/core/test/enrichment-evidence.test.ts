// GTM-agents: per-field evidence, and conflicts held for a person rather than guessed at.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hasOpenConflict, recordEvidence, valuesConflict } from "../src/enrichment/evidence.ts";
import { resetSourcingTables } from "./sourcing-fakes.ts";

const now = new Date("2026-11-04T09:00:00.000Z");
beforeEach(() => resetSourcingTables(env.DB));

async function rows(candidateId: string) {
  const { results } = await env.DB.prepare("SELECT id, field, value, provider, conflict, conflict_with, retention_until FROM contact_evidence WHERE candidate_id = ?1 ORDER BY created_at, id")
    .bind(candidateId)
    .all<{ id: string; field: string; value: string; provider: string; conflict: number; conflict_with: string | null; retention_until: string }>();
  return results;
}

describe("valuesConflict", () => {
  it("compares titles by seniority band, domains by account key and addresses exactly", () => {
    expect(valuesConflict("job_title", "VP Engineering", "Vice President, Platform")).toBe(false);
    expect(valuesConflict("job_title", "VP Engineering", "Engineering Manager")).toBe(true);
    expect(valuesConflict("employer_domain", "www.brightloop.example", "https://brightloop.example/about")).toBe(false);
    expect(valuesConflict("employer_domain", "brightloop.example", "northwind.example")).toBe(true);
    expect(valuesConflict("email", "Jane@Brightloop.example", "jane@brightloop.example")).toBe(false);
  });
});

describe("recordEvidence", () => {
  it("records a field with a retention date a year out", async () => {
    await recordEvidence(env.DB, { candidateId: "cand-1", field: "email", value: "jane@brightloop.example", provider: "finder-a", now });
    const [row] = await rows("cand-1");
    expect(row).toMatchObject({ field: "email", provider: "finder-a", conflict: 0 });
    expect(row?.retention_until).toBe("2027-11-04T09:00:00.000Z");
  });

  it("marks both rows when a different provider disagrees, and holds the candidate", async () => {
    await recordEvidence(env.DB, { candidateId: "cand-2", field: "job_title", value: "VP Engineering", provider: "source-a", now });
    const second = await recordEvidence(env.DB, { candidateId: "cand-2", field: "job_title", value: "Engineering Manager", provider: "source-b", now });
    const all = await rows("cand-2");
    const a = all.find((r) => r.provider === "source-a");
    const b = all.find((r) => r.provider === "source-b");
    expect(second.conflictsWith).toEqual([a?.id]);
    expect(a).toMatchObject({ conflict: 1, conflict_with: JSON.stringify([b?.id]) });
    expect(b).toMatchObject({ conflict: 1, conflict_with: JSON.stringify([a?.id]) });
    expect(await hasOpenConflict(env.DB, { candidateId: "cand-2" })).toBe(true);
  });

  it("treats the same provider repeating itself as an update, not a conflict", async () => {
    await recordEvidence(env.DB, { candidateId: "cand-3", field: "job_title", value: "VP Engineering", provider: "source-a", now });
    await recordEvidence(env.DB, { candidateId: "cand-3", field: "job_title", value: "Engineering Manager", provider: "source-a", now });
    expect(await hasOpenConflict(env.DB, { candidateId: "cand-3" })).toBe(false);
  });

  it("finds conflicts with what is on file for an existing contact", async () => {
    await env.DB.prepare(
      "INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, account_key) VALUES ('contact-ev', 'jane@brightloop.example', ?1, ?1, 'brightloop.example')",
    )
      .bind("a".repeat(64))
      .run();
    await recordEvidence(env.DB, { contactId: "contact-ev", field: "job_title", value: "CTO", provider: "source-a", now });
    await recordEvidence(env.DB, { candidateId: "cand-4", contactId: "contact-ev", field: "job_title", value: "Staff Engineer", provider: "source-b", now });
    expect(await hasOpenConflict(env.DB, { contactId: "contact-ev" })).toBe(true);
  });

  it("releases the hold once a person resolves the conflict", async () => {
    await recordEvidence(env.DB, { candidateId: "cand-5", field: "employer_domain", value: "brightloop.example", provider: "source-a", now });
    await recordEvidence(env.DB, { candidateId: "cand-5", field: "employer_domain", value: "northwind.example", provider: "source-b", now });
    await env.DB.prepare("UPDATE contact_evidence SET resolved_at = ?1, resolved_by = 'operator' WHERE candidate_id = 'cand-5'").bind(now.toISOString()).run();
    expect(await hasOpenConflict(env.DB, { candidateId: "cand-5" })).toBe(false);
  });

  it("refuses evidence that belongs to no one", async () => {
    await expect(recordEvidence(env.DB, { field: "email", value: "x@brightloop.example", provider: "p", now })).rejects.toThrow(TypeError);
  });
});
