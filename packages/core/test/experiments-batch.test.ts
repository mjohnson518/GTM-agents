// GTM-agents: the cold batch with experiments: weighted rotation stays the default; a running
// experiment pins accounts before any draft is composed, and colleagues share the arm across
// batches; the arm reaches the send function; a subject test's variant is composed, gated and
// recorded; the send-time test gives each account a slot the send function applies; and Thompson
// allocation waits for matured sends. Every person and company is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { defineConfig, type GtmConfigInput } from "../src/config/index.ts";
import { createExperiment, createSubjectTest, markStarted } from "../src/experiments/index.ts";
import { runColdBatch, type ColdBatchDeps } from "../src/outreach/index.ts";
import { serveTemplateFiles } from "../src/templates/store.ts";
import { fakeJudge, fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates, type FakeSend } from "../src/outreach/testing.ts";

const NOW = new Date("2026-11-09T13:00:00.000Z");
const base: GtmConfigInput = {
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests in CI." } },
  agent: { name: "Avery" },
  sending: { from: { email: "avery@outreach.acme.example" }, replyTo: "avery@acme.example", supportAddress: "support@acme.example", postalAddress: "Acme Inc., 100 Example Street, Springfield", domain: "outreach.acme.example" },
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 } } },
};
const config = defineConfig(base);
const auto = { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" };

beforeEach(async () => {
  await resetOutreachTables(env.DB);
  await env.DB.batch(["subject_assignments", "subject_variants", "subject_tests", "experiment_assignments", "experiment_proposals", "experiments", "send_slot_schedules"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("acme-control"), templateFile("acme-treatment", { subject: "Rerun time at {{account_name}}" })]);
});

function deps(send: FakeSend, flags: Record<string, string>, now: Date = NOW, patch: Partial<ColdBatchDeps> = {}): ColdBatchDeps {
  return {
    db: env.DB,
    kv: env.KV,
    flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0", ...flags }),
    config,
    now,
    job: "cold_batch",
    log: silentLogger,
    send: send.send,
    volume: () => Promise.resolve(20),
    model: fakeJudge(),
    ...patch,
  };
}

async function runningExperiment(): Promise<string> {
  const served = await serveTemplateFiles([templateFile("acme-control"), templateFile("acme-treatment", { subject: "Rerun time at {{account_name}}" })], { companyDomain: "acme.example" });
  const copy = { controlSha: served.templates[0]?.sha256 ?? "", treatmentSha: served.templates[1]?.sha256 ?? "" };
  const e = await createExperiment(
    env.DB,
    {
      name: "Opener",
      hypothesis: "Naming rerun time earns more positive replies.",
      population: "General-template contacts.",
      exclusions: "None.",
      metric_window_days: 30,
      baseline_rate: 0.05,
      min_detectable_effect: 0.05,
      max_sample_per_arm: 300,
      max_duration_days: 42,
      stopping_rule: "Rules.",
      control_template: "acme-control",
      treatment_template: "acme-treatment",
    },
    new Date(NOW.getTime() - 86_400_000),
  );
  expect(await markStarted(env.DB, e, "operator:test", new Date(NOW.getTime() - 3_600_000), copy)).toBe(true);
  return e.id;
}

describe("allocation without experiments", () => {
  it("stays weighted rotation, with nothing credited to an arm", async () => {
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedContact(env.DB, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
    const operator = recordingOperator();
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, { ...auto, "experiments:enabled": "true" }, NOW, { operator: operator.channel }));
    const templates = (await env.DB.prepare("SELECT template_id FROM drafts ORDER BY template_id").all<{ template_id: string }>()).results.map((r) => r.template_id);
    expect(templates).toEqual(["acme-control", "acme-treatment"]);
    expect(send.items().every((i) => i.experimentId === undefined)).toBe(true);
    expect(operator.texts().join("\n")).toContain("Allocation: weighted rotation by volume_weight.");
  });

  it("in thompson mode, waits for 50 matured sends per arm and says so", async () => {
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const operator = recordingOperator();
    await runColdBatch(deps(fakeSendOutreach(), { "outreach:allocation_mode": "thompson" }, NOW, { operator: operator.channel }));
    expect(operator.texts().join("\n")).toContain("not every arm has 50 matured sends yet, so volume weights decide");
    expect((await env.DB.prepare("SELECT notes FROM campaigns").first<{ notes: string }>())?.notes).toMatch(/seed 2026-11-09:[0-9a-f-]{36}; holdout rate 0; allocation thompson/);
  });
});

describe("a running template experiment", () => {
  it("pins accounts before composing, credits the arm on the send, and keeps colleagues together across batches", async () => {
    const id = await runningExperiment();
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedContact(env.DB, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
    await seedContact(env.DB, { first: "Grace", email: "grace@initech.example", accountName: "Initech Labs" });
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, { ...auto, "experiments:enabled": "true" }));
    const pins = (await env.DB.prepare("SELECT unit_key, arm, seed FROM experiment_assignments WHERE scope = 'template_experiment' AND test_id = ?1").bind(id).all<{ unit_key: string; arm: string; seed: string }>()).results;
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.every((p) => /^2026-11-09:/.test(p.seed))).toBe(true);
    const arms = new Map(pins.map((p) => [p.unit_key, p.arm]));
    // Every enrolled draft was composed from its arm's template, and the arm went to the send function.
    for (const item of send.items()) {
      const unit = item.to.split("@")[1] ?? "";
      const arm = arms.get(unit);
      if (!arm) continue;
      expect(item.experimentId).toBe(id);
      expect(item.experimentArm).toBe(arm);
      expect(item.templateId).toBe(arm === "control" ? "acme-control" : "acme-treatment");
    }
    // A colleague at a pinned account, selected on a later day, gets the same arm.
    const pinnedUnit = pins[0]?.unit_key ?? "";
    await seedContact(env.DB, { first: "Joe", email: `joe@${pinnedUnit}`, accountName: "Same account", createdAt: "2026-11-02T00:00:00.000Z" });
    const later = fakeSendOutreach();
    await runColdBatch(deps(later, { ...auto, "experiments:enabled": "true" }, new Date("2026-11-20T13:00:00.000Z")));
    const joe = later.items().find((i) => i.to === `joe@${pinnedUnit}`);
    expect(joe?.experimentArm).toBe(arms.get(pinnedUnit));
    const cc = await env.DB.prepare("SELECT experiment_id, experiment_arm FROM campaign_contacts WHERE contact_id = (SELECT id FROM contacts WHERE email = ?1)").bind(`joe@${pinnedUnit}`).first<{ experiment_id: string; experiment_arm: string }>();
    expect(cc).toEqual({ experiment_id: id, experiment_arm: arms.get(pinnedUnit) });
  });

  it("enrolls no one while experiments:enabled is off", async () => {
    await runningExperiment();
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, auto));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM experiment_assignments").first<{ n: number }>())?.n).toBe(0);
    expect(send.items().every((i) => i.experimentId === undefined)).toBe(true);
  });
});

describe("subject tests and the send-time test", () => {
  it("composes the variant's subject through the gate and records it against the draft", async () => {
    const test = await createSubjectTest(env.DB, { name: "Subjects", template: "acme-control", variants: ["Flaky builds at {{account_name}}", "A question about reruns"] }, NOW);
    if ("error" in test) throw new Error(test.error);
    await uploadTemplates(env.KV, [templateFile("acme-control")]);
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedContact(env.DB, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
    await runColdBatch(deps(fakeSendOutreach(), { "experiments:enabled": "true" }));
    const rows = (await env.DB.prepare("SELECT d.subject, sa.variant_id FROM drafts d JOIN subject_assignments sa ON sa.draft_id = d.id").all<{ subject: string; variant_id: string }>()).results;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const variant = test.variants.find((v) => v.id === r.variant_id);
      expect(variant).toBeDefined();
      expect(r.subject).toBe(variant?.text.replace("{{account_name}}", r.subject.includes("Globex") ? "Globex Corporation" : "Northwind Tools"));
    }
  });

  it("gives each account a slot and hands the slot to the send function", async () => {
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedContact(env.DB, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, { ...auto, "outreach:send_time_experiment": "true" }));
    const slots = (await env.DB.prepare("SELECT slot FROM send_slot_schedules ORDER BY slot").all<{ slot: string }>()).results.map((r) => r.slot);
    // Both contacts share the default time zone, so the two accounts get one slot each.
    expect(slots).toEqual(["afternoon", "early"]);
    expect(send.items().map((i) => i.sendSlot).sort()).toEqual(["afternoon", "early"]);
  });
});

describe("what the reviewer's edge cases must never do", () => {
  it("does not run the send-time test when the configured window cannot hold both slots", async () => {
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const afternoonOnly = defineConfig({ ...base, sending: { ...base.sending, windowHours: { start: 13, end: 17 } } });
    const operator = recordingOperator();
    const send = fakeSendOutreach();
    await runColdBatch({ ...deps(send, { ...auto, "outreach:send_time_experiment": "true" }), config: afternoonOnly, operator: operator.channel });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM send_slot_schedules").first<{ n: number }>())?.n).toBe(0);
    expect(send.items().every((i) => i.sendSlot === undefined)).toBe(true);
    expect(operator.texts().join("\n")).toContain("does not hold both slots");
  });

  it("never gives a pinned account's colleague the other arm's template", async () => {
    await uploadTemplates(env.KV, [templateFile("acme-control"), templateFile("acme-treatment", { subject: "Rerun time at {{account_name}}" }), templateFile("acme-other", { subject: "Build minutes at {{account_name}}" })]);
    const id = await runningExperiment();
    await env.DB.prepare("INSERT INTO experiment_assignments (scope, test_id, unit_key, arm, assigned_at) VALUES ('template_experiment', ?1, 'globex.example', 'treatment', ?2)").bind(id, NOW.toISOString()).run();
    // The treatment arm is full, so the pinned account enrolls no one more; its colleague must not get the control.
    await env.DB.prepare("UPDATE experiments SET max_sample_per_arm = 0 WHERE id = ?1").bind(id).run();
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, { ...auto, "experiments:enabled": "true" }));
    const jane = send.items().find((i) => i.to === "jane@globex.example");
    expect(jane?.templateId).toBe("acme-other");
    expect(jane?.experimentId).toBeUndefined();
  });

  it("pins an account that heard an experiment's copy outside it as excluded, so it never enrolls later", async () => {
    const id = await runningExperiment();
    await env.DB.prepare("UPDATE experiments SET max_sample_per_arm = 0 WHERE id = ?1").bind(id).run();
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await runColdBatch(deps(fakeSendOutreach(), { ...auto, "experiments:enabled": "true" }));
    const pin = await env.DB.prepare("SELECT arm FROM experiment_assignments WHERE test_id = ?1 AND unit_key = 'globex.example'").bind(id).first<{ arm: string }>();
    expect(pin?.arm).toBe("excluded");
  });

  it("enrolls no one in an experiment whose copy changed since it started", async () => {
    const id = await runningExperiment();
    await uploadTemplates(env.KV, [templateFile("acme-control"), templateFile("acme-treatment", { subject: "An edited subject at {{account_name}}" })]);
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const operator = recordingOperator();
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, { ...auto, "experiments:enabled": "true" }, NOW, { operator: operator.channel }));
    expect(send.items().every((i) => i.experimentId === undefined)).toBe(true);
    expect(operator.texts().join("\n")).toContain(`Experiment ${id} (Opener) enrolls no one: the copy of treatment acme-treatment changed`);
  });

  it("applies an approved subject winner even with experiments switched off", async () => {
    const test = await createSubjectTest(env.DB, { name: "Subjects", template: "acme-control", variants: ["Reruns at {{account_name}}", "Flaky builds this week"] }, NOW);
    if ("error" in test) throw new Error(test.error);
    await env.DB.prepare("UPDATE subject_tests SET status = 'concluded', winner_variant_id = ?2 WHERE id = ?1").bind(test.id, test.variants[0]?.id ?? "").run();
    await uploadTemplates(env.KV, [templateFile("acme-control")]);
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, auto));
    expect(send.items()[0]?.subject).toBe("Reruns at Globex Corporation");
  });

  it("refuses a subject test on a running experiment's template", async () => {
    await runningExperiment();
    const refused = await createSubjectTest(env.DB, { name: "Clash", template: "acme-treatment", variants: ["One", "Two"] }, NOW);
    expect("error" in refused && refused.error).toMatch(/in running experiment/);
  });

  it("in thompson mode keeps an account on the general template it already got", async () => {
    const served = await serveTemplateFiles([templateFile("acme-control"), templateFile("acme-treatment", { subject: "Rerun time at {{account_name}}" })], { companyDomain: "acme.example" });
    const rows: D1PreparedStatement[] = [];
    for (const t of served.templates) {
      rows.push(env.DB.prepare("INSERT INTO templates (id, kind, status, step, body_sha256, volume_weight, created_at, updated_at) VALUES (?1, 'cold_intro', 'approved', 1, ?2, 1, ?3, ?3)").bind(t.id, t.sha256, NOW.toISOString()));
      for (let i = 0; i < 60; i++) {
        rows.push(
          env.DB.prepare("INSERT INTO outreach_sends (id, account_key, template_id, template_sha256, sequence_step, send_path, provider, sent_at) VALUES (?1, ?2, ?3, ?4, 1, 'cold', 'test-ledger', ?5)").bind(
            `th_${t.id}_${i}`,
            `filler${i}-${t.id}.example`,
            t.id,
            t.sha256,
            new Date(NOW.getTime() - 20 * 86_400_000).toISOString(),
          ),
        );
      }
    }
    for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
    // A colleague at globex already got the treatment template.
    await env.DB.prepare("INSERT INTO outreach_sends (id, account_key, template_id, template_sha256, sequence_step, send_path, provider, sent_at) VALUES ('th_globex', 'globex.example', 'acme-treatment', ?1, 1, 'cold', 'test-ledger', ?2)")
      .bind(served.templates[1]?.sha256 ?? "", new Date(NOW.getTime() - 3 * 86_400_000).toISOString())
      .run();
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    const send = fakeSendOutreach();
    await runColdBatch(deps(send, { ...auto, "outreach:allocation_mode": "thompson" }));
    expect(send.items().find((i) => i.to === "jane@globex.example")?.templateId).toBe("acme-treatment");
  });
});
