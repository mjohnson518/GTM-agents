// GTM-agents: skip rather than guess. A cold first touch whose template needs a value the contact does
// not have is held for that contact: no draft is stored, nothing is handed to the send function, and
// no fallback ("there", "your company") ever reaches copy. Every person and company is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "@gtm-agents/core/config";
import { runColdBatch } from "@gtm-agents/core/outreach";
import { fakeJudge, fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "@gtm-agents/core/outreach/testing";

const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests in CI." } },
  agent: { name: "Avery" },
  sending: { from: { email: "avery@outreach.acme.example" }, replyTo: "avery@acme.example", supportAddress: "support@acme.example", postalAddress: "Acme Inc., 100 Example Street, Springfield", domain: "outreach.acme.example" },
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 } } },
});

beforeEach(async () => {
  await resetOutreachTables(env.DB);
  await uploadOutreachBrain(env.KV);
});

async function runAuto(templates: ReturnType<typeof templateFile>[]) {
  await uploadTemplates(env.KV, templates);
  const send = fakeSendOutreach();
  const result = await runColdBatch({
    db: env.DB,
    kv: env.KV,
    flags: flagReader({ "cold_batch:enabled": "true", "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true", "outreach:holdout_rate": "0" }),
    config,
    now: new Date("2026-11-09T13:00:00.000Z"),
    job: "cold_batch",
    log: silentLogger,
    send: send.send,
    volume: () => Promise.resolve(10),
    model: fakeJudge(),
  });
  return { send, result };
}

describe("a missing variable holds and never guesses", () => {
  it("holds a contact with no usable first name or company name, even in auto-approve mode", async () => {
    await seedContact(env.DB, { first: null, email: "nobody@umbrella.example", accountName: "Umbrella Group" });
    await seedContact(env.DB, { first: "x1", email: "digits@hooli.example", accountName: "Hooli Systems" });
    await seedContact(env.DB, { first: "Ada", email: "ada@fragment.example", accountName: "Ltd" });
    const { send, result } = await runAuto([templateFile("cold-intro")]);

    expect(send.items()).toHaveLength(0);
    expect(result.drafts).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n).toBe(0);
    const { results } = await env.DB.prepare("SELECT verdict, findings FROM quality_checks WHERE subject_type = 'draft'").all<{ verdict: string; findings: string }>();
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.verdict).toBe("hold");
      expect(r.findings).toContain("MISSING_VARIABLE");
    }
  });

  it("holds a template whose variable has no source, and builds no copy from a fallback", async () => {
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex" });
    const body = "Hi {{first_name}},\n\n{{angle_opener}} When a build fails for a reason unrelated to the change, someone reruns it and loses the thread.\n\nIs that something your team tracks at {{account_name}}?\n\n{{sender_name}}";
    const { send, result } = await runAuto([templateFile("cold-angle", { body })]);
    expect(send.items()).toHaveLength(0);
    expect(result.held).toBe(1);
    const finding = await env.DB.prepare("SELECT findings FROM quality_checks WHERE subject_type = 'draft'").first<{ findings: string }>();
    expect(finding?.findings).toContain("{{angle_opener}}");
  });

  it("sends nothing that contains a fallback phrase when the data is present", async () => {
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex" });
    const { send } = await runAuto([templateFile("cold-intro")]);
    expect(send.items()).toHaveLength(1);
    const item = send.items()[0];
    expect(item?.body.startsWith("Hi Jane,")).toBe(true);
    expect(item?.body).not.toMatch(/\bthere\b|your company/i);
    expect(item?.body).not.toMatch(/\{\{|\}\}/);
  });
});
