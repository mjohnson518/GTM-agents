// GTM-agents: the weekly self-review: rule-based, at most three proposals a week, each with a
// prediction and the setting's current value, judged later as hit or miss, and never applied by
// the review itself. Every send and template is synthetic.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { pendingProposals, runSelfReview, type SelfReviewDeps } from "../src/experiments/index.ts";
import { flagReader } from "../src/outreach/testing.ts";
import type { ServedTemplate } from "../src/templates/store.ts";
import { DAY, insertLedger, iso, quiet, servedAcmeTemplates } from "./experiments-fixtures.ts";

const db = env.DB;
const NOW = new Date("2026-11-08T14:00:00.000Z");
const T = NOW.getTime();
let templates: ServedTemplate[] = [];

beforeEach(async () => {
  await db.batch(["experiment_proposals", "outreach_sends", "templates"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  templates = await servedAcmeTemplates(db, ["review-control", "review-better"]);
});

function deps(flags: Record<string, string> = {}, patch: Partial<SelfReviewDeps> = {}): SelfReviewDeps {
  return { db, flags: flagReader({ "experiments:control_template": "review-control", ...flags }), now: NOW, log: quiet, templates: () => Promise.resolve(templates), ...patch };
}

async function clearWinner(): Promise<void> {
  const [control, better] = templates;
  if (!control || !better) throw new Error("two templates");
  await insertLedger(db, { templateId: control.id, sha: control.sha256, sends: 200, positives: 6, sentAt: iso(T - 20 * DAY) });
  await insertLedger(db, { templateId: better.id, sha: better.sha256, sends: 200, positives: 24, sentAt: iso(T - 20 * DAY) });
}

describe("the weekly self-review", () => {
  it("proposes a weight step and a bigger holdout, with predictions, and applies nothing", async () => {
    await clearWinner();
    const operator = recordingOperator();
    const result = await runSelfReview(deps({}, { operator: operator.channel }));
    const pending = await pendingProposals(db);
    const weight = pending.find((p) => p.kind === "template_weight");
    expect(weight).toMatchObject({ target: "experiments:template_weight:review-better", current: "", proposed: "1.1" });
    expect(weight?.prediction).toContain("stays above the control's");
    const holdout = pending.find((p) => p.kind === "holdout_rate");
    expect(holdout).toMatchObject({ target: "outreach:holdout_rate", proposed: "0.1" });
    expect(result.proposed.length).toBeLessThanOrEqual(3);
    const text = operator.texts().join("\n");
    expect(text).toContain("Track record: no earlier proposal judged yet.");
    expect(text).toMatch(/exp-approve-[0-9a-f]{10}/);
  });

  it("makes at most three proposals in any seven days", async () => {
    await clearWinner();
    const sends = Array.from({ length: 320 }, (_, i) => db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sequence_step, sent_at) VALUES (?1, 'cold', 'test-ledger', 1, ?2)").bind(`st_${i}`, iso(T - 12 * DAY)));
    for (let i = 0; i < sends.length; i += 100) await db.batch(sends.slice(i, i + 100));
    const volume = () => Promise.resolve(50);
    const first = await runSelfReview(deps({}, { volume, signalSources: ["job-boards"] }));
    expect(first.proposed).toHaveLength(3);
    const second = await runSelfReview(deps({}, { volume, signalSources: ["job-boards"], now: new Date(T + 2 * DAY) }));
    expect(second.proposed).toHaveLength(0);
  });

  it("judges an applied proposal later and shows the track record", async () => {
    await clearWinner();
    await runSelfReview(deps());
    const weight = (await pendingProposals(db)).find((p) => p.kind === "template_weight");
    if (!weight) throw new Error("no weight proposal");
    await db.prepare("UPDATE experiment_proposals SET status = 'applied', decided_at = ?2 WHERE id = ?1").bind(weight.id, iso(T - 40 * DAY)).run();
    // Matured sends since it applied still favor the raised template.
    const [control, better] = templates;
    if (!control || !better) throw new Error("two templates");
    await insertLedger(db, { templateId: control.id, sha: control.sha256, sends: 60, positives: 2, sentAt: iso(T - 30 * DAY) });
    await insertLedger(db, { templateId: better.id, sha: better.sha256, sends: 60, positives: 9, sentAt: iso(T - 30 * DAY) });
    const later = await runSelfReview(deps({}, { now: new Date(T + 8 * DAY) }));
    expect(later.judged).toBe(1);
    const row = await db.prepare("SELECT outcome FROM experiment_proposals WHERE id = ?1").bind(weight.id).first<{ outcome: string }>();
    expect(row?.outcome).toBe("hit");
  });

  it("proposes no weight change while measurement health blocks reply conclusions", async () => {
    await clearWinner();
    const recent = Array.from({ length: 25 }, (_, i) => db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sequence_step, sent_at) VALUES (?1, 'cold', 'test-ledger', 1, ?2)").bind(`hr_${i}`, iso(T - DAY)));
    await db.batch(recent);
    const result = await runSelfReview(deps());
    expect(result.skipped.join(" ")).toContain("measurement health blocks");
    expect((await pendingProposals(db)).some((p) => p.kind === "template_weight")).toBe(false);
  });
});
