// GTM-agents: the lifecycle writer: compare-and-set, once per cause, set-once fields, first-time
// timestamps, and the side effects (cold outreach stopped, the deal mirror, funnel events with
// first-touch and experiment credit, warmth, erasure), each run once even when a cause is routed
// again. Every person and company is invented, on *.example domains.
import { beforeEach, describe, expect, it } from "vitest";
import { ensureDemoDeal } from "../src/convert/booked.ts";
import { applyLifecycleEvent, recordMeetingBooked } from "../src/lifecycle/apply.ts";
import { mirrorDeal } from "../src/lifecycle/effects.ts";
import { coldOutreach, count, db, dealsOf, failingDb, firstTouch, person, resetLifecycle, state, uid } from "./lifecycle-fixtures.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const deps = { db, now: NOW };
const at = (iso: string) => ({ occurredAt: iso, source: "product" as const });

beforeEach(resetLifecycle);

describe("applyLifecycleEvent", () => {
  it("signs a prospect up: state, transition, first-time timestamp, outreach stopped, deal to trial, warmth, funnel", async () => {
    const ada = await person({ warmth: "contacted" });
    const { campaignId } = await coldOutreach(ada.id);
    await db.prepare("INSERT INTO experiments (id, name, hypothesis, variable, primary_metric) VALUES ('exp_subject', 'Subject', 'Short wins', 'subject', 'signed_up')").run();
    const send = await firstTouch(ada.id, "2026-10-20T10:00:00.000Z", { campaignId, templateId: "tpl-intro", experiment: { id: "exp_subject", arm: "treatment" } });

    const result = await applyLifecycleEvent(deps, ada.id, { kind: "signed_up" }, { eventKey: "product:evt_1", ...at("2026-11-01T09:00:00.000Z"), patch: { product_user_id: "usr_ada", attribution_method: "email", attributed_campaign_id: campaignId, signup_ref: "ref_spring" } });
    expect(result).toMatchObject({ applied: true, from: null, to: "signed_up", effectsFailed: [] });
    expect(await state(ada.id)).toMatchObject({ state: "signed_up", product_user_id: "usr_ada", attribution_method: "email", signup_ref: "ref_spring", signed_up_at: "2026-11-01T09:00:00.000Z" });
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1 AND to_state = 'signed_up' AND event_id = 'product:evt_1'", ada.id)).toBe(1);

    expect(await db.prepare("SELECT sequence_active, status FROM campaign_contacts WHERE contact_id = ?1").bind(ada.id).first()).toEqual({ sequence_active: 0, status: "converted" });
    expect(await count("SELECT COUNT(*) AS n FROM deferred_sends WHERE contact_id = ?1 AND status = 'cancelled'", ada.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM drafts WHERE contact_id = ?1 AND status = 'rejected'", ada.id)).toBe(1);

    const [deal] = await dealsOf(ada.id);
    expect(deal?.stage).toBe("trial");
    const history = await db.prepare("SELECT from_stage, to_stage FROM deal_stage_history WHERE deal_id = ?1 ORDER BY created_at, rowid").bind(deal?.id).all();
    expect(history.results).toEqual([
      { from_stage: "prospecting", to_stage: "contacted" },
      { from_stage: "contacted", to_stage: "engaged" },
      { from_stage: "engaged", to_stage: "demo_scheduled" },
      { from_stage: "demo_scheduled", to_stage: "trial" },
    ]);
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(ada.id).first<{ warmth: string }>())?.warmth).toBe("hot");

    const funnel = await db.prepare("SELECT event_type, source, campaign_id, experiment_id, metadata, occurred_at FROM funnel_events WHERE contact_id = ?1").bind(ada.id).first<Record<string, string>>();
    expect(funnel).toMatchObject({ event_type: "signed_up", source: "product", campaign_id: campaignId, experiment_id: "exp_subject", occurred_at: "2026-11-01T09:00:00.000Z" });
    expect(JSON.parse(funnel?.metadata ?? "{}")).toEqual({ first_touch: send, template_id: "tpl-intro", arm: "treatment", attribution: "email" });
  });

  it("keeps attribution, the product user and the first-time timestamps as first written", async () => {
    const ada = await person();
    await applyLifecycleEvent(deps, ada.id, { kind: "signed_up" }, { eventKey: "k1", ...at("2026-11-01T09:00:00.000Z"), patch: { product_user_id: "usr_1", attribution_method: "ref_token", attributed_campaign_id: "cmp_a", signup_ref: "ref_a" } });
    await applyLifecycleEvent(deps, ada.id, null, { eventKey: "k2", ...at("2026-11-02T09:00:00.000Z"), patch: { product_user_id: "usr_2", attribution_method: "email", attributed_campaign_id: "cmp_b", signup_ref: "ref_b", plan_tier: "pro", last_active_at: "2026-11-02T09:00:00.000Z" } });
    await applyLifecycleEvent(deps, ada.id, null, { eventKey: "k3", ...at("2026-11-01T10:00:00.000Z"), patch: { last_active_at: "2026-11-01T10:00:00.000Z", usage: { limit_used: 3 } } });
    expect(await state(ada.id)).toMatchObject({ product_user_id: "usr_1", attribution_method: "ref_token", attributed_campaign_id: "cmp_a", signup_ref: "ref_a", plan_tier: "pro", last_active_at: "2026-11-02T09:00:00.000Z", signed_up_at: "2026-11-01T09:00:00.000Z" });
    expect(JSON.parse(String((await state(ada.id))?.usage))).toEqual({ limit_used: 3 });
    // A second activation after a stall is not a new first activation.
    await applyLifecycleEvent(deps, ada.id, { kind: "activated" }, { eventKey: "k4", ...at("2026-11-03T09:00:00.000Z") });
    await applyLifecycleEvent(deps, ada.id, { kind: "dormant" }, { eventKey: "k5", ...at("2026-11-20T09:00:00.000Z") });
    await applyLifecycleEvent(deps, ada.id, { kind: "activated" }, { eventKey: "k6", ...at("2026-11-21T09:00:00.000Z") });
    expect((await state(ada.id))?.activated_at).toBe("2026-11-03T09:00:00.000Z");
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'activated'", ada.id)).toBe(1);
  });

  it("applies a cause once, even when it comes back after the state moved on", async () => {
    const ada = await person();
    await applyLifecycleEvent(deps, ada.id, { kind: "signed_up" }, { eventKey: "e-signup", ...at("2026-11-01T09:00:00.000Z") });
    await applyLifecycleEvent(deps, ada.id, { kind: "subscribed" }, { eventKey: "e-sub", ...at("2026-11-02T09:00:00.000Z"), patch: { mrr_cents: 4900 } });
    await applyLifecycleEvent(deps, ada.id, { kind: "payment_failed" }, { eventKey: "e-fail", ...at("2026-11-03T09:00:00.000Z") });
    // The subscription event, redelivered: at_risk would move to paying, but the cause was applied.
    const again = await applyLifecycleEvent(deps, ada.id, { kind: "subscribed" }, { eventKey: "e-sub", ...at("2026-11-02T09:00:00.000Z"), patch: { mrr_cents: 9900 } });
    expect(again).toMatchObject({ applied: false, reason: "already_applied" });
    expect(await state(ada.id)).toMatchObject({ state: "at_risk", mrr_cents: 4900 });
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id)).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'subscribed'", ada.id)).toBe(1);
    expect(await dealsOf(ada.id)).toHaveLength(1);
  });

  it("serializes racing writers: every move lands once and the state ends where the table says", async () => {
    const ada = await person();
    await applyLifecycleEvent(deps, ada.id, { kind: "signed_up" }, { eventKey: "r0", ...at("2026-11-01T09:00:00.000Z") });
    const results = await Promise.all([
      applyLifecycleEvent(deps, ada.id, { kind: "activated" }, { eventKey: "r1", ...at("2026-11-02T09:00:00.000Z") }),
      applyLifecycleEvent(deps, ada.id, { kind: "activated" }, { eventKey: "r2", ...at("2026-11-02T09:00:01.000Z") }),
      applyLifecycleEvent(deps, ada.id, { kind: "limit_reached" }, { eventKey: "r3", ...at("2026-11-02T09:00:02.000Z") }),
    ]);
    const moves = results.filter((r) => r.applied && r.to).length;
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id)).toBe(1 + moves);
    expect(["at_wall", "activated"]).toContain((await state(ada.id))?.state);
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'activated'", ada.id)).toBeLessThanOrEqual(1);
  });

  it("retries only the side effect that failed when the same cause comes back", async () => {
    const ada = await person();
    const broken = failingDb(db, /INSERT INTO funnel_events/);
    const first = await applyLifecycleEvent({ db: broken.db, now: NOW }, ada.id, { kind: "signed_up" }, { eventKey: "f1", ...at("2026-11-01T09:00:00.000Z") });
    expect(first).toMatchObject({ applied: true, to: "signed_up", effectsFailed: ["funnel"] });
    const historyBefore = await count("SELECT COUNT(*) AS n FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id WHERE d.contact_id = ?1", ada.id);
    broken.fail.on = false;
    const retry = await applyLifecycleEvent({ db: broken.db, now: NOW }, ada.id, { kind: "signed_up" }, { eventKey: "f1", ...at("2026-11-01T09:00:00.000Z") });
    expect(retry).toMatchObject({ applied: false, reason: "already_applied", effectsFailed: [] });
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1", ada.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id WHERE d.contact_id = ?1", ada.id)).toBe(historyBefore);
    expect(await dealsOf(ada.id)).toHaveLength(1);
  });

  it("never lowers warmth and never leaves a terminal warmth", async () => {
    const customer = await person({ warmth: "customer" });
    await applyLifecycleEvent(deps, customer.id, { kind: "signed_up" }, { eventKey: "w1", ...at("2026-11-01T09:00:00.000Z") });
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(customer.id).first<{ warmth: string }>())?.warmth).toBe("customer");
    const opted = await person({ warmth: "opted_out" });
    await applyLifecycleEvent(deps, opted.id, { kind: "subscribed" }, { eventKey: "w2", ...at("2026-11-01T09:00:00.000Z") });
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(opted.id).first<{ warmth: string }>())?.warmth).toBe("opted_out");
  });

  it("erases a contact that moves to deleted, after stopping their outreach", async () => {
    const ada = await person();
    await coldOutreach(ada.id);
    const result = await applyLifecycleEvent(deps, ada.id, { kind: "user_deleted" }, { eventKey: "d1", ...at("2026-11-01T09:00:00.000Z"), erasure: { source: "product", productUserId: "usr_gone" } });
    expect(result.effectsFailed).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1", ada.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM erasure_tombstones WHERE product_user_id = 'usr_gone'")).toBe(1);
  });
});

describe("the deal mirror", () => {
  it("steps an existing deal forward and never back", async () => {
    const ada = await person();
    const dealId = await ensureDemoDeal(db, { id: ada.id, account_key: ada.accountKey }, "mgaaaaaaaaaa", NOW);
    await db.prepare("UPDATE deals SET stage = 'negotiation' WHERE id = ?1").bind(dealId).run();
    expect(await mirrorDeal(db, ada.id, "at_wall", { now: NOW })).toBe("deal at negotiation");
    expect(await mirrorDeal(db, ada.id, "paying", { now: NOW })).toBe("deal at closed_won");
    expect(await dealsOf(ada.id)).toEqual([{ id: dealId, stage: "closed_won", loss_reason: null }]);
  });

  it("never opens a second deal for someone already won, and a churn closes no won deal", async () => {
    const ada = await person();
    await applyLifecycleEvent(deps, ada.id, { kind: "subscribed" }, { eventKey: "m1", ...at("2026-11-01T09:00:00.000Z") });
    await applyLifecycleEvent(deps, ada.id, { kind: "canceled" }, { eventKey: "m2", ...at("2026-11-02T09:00:00.000Z"), reason: "too_expensive" });
    await applyLifecycleEvent(deps, ada.id, { kind: "subscribed" }, { eventKey: "m3", ...at("2026-11-03T09:00:00.000Z") });
    const deals = await dealsOf(ada.id);
    expect(deals.map((d) => d.stage)).toEqual(["closed_won"]);
    // A returning customer is not a new paying customer.
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'subscribed'", ada.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'churned'", ada.id)).toBe(1);
  });

  it("closes an open deal lost on churn, with the churned reason", async () => {
    const ada = await person();
    const dealId = await ensureDemoDeal(db, { id: ada.id, account_key: ada.accountKey }, "mgbbbbbbbbbb", NOW);
    await db.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'at_risk')").bind(ada.id).run();
    await applyLifecycleEvent(deps, ada.id, { kind: "canceled" }, { eventKey: "c1", ...at("2026-11-01T09:00:00.000Z"), reason: "unused" });
    expect(await dealsOf(ada.id)).toEqual([{ id: dealId, stage: "closed_lost", loss_reason: "churned" }]);
    expect((await db.prepare("SELECT reason FROM deal_stage_history WHERE deal_id = ?1 AND to_stage = 'closed_lost'").bind(dealId).first<{ reason: string }>())?.reason).toBe("lifecycle churned (unused)");
  });

  it("leaves one open deal when a booked meeting and a sign-up race to create it", async () => {
    for (let i = 0; i < 5; i++) {
      const ada = await person();
      await Promise.all([ensureDemoDeal(db, { id: ada.id, account_key: null }, `mg${String(i).padStart(10, "e")}`, NOW), mirrorDeal(db, ada.id, "signed_up", { now: NOW })]);
      const open = (await dealsOf(ada.id)).filter((d) => d.stage !== "closed_won" && d.stage !== "closed_lost");
      expect(open).toHaveLength(1);
      expect(open[0]?.stage).toBe("trial");
    }
  });

  it("creates one deal when two transitions race to create it", async () => {
    const ada = await person();
    await Promise.all([mirrorDeal(db, ada.id, "signed_up", { now: NOW }), mirrorDeal(db, ada.id, "at_wall", { now: NOW }), mirrorDeal(db, ada.id, "signed_up", { now: NOW })]);
    expect(await dealsOf(ada.id)).toHaveLength(1);
  });
});

describe("a booked meeting (convert)", () => {
  it("moves the booked prospect to engaged through the lifecycle, once", async () => {
    const { applyBooked } = await import("../src/convert/booked.ts");
    const { config } = await import("./lifecycle-fixtures.ts");
    const { silentLogger } = await import("../src/outreach/testing.ts");
    const ada = await person({ warmth: "contacted" });
    const meeting = { event_id: uid("evt"), code: "mgdddddddddd", contact_id: ada.id, starts_at: "2026-11-10T15:00:00.000Z", ends_at: "2026-11-10T15:30:00.000Z", status: "confirmed", attribution: "accepted_contact", first_seen_at: "2026-11-04T11:00:00.000Z" };
    const bookedDeps = { db, config, now: NOW, log: silentLogger, quiet: true };
    const result = await applyBooked(bookedDeps, meeting);
    expect(result.failed).toEqual([]);
    await applyBooked(bookedDeps, meeting);
    expect((await state(ada.id))?.state).toBe("engaged");
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1 AND event_id = ?2", ada.id, `calendar:mgdddddddddd:${ada.id}`)).toBe(1);
  });
});

describe("recordMeetingBooked", () => {
  it("moves prospects to engaged once, and leaves product users and opted-out prospects alone", async () => {
    const prospect = await person();
    const user = await person();
    const opted = await person();
    await db.batch([
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'activated')").bind(user.id),
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'opted_out')").bind(opted.id),
    ]);
    const meetings = [prospect, user, opted].map((p) => ({ contactId: p.id, key: `calendar:mgcccccccccc:${p.id}`, at: "2026-11-01T09:00:00.000Z" }));
    await recordMeetingBooked(deps, meetings);
    await recordMeetingBooked(deps, meetings);
    expect((await state(prospect.id))?.state).toBe("engaged");
    expect((await state(user.id))?.state).toBe("activated");
    expect((await state(opted.id))?.state).toBe("opted_out");
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE event_id LIKE 'calendar:mgcccccccccc:%'")).toBe(1);
    expect(await dealsOf(prospect.id)).toHaveLength(0);
    expect(uid("x")).toBeTruthy();
  });
});
