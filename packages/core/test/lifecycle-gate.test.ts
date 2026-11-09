// GTM-agents: the lifecycle milestone's gate: sign-ups and payments move contacts and deals.
//
// A prospect the cold batch wrote to, with a sequence still running and a deal from a booked
// meeting, signs up in the product: the host emits user.signed_up with the SDK (signed, one attempt).
// Then the billing provider reports a paid subscription (a fake provider behind the BillingProvider
// port). The contact must move to signed_up then paying, their cold outreach must stop, the deal
// must step to trial then closed_won one stage at a time, MRR must count them, and the scorecard
// must report one sign-up and one new paying customer credited to outreach. Every event is then
// redelivered, and nothing moves twice. Every person and company is invented.
import { beforeAll, describe, expect, it } from "vitest";
import { billingSubscribed, createProductEmitter, userSignedUp } from "../../sdk/src/index.ts";
import { fakeBillingProvider, fakeBillingWebhook } from "../src/billing/testing.ts";
import { ensureDemoDeal } from "../src/convert/booked.ts";
import type { RegisteredJob } from "../src/jobs/registry.ts";
import type { Env } from "../src/env.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { loadScorecard, renderScorecard } from "../src/reports/scorecard.ts";
import { BILLING_SECRET, PUSH_SECRET, urlOf, call, coldOutreach, count, db, dealsOf, firstTouch, lifecycleWorker, person, resetLifecycle, state, testEnv, type Person } from "./lifecycle-fixtures.ts";

const provider = fakeBillingProvider({ webhookSecret: BILLING_SECRET });
const { worker, lifecycle } = lifecycleWorker({ billing: () => provider });
const bindings = testEnv();
const emitter = createProductEmitter({
  url: "https://agent.acme.example/api/webhooks/product",
  secret: PUSH_SECRET,
  fetch: async (input, init) => call(worker, new Request(urlOf(input), init), bindings),
});

let ada: Person;
let dealId: string;
const signup = userSignedUp({ user: { id: "usr_ada", email: "Ada@Globex.example", name: "Ada Lovelace", role: "owner" }, org: { id: "org_globex", name: "Globex", domain: "globex.example", plan_tier: "free" }, data: { plan: "free", source: "email" } });
const paid = { type: "subscription_created" as const, customerId: "cus_ada", subscriptionId: "sub_ada", status: "active", email: "ada@globex.example", plan: "pro", amount: 4900, interval: "month" as const, at: new Date().toISOString(), providerEventId: "bevt_paid" };

beforeAll(async () => {
  await resetLifecycle();
  ada = await person({ email: "ada@globex.example", warmth: "hot" });
  const { campaignId } = await coldOutreach(ada.id);
  await firstTouch(ada.id, new Date(Date.now() - 20 * 86_400_000).toISOString(), { campaignId, templateId: "tpl-intro" });
  dealId = await ensureDemoDeal(db, { id: ada.id, account_key: ada.accountKey }, "mggggggggggg", new Date());
});

describe("sign-ups and payments move contacts and deals", () => {
  it("a sign-up moves the contact to signed_up, stops their cold outreach and steps their deal to trial", async () => {
    expect(await emitter.emit(signup)).toEqual({ sent: true, status: 200, duplicate: false });
    expect(await state(ada.id)).toMatchObject({ state: "signed_up", product_user_id: "usr_ada", attribution_method: "email" });
    expect(await db.prepare("SELECT sequence_active, status FROM campaign_contacts WHERE contact_id = ?1").bind(ada.id).first()).toEqual({ sequence_active: 0, status: "converted" });
    expect(await count("SELECT COUNT(*) AS n FROM deferred_sends WHERE contact_id = ?1 AND status = 'queued'", ada.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM drafts WHERE contact_id = ?1 AND status IN ('draft', 'pending_approval', 'approved')", ada.id)).toBe(0);
    expect(await dealsOf(ada.id)).toEqual([{ id: dealId, stage: "trial", loss_reason: null }]);
  });

  it("a payment moves the contact to paying, closes the deal won one stage at a time, and counts in MRR", async () => {
    const response = await call(worker, await fakeBillingWebhook(paid, { secret: BILLING_SECRET }), bindings);
    expect(response.status).toBe(200);
    expect(await state(ada.id)).toMatchObject({ state: "paying", mrr_cents: 4900, plan_tier: "pro", subscription_status: "active" });
    expect(await dealsOf(ada.id)).toEqual([{ id: dealId, stage: "closed_won", loss_reason: null }]);
    const stages = await db.prepare("SELECT to_stage FROM deal_stage_history WHERE deal_id = ?1 ORDER BY created_at, rowid").bind(dealId).all<{ to_stage: string }>();
    // The booked meeting took the deal to demo_scheduled; from there the lifecycle steps it through every stage.
    expect(stages.results.map((r) => r.to_stage)).toEqual(["demo_scheduled", "trial", "proposal", "negotiation", "closed_won"]);
    const snapshot = lifecycle.jobs.find((j) => j.name === "mrr_snapshot") as RegisteredJob<Env>;
    const now = new Date();
    await snapshot.run({ env: bindings, config: (await import("./lifecycle-fixtures.ts")).config, job: snapshot.name, now, signal: new AbortController().signal, ceilings: snapshot.ceilings, flags: flagReader({}), log: silentLogger });
    expect(await db.prepare("SELECT mrr_cents, paying FROM mrr_snapshots WHERE date = ?1").bind(now.toISOString().slice(0, 10)).first()).toEqual({ mrr_cents: 4900, paying: 1 });
  });

  it("the scorecard reports the sign-up and the new paying customer, credited to outreach", async () => {
    const text = renderScorecard(await loadScorecard(db, flagReader({}), new Date(Date.now() + 86_400_000)));
    expect(text).toMatch(/1 sign-up \(1 from outreach\), 0 activations, 1 new paying customer \(1 from outreach\)/);
  });

  it("redelivering every event moves nothing twice", async () => {
    const transitions = await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id);
    const history = await count("SELECT COUNT(*) AS n FROM deal_stage_history WHERE deal_id = ?1", dealId);
    expect(await emitter.emit(signup)).toEqual({ sent: true, status: 200, duplicate: true });
    expect(await (await call(worker, await fakeBillingWebhook(paid, { secret: BILLING_SECRET }), bindings)).json()).toEqual({ ok: true, duplicate: true });
    // The same subscription under a new event id is not a new payment either.
    await call(worker, await fakeBillingWebhook({ ...paid, providerEventId: "bevt_paid_again", type: "subscription_updated" }, { secret: BILLING_SECRET }), bindings);
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id)).toBe(transitions);
    expect(await count("SELECT COUNT(*) AS n FROM deal_stage_history WHERE deal_id = ?1", dealId)).toBe(history);
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type IN ('signed_up', 'subscribed')", ada.id)).toBe(2);
    expect(await dealsOf(ada.id)).toHaveLength(1);
    expect(billingSubscribed).toBeTypeOf("function");
  });
});
