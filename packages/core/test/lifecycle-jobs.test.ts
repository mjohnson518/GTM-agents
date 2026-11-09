// GTM-agents: the lifecycle's jobs: each registered with its flag, schedule and ceilings; the
// stalled and dormant checks; the daily MRR snapshot; and product outcomes in the scorecard once
// product events exist. Every person and company is invented, on *.example domains.
import { beforeEach, describe, expect, it } from "vitest";
import { createJobRegistry } from "../src/jobs/registry.ts";
import { runLifecycleChecks, snapshotMrr } from "../src/lifecycle/checks.ts";
import { applyLifecycleEvent } from "../src/lifecycle/apply.ts";
import { countProductOutcomes, currentMrr, metricWindow } from "../src/metrics/index.ts";
import { flagReader } from "../src/outreach/testing.ts";
import { loadScorecard, renderScorecard } from "../src/reports/scorecard.ts";
import { count, db, firstTouch, lifecycleWorker, person, resetLifecycle, state, uid } from "./lifecycle-fixtures.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

beforeEach(resetLifecycle);

describe("the lifecycle jobs", () => {
  it("are registered with their flags (the sweep has none: erasures must route), schedules and ceilings, and none is unbounded", () => {
    const { lifecycle } = lifecycleWorker();
    const registry = createJobRegistry(lifecycle.jobs);
    const summary = registry.jobs.map((j) => ({ name: j.name, schedule: j.schedule, flag: j.flag, rows: j.ceilings.maxRows, ms: j.ceilings.maxDurationMs, rerunnable: j.rerunnable }));
    expect(summary).toEqual([
      { name: "event_sweep", schedule: "*/5 * * * *", flag: undefined, rows: 100, ms: 120_000, rerunnable: true },
      { name: "lifecycle_checks", schedule: "20 * * * *", flag: "lifecycle:enabled", rows: 400, ms: 120_000, rerunnable: true },
      { name: "lifecycle_reconcile", schedule: "15 3 * * *", flag: "lifecycle:reconcile_enabled", rows: 1800, ms: 600_000, rerunnable: true },
      { name: "mrr_snapshot", schedule: "55 23 * * *", flag: "lifecycle:enabled", rows: 1, ms: 30_000, rerunnable: true },
      { name: "event_retention", schedule: "50 3 * * *", flag: "lifecycle:enabled", rows: 500, ms: 120_000, rerunnable: true },
    ]);
  });
});

describe("the stalled and dormant checks", () => {
  it("stalls a sign-up with no value event after 72 hours, not before, and only once", async () => {
    const late = await person();
    const early = await person();
    await db.batch([
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, signed_up_at, state_changed_at) VALUES (?1, 'signed_up', ?2, ?2)").bind(late.id, hoursAgo(73)),
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, signed_up_at, state_changed_at) VALUES (?1, 'signed_up', ?2, ?2)").bind(early.id, hoursAgo(71)),
    ]);
    expect(await runLifecycleChecks({ db, now: NOW })).toEqual({ stalled: 1, dormant: 0, failed: 0 });
    expect((await state(late.id))?.state).toBe("stalled");
    expect((await state(early.id))?.state).toBe("signed_up");
    expect(await runLifecycleChecks({ db, now: NOW })).toEqual({ stalled: 0, dormant: 0, failed: 0 });
  });

  it("moves idle users after 14 days: active to stalled, paying to at risk; a billing-only customer is never dormant", async () => {
    const active = await person();
    const paying = await person();
    const billingOnly = await person();
    const recent = await person();
    await db.batch([
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, last_active_at, state_changed_at) VALUES (?1, 'activated', ?2, ?2)").bind(active.id, hoursAgo(15 * 24)),
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, last_active_at, state_changed_at) VALUES (?1, 'paying', ?2, ?2)").bind(paying.id, hoursAgo(20 * 24)),
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, last_active_at, state_changed_at) VALUES (?1, 'paying', NULL, ?2)").bind(billingOnly.id, hoursAgo(60 * 24)),
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, last_active_at, state_changed_at) VALUES (?1, 'paying', ?2, ?3)").bind(recent.id, hoursAgo(30 * 24), hoursAgo(2 * 24)),
    ]);
    expect(await runLifecycleChecks({ db, now: NOW })).toEqual({ stalled: 0, dormant: 2, failed: 0 });
    expect((await state(active.id))?.state).toBe("stalled");
    expect((await state(paying.id))?.state).toBe("at_risk");
    expect((await state(billingOnly.id))?.state).toBe("paying");
    expect((await state(recent.id))?.state).toBe("paying");
  });
});

describe("MRR", () => {
  it("sums paying, expanding and at-risk customers, one snapshot row per day, a rerun replacing it", async () => {
    const rows: Array<[string, number]> = [["paying", 4900], ["expanding", 19900], ["at_risk", 4900], ["churned", 4900], ["signed_up", 0]];
    for (const [s, mrr] of rows) {
      const p = await person();
      await db.prepare("INSERT INTO contact_lifecycle (contact_id, state, mrr_cents) VALUES (?1, ?2, ?3)").bind(p.id, s, mrr).run();
    }
    expect(await currentMrr(db)).toEqual({ mrrCents: 29700, paying: 3 });
    expect(await snapshotMrr(db, NOW)).toEqual({ date: "2026-11-04", mrrCents: 29700, paying: 3 });
    await db.prepare("UPDATE contact_lifecycle SET state = 'churned', mrr_cents = 0 WHERE state = 'at_risk'").run();
    await snapshotMrr(db, NOW);
    expect(await db.prepare("SELECT date, mrr_cents, paying FROM mrr_snapshots").all()).toMatchObject({ results: [{ date: "2026-11-04", mrr_cents: 24800, paying: 2 }] });
  });
});

describe("product outcomes", () => {
  it("count once per contact, from the bridge and billing only, crediting first touches", async () => {
    const credited = await person();
    const organic = await person();
    await firstTouch(credited.id, "2026-10-20T10:00:00.000Z", { templateId: "tpl-a" });
    const deps = { db, now: NOW };
    await applyLifecycleEvent(deps, credited.id, { kind: "signed_up" }, { eventKey: uid("k"), occurredAt: "2026-11-02T10:00:00.000Z", source: "product" });
    await applyLifecycleEvent(deps, credited.id, { kind: "subscribed" }, { eventKey: uid("k"), occurredAt: "2026-11-03T10:00:00.000Z", source: "billing" });
    await applyLifecycleEvent(deps, organic.id, { kind: "signed_up" }, { eventKey: uid("k"), occurredAt: "2026-11-02T11:00:00.000Z", source: "product" });
    await applyLifecycleEvent(deps, organic.id, { kind: "activated" }, { eventKey: uid("k"), occurredAt: "2026-11-02T12:00:00.000Z", source: "product" });
    await db.prepare("INSERT INTO funnel_events (id, event_type, source, occurred_at) VALUES ('fe_manual', 'signed_up', 'manual', '2026-11-02T13:00:00.000Z')").run();
    const window = metricWindow(new Date("2026-11-01T00:00:00.000Z"), new Date("2026-11-04T00:00:00.000Z"));
    expect(await countProductOutcomes(db, window)).toEqual({ signups: 2, activations: 1, newPaying: 1, fromOutreach: { signups: 1, activations: 0, newPaying: 1 } });
  });

  it("appear in the scorecard once product events exist, and say not measured yet before", async () => {
    const before = renderScorecard(await loadScorecard(db, flagReader({}), NOW));
    expect(before).toContain("Sign-ups, activations, new paying customers, meetings and quotas: not measured yet.");
    const p = await person();
    await db.prepare("INSERT INTO events (id, source, type, occurred_at, received_at, taint, routed_at) VALUES ('product:e1', 'product', 'user.signed_up', ?1, ?1, 'structured', ?1)").bind("2026-11-03T10:00:00.000Z").run();
    await applyLifecycleEvent({ db, now: NOW }, p.id, { kind: "signed_up" }, { eventKey: "product:e1", occurredAt: "2026-11-03T10:00:00.000Z", source: "product" });
    const after = renderScorecard(await loadScorecard(db, flagReader({}), NOW));
    expect(after).toContain("0 positive replies, 1 sign-up, 0 activations, 0 new paying customers. Meetings and quotas: not measured yet.");
    expect(after).toContain("Convert, 30 days: 1 sign-up (0 from outreach), 0 activations, 0 new paying customers (0 from outreach); meetings booked and held: not measured yet");
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE event_type = 'signed_up'")).toBe(1);
  });
});
