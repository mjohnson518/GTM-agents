// GTM-agents: tests for the cold batch's selection SQL and its pure picker. Every person, account and
// address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addSuppression } from "../src/sending/suppression.ts";
import { loadAccountState, pickContacts, selectCandidates, selectionWeeklyCap, type AccountUse, type PickOptions } from "../src/outreach/index.ts";
import { resetOutreachTables, seedContact } from "../src/outreach/testing.ts";

const NOW = new Date("2026-11-09T13:00:00.000Z");
const row = (email: string, extra: Partial<{ account_key: string | null; account_name: string; job_title: string }> = {}) => ({
  email,
  account_key: extra.account_key === undefined ? (email.split("@")[1] ?? null) : extra.account_key,
  account_name: extra.account_name ?? "Globex",
  job_title: extra.job_title ?? "Staff Engineer",
});
const opts = (patch: Partial<PickOptions> = {}): PickOptions => ({ limit: 10, weeklyCap: 3, perBatch: 1, live: new Set(), optedOut: new Set(), recent: [], ...patch });

describe("pickContacts", () => {
  it("needs a company account key that matches the address", () => {
    const result = pickContacts([row("a@globex.example"), row("b@gmail.com"), row("c@globex.example", { account_key: null }), row("d@initech.example", { account_key: "globex.example" })], opts());
    expect(result.picked.map((r) => r.email)).toEqual(["a@globex.example"]);
    expect(result.skipped.no_account_key).toBe(3);
  });

  it("applies the never list", () => {
    const result = pickContacts([row("a@initech.example"), row("b@globex.example", { job_title: "Recruiter" })], opts({ never: { domains: ["initech.example"], accounts: [], titles: ["recruiter"] } }));
    expect(result.picked).toHaveLength(0);
    expect(result.skipped.never_list).toBe(2);
  });

  it("blocks accounts in a live thread and accounts where anyone opted out", () => {
    const result = pickContacts([row("a@live.example"), row("b@optout.example"), row("c@globex.example")], opts({ live: new Set(["live.example"]), optedOut: new Set(["optout.example"]) }));
    expect(result.picked.map((r) => r.email)).toEqual(["c@globex.example"]);
    expect(result.skipped).toMatchObject({ live_thread: 1, account_opt_out: 1 });
  });

  it("stops one short of the weekly account cap and takes one contact per account per batch", () => {
    const recent: AccountUse[] = [
      { account_key: "busy.example", today: false },
      { account_key: "busy.example", today: false },
      { account_key: "today.example", today: true },
    ];
    const result = pickContacts([row("a@busy.example"), row("b@today.example"), row("c@globex.example"), row("d@globex.example")], opts({ recent }));
    expect(selectionWeeklyCap(3)).toBe(2);
    expect(result.picked.map((r) => r.email)).toEqual(["c@globex.example"]);
    expect(result.skipped).toMatchObject({ account_weekly_cap: 1, account_batch: 2 });
  });

  it("stops at the limit", () => {
    expect(pickContacts([row("a@one.example"), row("b@two.example"), row("c@three.example")], opts({ limit: 2 })).picked).toHaveLength(2);
  });
});

describe("selectCandidates and loadAccountState", () => {
  beforeEach(async () => {
    await resetOutreachTables(env.DB);
  });

  it("returns only cold, never-contacted, keep-fit, verified contacts with nothing open", async () => {
    const ok = await seedContact(env.DB, { first: "Jane", email: "jane@globex.example" });
    await seedContact(env.DB, { first: "Warm", email: "warm@warm.example", warmth: "contacted" });
    await seedContact(env.DB, { first: "Maybe", email: "maybe@maybe.example", fit: "maybe" });
    await seedContact(env.DB, { first: "Nofit", email: "nofit@nofit.example", fit: null });
    await seedContact(env.DB, { first: "Low", email: "low@low.example", confidence: "low" });
    await seedContact(env.DB, { first: "Risky", email: "risky@risky.example", verification: "risky" });
    const suppressed = await seedContact(env.DB, { first: "Sup", email: "sup@sup.example" });
    await addSuppression(env.DB, { email: "sup@sup.example", reason: "bounce", source: "test" });
    const held = await seedContact(env.DB, { first: "Held", email: "held@held.example" });
    await env.DB.prepare("INSERT INTO outreach_holdout (contact_id, cohort, held_at) VALUES (?1, 'x', ?2)").bind(held, "2026-11-01T00:00:00.000Z").run();
    const moved = await seedContact(env.DB, { first: "Moved", email: "moved@moved.example" });
    await env.DB.prepare("UPDATE contacts SET employment_status = 'moved' WHERE id = ?1").bind(moved).run();
    const conflict = await seedContact(env.DB, { first: "Conflict", email: "conflict@conflict.example" });
    await env.DB.prepare("INSERT INTO contact_evidence (id, contact_id, field, value, provider, fetched_at, conflict, retention_until) VALUES ('ev1', ?1, 'email', 'x', 'p', ?2, 1, ?2)").bind(conflict, "2026-11-01T00:00:00.000Z").run();
    const drafted = await seedContact(env.DB, { first: "Drafted", email: "drafted@drafted.example" });
    await env.DB.prepare("INSERT INTO drafts (id, contact_id, kind, status, created_at) VALUES ('dr_open', ?1, 'cold_intro', 'pending_approval', ?2)").bind(drafted, "2026-11-05T00:00:00.000Z").run();
    const lowFit = await seedContact(env.DB, { first: "Lowfit", email: "lowfit@lowfit.example" });
    await env.DB.prepare("INSERT INTO account_fit (account_key, prescore, status, fit_score) VALUES ('lowfit.example', 10, 'scored', 3)").run();
    const sent = await seedContact(env.DB, { first: "Sent", email: "sent@sent.example" });
    await env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sent_at) VALUES ('os1', ?1, 'cold', 'p', ?2)").bind(sent, "2026-10-01T00:00:00.000Z").run();

    const rows = await selectCandidates(env.DB, { limit: 50, offset: 0, floor: "medium", now: NOW });
    expect(rows.map((r) => r.id)).toEqual([ok]);
    expect(rows.map((r) => r.id)).not.toContain(suppressed);
    expect(rows.map((r) => r.id)).not.toContain(lowFit);
    const withLow = await selectCandidates(env.DB, { limit: 50, offset: 0, floor: "low", now: NOW });
    // The floor widens email confidence only: a risky address is never selected, because the send
    // function refuses cold mail to anything but a deliverable one.
    expect(withLow.map((r) => r.email).sort()).toEqual(["jane@globex.example", "low@low.example"]);
  });

  it("orders by account fit, then age", async () => {
    await seedContact(env.DB, { first: "Old", email: "old@plain.example", createdAt: "2026-10-01T00:00:00.000Z" });
    await seedContact(env.DB, { first: "Fit", email: "fit@fit.example", createdAt: "2026-11-01T00:00:00.000Z" });
    await env.DB.prepare("INSERT INTO account_fit (account_key, prescore, status, fit_score) VALUES ('fit.example', 50, 'scored', 9)").run();
    const rows = await selectCandidates(env.DB, { limit: 10, offset: 0, floor: "medium", now: NOW });
    expect(rows.map((r) => r.email)).toEqual(["fit@fit.example", "old@plain.example"]);
  });

  it("finds live threads, opted-out accounts and weekly use", async () => {
    await seedContact(env.DB, { first: "Warm", email: "warm@live.example", warmth: "engaged" });
    const decline = await seedContact(env.DB, { first: "Dec", email: "dec@declined.example" });
    await env.DB.prepare("UPDATE contacts SET declined_at = ?2 WHERE id = ?1").bind(decline, "2026-10-20T00:00:00.000Z").run();
    await env.DB.prepare("INSERT INTO deals (id, account_key, name, stage) VALUES ('deal1', 'deal.example', 'Deal', 'demo_scheduled')").run();
    await env.DB.prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification) VALUES ('in1', 'p', 'm1', 'someone@replied.example', ?1, 'reply')").bind("2026-11-01T00:00:00.000Z").run();
    await seedContact(env.DB, { first: "Out", email: "out@optout.example", warmth: "opted_out" });
    await addSuppression(env.DB, { email: "angry@complained.example", reason: "complaint", source: "test" });
    await env.DB.prepare("INSERT INTO outreach_sends (id, account_key, send_path, provider, sent_at) VALUES ('os2', 'busy.example', 'cold', 'p', ?1)").bind("2026-11-09T09:00:00.000Z").run();
    const state = await loadAccountState(env.DB, NOW);
    expect([...state.live].sort()).toEqual(["deal.example", "declined.example", "live.example", "replied.example"]);
    expect([...state.optedOut].sort()).toEqual(["complained.example", "optout.example"]);
    expect(state.recent).toEqual([{ account_key: "busy.example", today: true }]);
  });
});
