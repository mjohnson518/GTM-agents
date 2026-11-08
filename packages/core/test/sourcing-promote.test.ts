// GTM-agents: promotion turns a qualified candidate with a verified work email into a contact, in one
// batch, and holds or rejects everything else.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { contactEmailFields } from "../src/data/contacts.ts";
import { recordEvidence } from "../src/enrichment/evidence.ts";
import { cacheVerification } from "../src/enrichment/verification.ts";
import type { VerificationStatus } from "../src/ports/contact.ts";
import { promoteStage } from "../src/sourcing/promote.ts";
import { qualificationScore, qualificationStatus, qualifyStage } from "../src/sourcing/qualify.ts";
import { fakeVerifier, resetSourcingTables, stageContext, uploadBrain } from "./sourcing-fakes.ts";

const now = new Date("2026-11-04T09:00:00.000Z");

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

async function candidate(id: string, fields: Partial<Record<string, string | number | null>> = {}) {
  const row = {
    source: "fake-search",
    source_ref: `ref-${id}`,
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@brightloop.example",
    email_source: "finder-a",
    job_title: "VP Engineering",
    account_name: "Brightloop Labs",
    account_key: "brightloop.example",
    status: "qualified",
    qualification_score: 0.8,
    query_id: null,
    ...fields,
  };
  const keys = Object.keys(row);
  await env.DB.prepare(`INSERT INTO candidates (id, ${keys.join(", ")}) VALUES (?1, ${keys.map((_, i) => `?${i + 2}`).join(", ")})`)
    .bind(id, ...Object.values(row))
    .run();
}

const verified = (email: string, status: VerificationStatus = "deliverable", score = 95) =>
  cacheVerification(env.DB, email, { status, provider: "fake-verifier", score, acceptAll: status === "risky", disposable: false, reason: status, verifiedAt: now.toISOString() });

async function status(id: string) {
  return env.DB.prepare("SELECT status, promoted_contact_id, qualification_notes, email FROM candidates WHERE id = ?1").bind(id).first<{ status: string; promoted_contact_id: string | null; qualification_notes: string; email: string | null }>();
}

const promote = async (policy: "strict" | "allow_risky" = "strict", verifier = fakeVerifier("fake-verifier")) =>
  promoteStage(await stageContext(env.DB, env.KV, { now }), 50, { policy, verifier });

describe("promoteStage", () => {
  it("creates the account and the contact, links evidence, and records persona and fit, in one batch", async () => {
    await env.DB.prepare("INSERT INTO discovery_queries (id, query, source) VALUES ('q-1', 'flaky tests', 'fake-search')").run();
    await candidate("c-ok", { query_id: "q-1" });
    await verified("jane.doe@brightloop.example");
    await recordEvidence(env.DB, { candidateId: "c-ok", field: "email", value: "jane.doe@brightloop.example", provider: "finder-a", now });
    const stats = await promote();
    expect(stats).toMatchObject({ promoted: 1, held: 0 });
    const row = await status("c-ok");
    expect(row?.status).toBe("promoted");
    const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?1").bind(row?.promoted_contact_id).first<Record<string, unknown>>();
    const fields = await contactEmailFields("jane.doe@brightloop.example");
    expect(contact).toMatchObject({
      email: fields?.email,
      email_sha256: fields?.email_sha256,
      mailbox_sha256: fields?.mailbox_sha256,
      first_name: "Jane",
      account_key: "brightloop.example",
      warmth: "cold",
      verification_status: "deliverable",
      email_confidence: "high",
      email_source: "finder-a",
      candidate_id: "c-ok",
      discovery_query_id: "q-1",
    });
    expect(JSON.parse(String(contact?.attributes))).toMatchObject({ persona: "economic-buyer" });
    expect(await env.DB.prepare("SELECT name FROM accounts WHERE account_key = 'brightloop.example'").first()).toEqual({ name: "Brightloop Labs" });
    expect(await env.DB.prepare("SELECT contact_id FROM contact_evidence WHERE candidate_id = 'c-ok'").first()).toEqual({ contact_id: row?.promoted_contact_id });
    expect(await env.DB.prepare("SELECT persona FROM account_contacts").first()).toEqual({ persona: "economic-buyer" });
    expect(await env.DB.prepare("SELECT decision, source FROM contact_fit").first()).toEqual({ decision: "keep", source: "brain" });
    expect(await env.DB.prepare("SELECT total_promoted FROM discovery_queries WHERE id = 'q-1'").first()).toEqual({ total_promoted: 1 });
  });

  it("allows a missing first name on the contact", async () => {
    await candidate("c-noname", { first_name: null, last_name: null });
    await verified("jane.doe@brightloop.example");
    expect((await promote()).promoted).toBe(1);
  });

  it("marks a candidate whose address or mailbox is already a contact as a duplicate", async () => {
    const f = await contactEmailFields("jane@brightloop.example");
    await env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, account_key) VALUES ('existing', ?1, ?2, ?3, 'brightloop.example')")
      .bind(f?.email, f?.email_sha256, f?.mailbox_sha256)
      .run();
    await candidate("c-sub", { email: "jane+eng@brightloop.example", first_name: "Janet", last_name: "Other" });
    await candidate("c-name", { email: "j.doe@brightloop.example", first_name: "Jane", last_name: "Doe", source_ref: "r2" });
    await env.DB.prepare("UPDATE contacts SET first_name = 'Jane', last_name = 'Doe' WHERE id = 'existing'").run();
    const stats = await promote();
    expect(stats.duplicate).toBe(2);
    expect(await status("c-sub")).toMatchObject({ status: "duplicate", promoted_contact_id: "existing" });
    expect(await status("c-name")).toMatchObject({ status: "duplicate", promoted_contact_id: "existing" });
  });

  it("rejects risky under the strict policy, and promotes it under allow_risky", async () => {
    await candidate("c-risky");
    await verified("jane.doe@brightloop.example", "risky", 60);
    await candidate("c-risky-2", { email: "john.roe@brightloop.example", first_name: "John", last_name: "Roe", source_ref: "r-2" });
    await verified("john.roe@brightloop.example", "risky", 60);
    await promoteStage(await stageContext(env.DB, env.KV, { now }), 1, { policy: "strict", verifier: undefined });
    const strict = [await status("c-risky"), await status("c-risky-2")].filter((r) => r?.status === "rejected");
    expect(strict).toHaveLength(1);
    expect((await promote("allow_risky")).promoted).toBe(1);
    const contact = await env.DB.prepare("SELECT email_confidence, verification_status FROM contacts").first();
    expect(contact).toEqual({ email_confidence: "low", verification_status: "risky" });
  });

  it("verifies at promotion when no fresh result is cached, and holds an unknown result for a later retry", async () => {
    await candidate("c-unknown");
    const verifier = fakeVerifier("fake-verifier", {}, "unknown");
    const stats = await promote("strict", verifier);
    expect(stats).toMatchObject({ promoted: 0, held: 1 });
    expect(verifier.calls).toEqual(["jane.doe@brightloop.example"]);
    expect((await status("c-unknown"))?.status).toBe("qualified");
  });

  it("rejects an unknown result after three attempts", async () => {
    await candidate("c-unknown-3", { attributes: JSON.stringify({ verify_attempts: 2 }) });
    await promote("strict", fakeVerifier("fake-verifier", {}, "unknown"));
    expect(await status("c-unknown-3")).toMatchObject({ status: "rejected" });
  });

  it("rejects a role mailbox, a person fit that is no longer keep, and the never list", async () => {
    await candidate("c-role", { email: "sales@brightloop.example" });
    await candidate("c-fit", { job_title: "Account Executive", email: "ae@brightloop.example", source_ref: "r-fit" });
    await candidate("c-never", { job_title: "Agency Owner", email: "owner@brightloop.example", source_ref: "r-never" });
    for (const e of ["sales@brightloop.example", "ae@brightloop.example", "owner@brightloop.example"]) await verified(e);
    expect((await promote()).rejected).toBe(3);
    expect((await status("c-role"))?.email).toBeNull();
  });

  it("does not promote the same candidate twice when two runs race", async () => {
    await candidate("c-race");
    await verified("jane.doe@brightloop.example");
    const [a, b] = await Promise.all([promote(), promote()]);
    expect(a.promoted + b.promoted).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first()).toEqual({ n: 1 });
  });
});

describe("qualification", () => {
  it("scores email, name, account, person fit and account fit, with fixed thresholds", () => {
    const full = qualificationScore({ verification: "deliverable", hasFullName: true, hasAccountName: true, personFit: "keep", fitScore: null, prescore: null });
    expect(full).toBe(0.75);
    expect(qualificationStatus(full)).toBe("qualified");
    expect(qualificationStatus(qualificationScore({ verification: null, hasFullName: true, hasAccountName: true, personFit: "keep", fitScore: null, prescore: null }))).toBe("borderline");
    expect(qualificationStatus(qualificationScore({ verification: null, hasFullName: false, hasAccountName: false, personFit: "maybe", fitScore: null, prescore: 50 }))).toBe("rejected");
    expect(qualificationScore({ verification: "deliverable", hasFullName: true, hasAccountName: true, personFit: "keep", fitScore: 10, prescore: 90 })).toBe(1);
  });

  it("qualifies enriched candidates and rejects hard stops whatever their score", async () => {
    await candidate("e-good", { status: "enriched" });
    await verified("jane.doe@brightloop.example");
    await candidate("e-lowfit", { status: "enriched", account_key: "lowfit.example", email: "x@lowfit.example", source_ref: "r-low" });
    await env.DB.prepare("INSERT INTO account_fit (account_key, status, fit_score) VALUES ('lowfit.example', 'scored', 3)").run();
    await candidate("e-noemail", { status: "enriched", email: null, source_ref: "r-none" });
    const stats = await qualifyStage(await stageContext(env.DB, env.KV, { now }), 20);
    expect(stats).toMatchObject({ qualified: 1, rejected: 1, borderline: 1 });
    expect((await status("e-good"))?.status).toBe("qualified");
    expect((await status("e-lowfit"))?.status).toBe("rejected");
    expect((await status("e-noemail"))?.status).toBe("borderline");
  });
});
