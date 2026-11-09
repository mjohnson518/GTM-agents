// GTM-agents: the copy-change gate, proposals and the experiment commands. Nothing applies a change
// without the operator's approve command; an approval applies only if nothing changed since the
// proposal; an experiment starts only through two steps that bind to the exact record and copy, and
// never without its pre-registration. Every template and value is synthetic.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GATE_MIN_PER_ARM,
  approveProposal,
  copyChangeGate,
  createProposal,
  loadExperiment,
  loadProposal,
  markStarted,
  parseExperimentCommand,
  parseFields,
  promotedWeights,
  rejectProposal,
  runExperimentCommand,
  type ExperimentCommandDeps,
} from "../src/experiments/index.ts";
import { claimEffect, releaseEffect } from "../src/events/effects.ts";
import type { FlagReader } from "../src/jobs/registry.ts";
import type { ServedTemplate } from "../src/templates/store.ts";
import { servedAcmeTemplates } from "./experiments-fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-09T09:00:00.000Z");
const kvFlags: FlagReader = { get: (key) => env.KV.get(key) };

beforeEach(async () => {
  await db.batch(["experiment_proposals", "experiments", "templates"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  for (const key of ["experiments:template_weight:gate-a", "experiments:template_weight:gate-b", "outreach:holdout_rate", "experiments:enabled"]) await env.KV.delete(key);
});

describe("the copy-change gate", () => {
  it("needs 300 matured sends per arm and P(better) of 0.95 from the normal approximation", () => {
    expect(copyChangeGate({ id: "w", sends: GATE_MIN_PER_ARM - 1, successes: 90 }, { id: "l", sends: 300, successes: 10 }).pass).toBe(false);
    expect(copyChangeGate({ id: "w", sends: 300, successes: 22 }, { id: "l", sends: 300, successes: 15 }).pass).toBe(false);
    const pass = copyChangeGate({ id: "w", sends: 300, successes: 40 }, { id: "l", sends: 300, successes: 15 });
    expect(pass.pass).toBe(true);
    // Deterministic: the same counts always give the same probability.
    expect(copyChangeGate({ id: "w", sends: 300, successes: 40 }, { id: "l", sends: 300, successes: 15 }).probability).toBe(pass.probability);
  });

  it("promotion moves the loser's weight to the winner and leaves the loser at the floor", () => {
    expect(promotedWeights(1, 1)).toEqual({ winner: 1.9, loser: 0.1 });
    expect(promotedWeights(2, 0.05)).toEqual({ winner: 2, loser: 0.1 });
  });
});

function applyDeps(templates: () => Promise<readonly ServedTemplate[]>) {
  return { db, kv: env.KV, flags: kvFlags, templates, userId: "operator:test", now: NOW };
}

describe("proposals", () => {
  it("are deduplicated for 7 days", async () => {
    const input = { kind: "holdout_rate" as const, target: "outreach:holdout_rate", current: "", proposed: "0.1", reason: "few held", prediction: "100 held" };
    const first = await createProposal(db, input, NOW);
    const again = await createProposal(db, input, new Date(NOW.getTime() + 6 * 86_400_000));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect((await createProposal(db, input, new Date(NOW.getTime() + 8 * 86_400_000))).created).toBe(true);
  });

  it("apply a setting only if it still holds the value they were made against", async () => {
    const { proposal } = await createProposal(db, { kind: "holdout_rate", target: "outreach:holdout_rate", current: "", proposed: "0.1", reason: "r", prediction: "p" }, NOW);
    await env.KV.put("outreach:holdout_rate", "0.08");
    const stale = await approveProposal(applyDeps(() => Promise.resolve([])), proposal.id);
    expect(stale.ok).toBe(false);
    expect((await loadProposal(db, proposal.id))?.status).toBe("stale");
    expect(await env.KV.get("outreach:holdout_rate")).toBe("0.08");

    await env.KV.delete("outreach:holdout_rate");
    const { proposal: fresh } = await createProposal(db, { kind: "holdout_rate", target: "outreach:holdout_rate", current: "", proposed: "0.12", reason: "r", prediction: "p" }, NOW);
    expect((await approveProposal(applyDeps(() => Promise.resolve([])), fresh.id)).ok).toBe(true);
    expect(await env.KV.get("outreach:holdout_rate")).toBe("0.12");
    // Applied once: a second approval does nothing.
    expect((await approveProposal(applyDeps(() => Promise.resolve([])), fresh.id)).ok).toBe(false);
  });

  it("refuse a target or value they may not write", async () => {
    const { proposal } = await createProposal(db, { kind: "holdout_rate", target: "system:halt", current: "", proposed: "0.1", reason: "r", prediction: "p" }, NOW);
    expect((await approveProposal(applyDeps(() => Promise.resolve([])), proposal.id)).ok).toBe(false);
    const { proposal: big } = await createProposal(db, { kind: "holdout_rate", target: "outreach:holdout_rate", current: "", proposed: "0.5", reason: "r", prediction: "p" }, NOW);
    expect((await approveProposal(applyDeps(() => Promise.resolve([])), big.id)).ok).toBe(false);
    expect(await env.KV.get("system:halt")).toBeNull();
  });

  it("a copy change applies only while both templates and weights are as proposed", async () => {
    const templates = await servedAcmeTemplates(db, ["gate-a", "gate-b"]);
    const [a, b] = templates;
    if (!a || !b) throw new Error("two templates");
    const snapshot = { change: "template_pair", winnerTemplate: a.id, loserTemplate: b.id, winnerSha: a.sha256, loserSha: b.sha256, winnerWeight: "", loserWeight: "" };
    const { proposal } = await createProposal(db, { kind: "copy_change", target: `template:${a.id}`, current: "", proposed: `promote ${a.id} over ${b.id}`, reason: "r", prediction: "p", evidence: { snapshot } }, NOW);

    // The winner's copy changed since: stale, nothing written.
    const edited = [{ ...a, sha256: "e".repeat(64) }, b];
    expect((await approveProposal(applyDeps(() => Promise.resolve(edited)), proposal.id)).ok).toBe(false);
    expect((await loadProposal(db, proposal.id))?.status).toBe("stale");
    expect(await env.KV.get(`experiments:template_weight:${a.id}`)).toBeNull();

    const { proposal: second } = await createProposal(db, { kind: "copy_change", target: `template:${a.id}`, current: "", proposed: `promote ${a.id} over ${b.id} again`, reason: "r", prediction: "p", evidence: { snapshot } }, NOW);
    // A weight changed since: stale.
    await env.KV.put(`experiments:template_weight:${b.id}`, "3");
    expect((await approveProposal(applyDeps(() => Promise.resolve(templates)), second.id)).ok).toBe(false);
    await env.KV.delete(`experiments:template_weight:${b.id}`);

    const { proposal: third } = await createProposal(db, { kind: "copy_change", target: `template:${a.id}`, current: "", proposed: `promote ${a.id} over ${b.id} once more`, reason: "r", prediction: "p", evidence: { snapshot } }, NOW);
    const applied = await approveProposal(applyDeps(() => Promise.resolve(templates)), third.id);
    expect(applied.ok).toBe(true);
    expect(await env.KV.get(`experiments:template_weight:${a.id}`)).toBe("1.9");
    expect(await env.KV.get(`experiments:template_weight:${b.id}`)).toBe("0.1");
  });

  it("expire after 14 days, even when nothing ran the expiry", async () => {
    const { proposal } = await createProposal(db, { kind: "holdout_rate", target: "outreach:holdout_rate", current: "", proposed: "0.15", reason: "r", prediction: "p" }, new Date(NOW.getTime() - 15 * 86_400_000));
    const result = await approveProposal(applyDeps(() => Promise.resolve([])), proposal.id);
    expect(result.text).toContain("has expired");
    expect((await loadProposal(db, proposal.id))?.status).toBe("expired");
    expect(await env.KV.get("outreach:holdout_rate")).toBeNull();
  });

  it("never apply while another approval holds the same setting", async () => {
    const { proposal } = await createProposal(db, { kind: "holdout_rate", target: "outreach:holdout_rate", current: "", proposed: "0.11", reason: "r", prediction: "p" }, NOW);
    await claimEffect(db, "setting:outreach:holdout_rate", "experiment_setting_lock");
    const busy = await approveProposal(applyDeps(() => Promise.resolve([])), proposal.id);
    expect(busy.ok).toBe(false);
    expect(busy.text).toContain("Another change to the same setting");
    expect((await loadProposal(db, proposal.id))?.status).toBe("pending");
    await releaseEffect(db, "setting:outreach:holdout_rate", "experiment_setting_lock");
    expect((await approveProposal(applyDeps(() => Promise.resolve([])), proposal.id)).ok).toBe(true);
    // The lock is released after applying.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM event_effects WHERE effect = 'experiment_setting_lock'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("can be declined, once", async () => {
    const { proposal } = await createProposal(db, { kind: "send_time_experiment", target: "outreach:send_time_experiment", current: "", proposed: "true", reason: "r", prediction: "p" }, NOW);
    expect((await rejectProposal(db, proposal.id, "operator:test", NOW)).ok).toBe(true);
    expect((await rejectProposal(db, proposal.id, "operator:test", NOW)).ok).toBe(false);
    expect((await approveProposal(applyDeps(() => Promise.resolve([])), proposal.id)).ok).toBe(false);
  });
});

describe("experiment commands", () => {
  let templates: ServedTemplate[] = [];
  const deps = (): ExperimentCommandDeps => ({ db, kv: env.KV, flags: kvFlags, templates: () => Promise.resolve(templates), userId: "42", now: () => NOW });
  const run = async (text: string) => {
    const command = parseExperimentCommand(text);
    if (!command) throw new Error(`not a command: ${text}`);
    return runExperimentCommand(deps(), command);
  };
  const fields = (extra = "") =>
    [
      "name: Opener test",
      "hypothesis: A rerun question earns more positive replies.",
      "population: General-template contacts.",
      "exclusions: None.",
      "metric_window_days: 30",
      "baseline_rate: 0.05",
      "min_detectable_effect: 0.05",
      "max_sample_per_arm: 300",
      "max_duration_days: 42",
      "stopping_rule: Conclude by the rules.",
      "control_template: gate-a",
      "treatment_template: gate-b",
      extra,
    ].join("\n");
  const idFrom = (text: string) => /Experiment ([0-9a-f]{10})/.exec(text)?.[1] ?? "";

  beforeEach(async () => {
    templates = await servedAcmeTemplates(db, ["gate-a", "gate-b"]);
  });

  it("parses JSON or key: value fields", () => {
    expect(parseFields('{"name":"x","max_sample_per_arm":40}')).toEqual({ name: "x", max_sample_per_arm: 40 });
    expect(parseFields("name: x\nmax sample per arm: 40\nvariant: A\nvariant: B")).toEqual({ name: "x", max_sample_per_arm: 40, variants: ["A", "B"] });
    expect(parseExperimentCommand("hello")).toBeNull();
    expect(parseExperimentCommand("exp-approve-0123456789")).toEqual({ kind: "approve", id: "0123456789" });
  });

  it("refuses to start without the whole pre-registration, or with a max sample under 20", async () => {
    const created = await run("experiment-create name: Thin\nhypothesis: Something.");
    expect(created).toContain("Before it can start it needs:");
    const id = idFrom(created);
    expect(await run(`experiment-start ${id}`)).toMatch(/cannot start: its pre-registration is missing: population, exclusions/);
    expect(await run(`experiment-update ${id} max_sample_per_arm: 10`)).toMatch(/Not changed: max_sample_per_arm/);
  });

  it("starts in two steps, and only if nothing changed between them", async () => {
    const created = await run(`experiment-create ${fields()}`);
    const id = idFrom(created);
    const first = await run(`experiment-start ${id}`);
    expect(first).toContain("Control gate-a:");
    expect(first).toMatch(/ 1 {2}Hi \{\{first_name\}\},/);
    const command = /experiment-start-[0-9a-f]{10}-[0-9a-f]{6}/.exec(first)?.[0] ?? "";
    expect(command).not.toBe("");
    expect((await loadExperiment(db, id))?.status).toBe("draft");

    // The treatment's copy changes between the steps: the code no longer matches.
    const original = templates;
    templates = [original[0] as ServedTemplate, { ...(original[1] as ServedTemplate), sha256: "d".repeat(64) }];
    expect(await run(command)).toContain("changed since that code was given");
    expect((await loadExperiment(db, id))?.status).toBe("draft");

    templates = original;
    expect(await run(command)).toContain("is running");
    const started = await loadExperiment(db, id);
    expect(started?.status).toBe("running");
    expect(started?.approver).toBe("operator:42");
    expect(started?.targetPerArm).toBe(300);
    // Locked: a running experiment cannot be amended.
    expect(await run(`experiment-update ${id} name: Renamed`)).toContain("is not a draft");
  });

  it("does not start a record amended after it was checked", async () => {
    const id = idFrom(await run(`experiment-create ${fields()}`));
    const checked = await loadExperiment(db, id);
    if (!checked) throw new Error("no record");
    await run(`experiment-update ${id} hypothesis: A different claim.`);
    expect(await markStarted(db, checked, "operator:test", NOW, { controlSha: "a".repeat(64), treatmentSha: "b".repeat(64) })).toBe(false);
    expect((await loadExperiment(db, id))?.status).toBe("draft");
  });

  it("refuses to start while a subject test runs on one of its templates", async () => {
    const id = idFrom(await run(`experiment-create ${fields()}`));
    expect(await run("subject-test-create name: Clash\ntemplate: gate-b\nvariant: One line\nvariant: Another line")).toContain("is running on gate-b");
    expect(await run(`experiment-start ${id}`)).toMatch(/subject test [0-9a-f]{10} is running on gate-b/);
    await db.prepare("DELETE FROM subject_tests").run();
  });

  it("runs at most two at once", async () => {
    for (let i = 0; i < 3; i++) {
      const id = idFrom(await run(`experiment-create ${fields()}`));
      const command = /experiment-start-[0-9a-f]{10}-[0-9a-f]{6}/.exec(await run(`experiment-start ${id}`))?.[0];
      const reply = command ? await run(command) : await run(`experiment-start ${id}`);
      if (i < 2) expect(reply).toContain("is running");
      else expect(reply).toMatch(/already running|did not start/);
    }
  });

  it("refuses to start while measurement health blocks", async () => {
    const id = idFrom(await run(`experiment-create ${fields()}`));
    // 25 recent sends with no provider evidence: reply conclusions are blocked.
    const rows = Array.from({ length: 25 }, (_, i) =>
      db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sequence_step, sent_at) VALUES (?1, 'cold', 'test-ledger', 1, ?2)").bind(`hb_${i}`, new Date(NOW.getTime() - 86_400_000).toISOString()),
    );
    await db.batch(rows);
    expect(await run(`experiment-start ${id}`)).toContain("measurement health blocks it");
    await db.prepare("DELETE FROM outreach_sends WHERE id LIKE 'hb_%'").run();
  });
});
