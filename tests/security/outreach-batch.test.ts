// GTM-agents: the cold batch's safety properties. Nothing runs with its flag off. Nothing is approved
// automatically unless the operator's switch is on or the cold_batch class has earned level 2, and
// even then only drafts the model reviewer passed; a reviewer that is off or fails holds everything.
// The holdout is never sent, and a second run on the same day hands nothing over twice. Every
// person and company is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig, type GtmConfigInput } from "@gtm-agents/core/config";
import { runOneJob, type JobContext, type RegisteredJob } from "@gtm-agents/core/jobs";
import { createOutreachJobs, readAutoApprove, runColdBatch, type ColdBatchDeps, type OutreachEnv } from "@gtm-agents/core/outreach";
import { fakeJudge, fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates, type FakeSend, type JudgeFailure } from "@gtm-agents/core/outreach/testing";

const NOW = new Date("2026-11-09T13:00:00.000Z");
const base: GtmConfigInput = {
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests in CI." } },
  agent: { name: "Avery" },
  sending: { from: { email: "avery@outreach.acme.example" }, replyTo: "avery@acme.example", supportAddress: "support@acme.example", postalAddress: "Acme Inc., 100 Example Street, Springfield", domain: "outreach.acme.example" },
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 } } },
};
const config = defineConfig(base);

beforeEach(async () => {
  await resetOutreachTables(env.DB);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("cold-intro")]);
  await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
  await seedContact(env.DB, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
});

function deps(send: FakeSend, flags: Record<string, string>, patch: Partial<ColdBatchDeps> = {}): ColdBatchDeps {
  return {
    db: env.DB,
    kv: env.KV,
    flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0", ...flags }),
    config,
    now: NOW,
    job: "cold_batch",
    log: silentLogger,
    send: send.send,
    volume: () => Promise.resolve(10),
    model: fakeJudge(),
    ...patch,
  };
}

const statuses = async () => (await env.DB.prepare("SELECT status FROM drafts").all<{ status: string }>()).results.map((r) => r.status);

describe("with the flag off nothing runs", () => {
  it("writes nothing and sends nothing, whether called directly or as a job", async () => {
    const send = fakeSendOutreach();
    for (const flags of [{ "cold_batch:enabled": "false" }, { "cold_batch:enabled": "" }]) {
      expect((await runColdBatch(deps(send, flags))).status).toBe("skipped");
    }
    expect((await runColdBatch({ ...deps(send, {}), flags: flagReader({}, ["*"]) })).status).toBe("skipped");
    const [job] = createOutreachJobs<OutreachEnv>({ send: () => send.send, volume: () => Promise.resolve(10) });
    const ctx = (signal: AbortSignal): JobContext<OutreachEnv> => ({ env: { DB: env.DB, KV: env.KV }, config, job: "cold_batch", now: NOW, signal, ceilings: job!.ceilings, flags: flagReader({}), log: silentLogger });
    const outcome = await runOneJob(job as RegisteredJob<OutreachEnv>, (_j, signal) => ctx(signal));
    expect(outcome.status).toBe("skipped");
    expect(await job!.run(ctx(new AbortController().signal))).toEqual({ summary: "flag off" });
    expect(send.calls).toHaveLength(0);
    for (const table of ["campaigns", "drafts", "event_effects", "outreach_holdout", "quality_checks"]) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n, table).toBe(0);
    }
  });

  it("does nothing while cold outreach is paused", async () => {
    await env.KV.put("outreach:cold-pause", JSON.stringify({ reason: "bounce spike", source: "test", since: NOW.toISOString() }));
    const send = fakeSendOutreach();
    expect((await runColdBatch(deps(send, { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" }))).status).toBe("skipped");
    expect(send.calls).toHaveLength(0);
    await env.KV.delete("outreach:cold-pause");
  });
});

describe("auto-approve requires the switch or level 2, and a passing review", () => {
  const review = { "quality:model_review_enabled": "true" };

  it("leaves every draft for a person by default", async () => {
    const send = fakeSendOutreach();
    const result = await runColdBatch(deps(send, review));
    expect(result.status).toBe("manual");
    expect(await statuses()).toEqual(["pending_approval", "pending_approval"]);
    expect(send.calls).toHaveLength(0);
  });

  it("approves with the operator's switch or the class at level 2 or above, stored or configured", async () => {
    expect(await readAutoApprove(flagReader({ "cold_batch:auto_approve": "true" }), config)).toMatchObject({ auto: true, reason: "flag" });
    expect(await readAutoApprove(flagReader({ "autonomy:cold_batch": "2" }), config)).toMatchObject({ auto: true, reason: "autonomy_level", level: 2 });
    expect(await readAutoApprove(flagReader({}), defineConfig({ ...base, autonomy: { defaults: { cold_batch: 3 } } }))).toMatchObject({ auto: true, level: 3 });
    for (const stored of ["1", "0", "2.5", "9", "two", " "]) {
      expect((await readAutoApprove(flagReader({ "autonomy:cold_batch": stored }), config)).auto, stored).toBe(false);
    }
    expect(await readAutoApprove(flagReader({}, ["*"]), defineConfig({ ...base, autonomy: { defaults: { cold_batch: 3 } } }))).toMatchObject({ auto: false, level: 1 });

    const send = fakeSendOutreach();
    const result = await runColdBatch(deps(send, { ...review, "autonomy:cold_batch": "2" }));
    expect(result.status).toBe("sent");
    expect(send.items()).toHaveLength(2);
    expect((await env.DB.prepare("SELECT DISTINCT approved_by FROM drafts").first<{ approved_by: string }>())?.approved_by).toBe("auto:autonomy_level");
  });

  it("approves nothing while the model reviewer is switched off", async () => {
    const send = fakeSendOutreach();
    const result = await runColdBatch(deps(send, { "cold_batch:auto_approve": "true" }));
    expect(send.calls).toHaveLength(0);
    expect(result.passed).toBe(0);
    expect(await statuses()).toEqual(["pending_approval", "pending_approval"]);
    const finding = await env.DB.prepare("SELECT findings FROM quality_checks WHERE subject_type = 'draft' LIMIT 1").first<{ findings: string }>();
    expect(finding?.findings).toContain("REVIEW_UNAVAILABLE");
  });

  it("fails closed when the reviewer fails in any way", async () => {
    const failures: Array<JudgeFailure | "no_gateway" | "no_price" | "rejects"> = ["throw", "garbage", "missing_verdict", "out_of_range", "hang", "no_gateway", "no_price", "rejects"];
    for (const failure of failures) {
      await resetOutreachTables(env.DB);
      await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
      const send = fakeSendOutreach();
      const patch: Partial<ColdBatchDeps> =
        failure === "no_gateway"
          ? { model: undefined }
          : failure === "no_price"
            ? { config: defineConfig({ ...base, models: { roles: { judge: "unpriced" }, pricing: {} } }) }
            : failure === "rejects"
              ? { model: fakeJudge({ pass: false }) }
              : { model: fakeJudge({ failure }), reviewTimeoutMs: 20 };
      const result = await runColdBatch(deps(send, { "cold_batch:auto_approve": "true", ...review }, patch));
      expect(send.calls, failure).toHaveLength(0);
      expect(result.passed, failure).toBe(0);
      expect(await statuses(), failure).toEqual(["pending_approval"]);
    }
  });
});

describe("the holdout is never sent", () => {
  it("records held contacts, drafts nothing for them, hands them to no one and keeps them out of later batches", async () => {
    for (let i = 0; i < 50; i++) await seedContact(env.DB, { first: "Kim", email: `kim@acct${i}.example`, accountName: `Account Number ${i}` });
    const send = fakeSendOutreach();
    const flags = { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true", "outreach:holdout_rate": "0.2" };
    const result = await runColdBatch(deps(send, flags, { volume: () => Promise.resolve(60) }));
    const held = (await env.DB.prepare("SELECT contact_id FROM outreach_holdout").all<{ contact_id: string }>()).results.map((r) => r.contact_id);
    expect(held.length).toBeGreaterThan(0);
    expect(result.heldOut).toBe(held.length);
    const drafted = (await env.DB.prepare("SELECT contact_id FROM drafts").all<{ contact_id: string }>()).results.map((r) => r.contact_id);
    expect(drafted.filter((id) => held.includes(id))).toEqual([]);
    expect(send.items().filter((i) => held.includes(i.contactId))).toEqual([]);

    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
    await runColdBatch(deps(send, flags, { now: tomorrow, volume: () => Promise.resolve(40) }));
    expect(send.items().filter((i) => held.includes(i.contactId))).toEqual([]);
  });
});

describe("a re-run the same day does not duplicate", () => {
  it("creates one campaign, one draft per contact and one hand-over per draft", async () => {
    const send = fakeSendOutreach();
    const flags = { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" };
    await runColdBatch(deps(send, flags));
    await runColdBatch(deps(send, flags));
    await Promise.all([runColdBatch(deps(send, flags)), runColdBatch(deps(send, flags))]);
    expect(send.items()).toHaveLength(2);
    expect(new Set(send.items().map((i) => i.idempotencyKey)).size).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n).toBe(2);
  });

  it("resumes the day's unsent approved drafts instead of starting a new batch", async () => {
    const flaky = fakeSendOutreach((item) => ({ idempotencyKey: item.idempotencyKey, status: "failed", retryable: true, message: "provider unavailable" }));
    const flags = { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" };
    await runColdBatch(deps(flaky, flags));
    expect(flaky.items()).toHaveLength(2);
    // While another run is still writing the batch, nothing of it is resumed.
    await env.DB.prepare("UPDATE campaigns SET status = 'draft', updated_at = ?1").bind(NOW.toISOString()).run();
    const early = fakeSendOutreach();
    await runColdBatch(deps(early, flags));
    expect(early.calls).toHaveLength(0);
    // Long past the run's ceiling, the interrupted batch is resumed.
    await env.DB.prepare("UPDATE campaigns SET updated_at = '2026-11-09T12:00:00.000Z'").run();
    const send = fakeSendOutreach();
    const again = await runColdBatch(deps(send, flags));
    expect(again.status).toBe("resumed");
    expect(send.items()).toHaveLength(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n).toBe(2);
  });
});
