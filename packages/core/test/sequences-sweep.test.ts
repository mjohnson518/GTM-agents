// GTM-agents: tests for the follow-up sweep: threading under the first email, scheduling and
// finishing a sequence, the ledger reconciling a row, ends, exhaustion, template problems, the
// reviewer, per-contact pauses, deferrals that stay off the deferred queue, and the kill switch.
// Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { fakeJudge, flagReader, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "../src/outreach/testing.ts";
import type { OutreachSenderDeps } from "../src/sending/boundary.ts";
import { COLD_PAUSE_CRITICAL_KEY } from "../src/sending/kill-switch.ts";
import type { FakeEmailProvider } from "../src/sending/testing.ts";
import { createSequenceSender } from "../src/sequences/sender.ts";
import { runFollowUpSweep, type SweepDeps } from "../src/sequences/sweep.ts";
import { ACME_SEQUENCE_TEMPLATES, resetSequenceTables, seedFirstTouch, sequenceTemplate, withMessageIds } from "../src/sequences/testing.ts";
import type { TemplateFile } from "../src/templates/store.ts";
import { acmeConfig } from "./fixtures.ts";
import { harness, NOW } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const CAMPAIGN = "cb20261101";
const config = defineConfig({
  ...acmeConfig,
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } },
});
const AUTO = { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" };

interface World {
  provider: FakeEmailProvider & ReturnType<typeof withMessageIds>;
  senderDeps: OutreachSenderDeps;
  operator: ReturnType<typeof harness>["operator"];
  contactId: string;
}

async function world(options: { templates?: TemplateFile[]; contact?: Parameters<typeof seedContact>[1]; firstSentAt?: Date } = {}): Promise<World> {
  await resetSequenceTables(db);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, options.templates ?? [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
  const h = harness(db, { config });
  const provider = withMessageIds(h.provider);
  const contactId = await seedContact(db, options.contact ?? { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
  await seedFirstTouch(db, { campaignId: CAMPAIGN, contactId, provider: provider.name, sentAt: options.firstSentAt ?? new Date(NOW.getTime() - 3 * DAY - 3_600_000) });
  return { provider, senderDeps: h.deps, operator: h.operator, contactId };
}

function deps(w: World, flags: Record<string, string> = AUTO, extra: Partial<SweepDeps> = {}, now: Date = NOW): SweepDeps {
  return {
    db,
    kv: env.KV,
    flags: flagReader(flags),
    config,
    now,
    job: "sequence_sweep",
    log: silentLogger,
    send: createSequenceSender({ ...w.senderDeps, now: () => now }),
    provider: w.provider,
    model: fakeJudge(),
    operator: w.operator.channel,
    ...extra,
  };
}

const row = (contactId: string) =>
  db
    .prepare("SELECT status, sequence_step, sequence_active, next_send_at, sequence_paused_at, sequence_pause_reason FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2")
    .bind(CAMPAIGN, contactId)
    .first<{ status: string; sequence_step: number; sequence_active: number; next_send_at: string | null; sequence_paused_at: string | null; sequence_pause_reason: string | null }>();

const count = async (sql: string, ...binds: unknown[]) => Number((await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);

describe("the follow-up sweep, threading and scheduling", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("sends step 2 threaded under the first email, with the first email's subject", async () => {
    const result = await runFollowUpSweep(deps(w));
    expect(result.sent).toBe(1);
    const [message] = w.provider.messages();
    const firstId = `<pm-${w.contactId}-1@mail.fake.example>`;
    expect(message?.subject).toBe("Re: Flaky builds at Globex Corporation");
    expect(message?.headers["In-Reply-To"]).toBe(firstId);
    expect(message?.headers.References).toBe(firstId);
    expect(message?.tags.send_path).toBe("sequence");
    expect(message?.effectKey).toBe(`seq:${CAMPAIGN}:${w.contactId}:2`);
    expect(message?.text).toMatch(/^Hi Jane,/);
    // The Message-ID is stored on the ledger, so it is looked up once.
    expect((await db.prepare("SELECT message_id FROM outreach_sends WHERE sequence_step = 1").first<{ message_id: string }>())?.message_id).toBe(firstId);
    expect(await row(w.contactId)).toMatchObject({ sequence_step: 2, sequence_active: 1, next_send_at: new Date(NOW.getTime() + 7 * DAY).toISOString() });
    expect(await count("SELECT COUNT(*) AS n FROM drafts WHERE kind = 'follow_up' AND status = 'sent' AND idempotency_key = ?1", `seq:${CAMPAIGN}:${w.contactId}:2`)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outreach_sends WHERE send_path = 'sequence' AND sequence_step = 2")).toBe(1);
  });

  it("threads step 3 under both earlier steps and then finishes the sequence", async () => {
    await runFollowUpSweep(deps(w));
    const later = new Date(NOW.getTime() + 7 * DAY);
    const result = await runFollowUpSweep(deps(w, AUTO, {}, later));
    expect(result.sent).toBe(1);
    const messages = w.provider.messages();
    // The fake provider names its first accepted message fake-1: step 2.
    const step2Id = "<fake-1@mail.fake.example>";
    const third = messages[1];
    expect(third?.effectKey).toBe(`seq:${CAMPAIGN}:${w.contactId}:3`);
    expect(third?.subject).toBe("Re: Flaky builds at Globex Corporation");
    expect(third?.headers["In-Reply-To"]).toBe(step2Id);
    expect(third?.headers.References).toBe(`<pm-${w.contactId}-1@mail.fake.example> ${step2Id}`);
    expect(await row(w.contactId)).toMatchObject({ sequence_step: 3, sequence_active: 0, next_send_at: null, sequence_pause_reason: "exhausted" });
    // The first email's Message-ID was stored by the first sweep and not looked up again.
    expect(w.provider.lookups.calls.filter((id) => id === `pm-${w.contactId}-1`)).toHaveLength(1);
  });

  it("holds a step whose first Message-ID cannot be found, sends nothing unthreaded, and sends once it can", async () => {
    w.provider.lookups.answer = () => null;
    const held = await runFollowUpSweep(deps(w));
    expect(held.sent).toBe(0);
    expect(held.held).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    expect(await row(w.contactId)).toMatchObject({ sequence_step: 1, sequence_active: 1, sequence_paused_at: null, next_send_at: new Date(NOW.getTime() + 3 * 3_600_000).toISOString() });
    expect(await count("SELECT COUNT(*) AS n FROM drafts")).toBe(0);
    // A held row waits 3 hours, so it never crowds newer due rows out of the row ceiling.
    expect((await runFollowUpSweep(deps(w))).due).toBe(0);
    const later = new Date(NOW.getTime() + 3 * 3_600_000);
    w.provider.lookups.answer = () => new Error("provider unavailable");
    expect((await runFollowUpSweep(deps(w, AUTO, {}, later))).sent).toBe(0);
    w.provider.lookups.answer = (id) => `<${id}@mail.fake.example>`;
    // The next day, inside the recipient's send window.
    expect((await runFollowUpSweep(deps(w, AUTO, {}, new Date(NOW.getTime() + DAY)))).sent).toBe(1);
  });

  it("does nothing while sequences are off, and nothing while cold outreach is paused", async () => {
    expect((await runFollowUpSweep(deps(w, { ...AUTO, "sequences:enabled": "false" }))).status).toBe("skipped");
    await env.KV.put(COLD_PAUSE_CRITICAL_KEY, JSON.stringify({ reason: "test", source: "operator", since: NOW.toISOString() }));
    try {
      expect((await runFollowUpSweep(deps(w))).status).toBe("skipped");
    } finally {
      await env.KV.delete(COLD_PAUSE_CRITICAL_KEY);
    }
    expect(w.provider.messages()).toHaveLength(0);
  });

  it("keeps a step that must wait for the recipient's window due on its row, never in the deferred queue", async () => {
    await db.prepare("UPDATE contacts SET timezone = 'Asia/Tokyo' WHERE id = ?1").bind(w.contactId).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.deferred).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    const after = await row(w.contactId);
    expect(after?.sequence_step).toBe(1);
    expect(Date.parse(after?.next_send_at ?? "")).toBeGreaterThan(NOW.getTime());
    expect(await count("SELECT COUNT(*) AS n FROM deferred_sends")).toBe(0);
    // The approved draft waits and goes once the step is due again.
    expect(await count("SELECT COUNT(*) AS n FROM drafts WHERE status = 'approved'")).toBe(1);
  });

  it("moves a row on when the send ledger shows its step already went out", async () => {
    await db
      .prepare("INSERT INTO outreach_sends (id, contact_id, campaign_id, sequence_step, send_path, provider, sent_at) VALUES ('os-ahead', ?1, ?2, 2, 'sequence', 'p', ?3)")
      .bind(w.contactId, CAMPAIGN, new Date(NOW.getTime() - DAY).toISOString())
      .run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.reconciled).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    expect(await row(w.contactId)).toMatchObject({ sequence_step: 2, next_send_at: new Date(NOW.getTime() + 6 * DAY).toISOString() });
  });

  it("finishes a sequence whose next step is beyond the last one", async () => {
    await db.prepare("UPDATE campaign_contacts SET sequence_step = 3 WHERE contact_id = ?1").bind(w.contactId).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.exhausted).toBe(1);
    expect(await row(w.contactId)).toMatchObject({ sequence_active: 0, sequence_pause_reason: "exhausted" });
  });

  it("waits when the ledger says the step is not due yet", async () => {
    await db.prepare("UPDATE outreach_sends SET sent_at = ?2 WHERE contact_id = ?1").bind(w.contactId, new Date(NOW.getTime() - DAY).toISOString()).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.waiting).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    expect((await row(w.contactId))?.next_send_at).toBe(new Date(NOW.getTime() + 2 * DAY).toISOString());
  });

  it("treats a step already claimed by the send function as sent, and never sends it again", async () => {
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, 'email_send', ?2)").bind(`seq:${CAMPAIGN}:${w.contactId}:2`, NOW.toISOString()).run();
    const result = await runFollowUpSweep(deps(w));
    expect(w.provider.messages()).toHaveLength(0);
    expect(result.sent).toBe(1);
    expect((await row(w.contactId))?.sequence_step).toBe(2);
  });
});

describe("the follow-up sweep, ends and pauses", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it.each([
    ["person fit drops", "UPDATE contact_fit SET decision = 'drop' WHERE contact_id = ?1", /person fit/],
    ["a job move", "UPDATE contacts SET employment_status = 'moved' WHERE id = ?1", /moved jobs/],
    // The contact's own warmth puts the account in a live conversation, the account rule.
    ["warmth past contacted", "UPDATE contacts SET warmth = 'engaged' WHERE id = ?1", /in a conversation/],
    ["an opt-out", "INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'opted_out')", /opted out/],
  ])("ends the sequence when %s", async (_name, sql, reason) => {
    await db.prepare(sql).bind(w.contactId).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.ended).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    const after = await row(w.contactId);
    expect(after?.sequence_active).toBe(0);
    expect(after?.sequence_pause_reason).toMatch(reason);
  });

  it("ends the sequence when the address is suppressed", async () => {
    const hash = (await db.prepare("SELECT email_sha256 FROM contacts WHERE id = ?1").bind(w.contactId).first<{ email_sha256: string }>())?.email_sha256;
    await db.prepare("INSERT INTO suppression (email_sha256, email, reason, source) VALUES (?1, 'jane@globex.example', 'bounce', 'test')").bind(hash).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.ended).toBe(1);
    expect((await row(w.contactId))?.sequence_pause_reason).toMatch(/suppressed/);
  });

  it("pauses a contact whose draft does not pass the gate, and only that contact", async () => {
    await db.prepare("UPDATE contacts SET first_name = NULL WHERE id = ?1").bind(w.contactId).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.paused).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    const after = await row(w.contactId);
    expect(after?.sequence_active).toBe(1);
    expect(after?.sequence_paused_at).not.toBeNull();
    expect(after?.sequence_pause_reason).toMatch(/MISSING_VARIABLE/);
    expect(w.operator.messages.some((m) => m.text.includes(`sequence-resume-${w.contactId}`))).toBe(true);
    // A paused row is not due again until an operator resumes it.
    expect((await runFollowUpSweep(deps(w))).due).toBe(0);
  });

  it("pauses a row whose first email is not in the send ledger", async () => {
    await db.prepare("DELETE FROM outreach_sends WHERE contact_id = ?1").bind(w.contactId).run();
    const result = await runFollowUpSweep(deps(w));
    expect(result.paused).toBe(1);
    expect((await row(w.contactId))?.sequence_pause_reason).toMatch(/first email is not in the send ledger/);
  });
});

describe("the follow-up sweep, templates and the reviewer", () => {
  it("holds every row of a step with no template, keeps it due, and tells the operator once a day", async () => {
    const w = await world({ templates: [templateFile("cold-intro"), sequenceTemplate("breakup", { kind: "breakup" })] });
    const first = await runFollowUpSweep(deps(w));
    const second = await runFollowUpSweep(deps(w, AUTO, {}, new Date(NOW.getTime() + 3 * 3_600_000)));
    expect(first.held).toBe(1);
    expect(second.held).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    expect(await row(w.contactId)).toMatchObject({ sequence_step: 1, sequence_active: 1, sequence_paused_at: null });
    expect(w.operator.messages.filter((m) => m.text.includes("held by their templates"))).toHaveLength(1);
  });

  it("holds a step whose template fails the fixture render through the gate", async () => {
    const broken = sequenceTemplate("follow-up", { body: "Hi {{first_name}},\n\nA short follow-up on my note. {{company_context}} Would a short call help this week?\n\n{{sender_name}}" });
    const w = await world({ templates: [templateFile("cold-intro"), broken, sequenceTemplate("breakup", { kind: "breakup" })] });
    const result = await runFollowUpSweep(deps(w));
    expect(result.held).toBe(1);
    expect(result.paused).toBe(0);
    expect(w.operator.messages.some((m) => /company_context/.test(m.text))).toBe(true);
  });

  it("leaves the step due when the reviewer is unavailable, pausing and sending nothing", async () => {
    const w = await world();
    const result = await runFollowUpSweep(deps(w, AUTO, { model: fakeJudge({ failure: "throw" }) }));
    expect(result.held).toBe(1);
    expect(result.paused).toBe(0);
    expect(w.provider.messages()).toHaveLength(0);
    expect(await row(w.contactId)).toMatchObject({ sequence_step: 1, sequence_paused_at: null });
    expect(await count("SELECT COUNT(*) AS n FROM drafts")).toBe(0);
  });

  it("holds the step when the reviewer fails its template", async () => {
    const w = await world();
    const result = await runFollowUpSweep(deps(w, AUTO, { model: fakeJudge({ pass: false }) }));
    expect(result.held).toBe(1);
    expect(w.provider.messages()).toHaveLength(0);
    expect(w.operator.messages.some((m) => m.text.includes("did not pass the model reviewer"))).toBe(true);
  });

  it("reviews once per template, not once per contact", async () => {
    const w = await world();
    const second = await seedContact(db, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
    await seedFirstTouch(db, { campaignId: CAMPAIGN, contactId: second, provider: w.provider.name, sentAt: new Date(NOW.getTime() - 3 * DAY - 3_600_000), subject: "Flaky builds at Northwind Tools" });
    const judge = fakeJudge();
    const result = await runFollowUpSweep(deps(w, AUTO, { model: judge }));
    expect(result.sent).toBe(2);
    expect(judge.requests).toHaveLength(1);
    const content = judge.requests[0]?.messages[0]?.content;
    expect([...(typeof content === "string" ? content : "").matchAll(/^Email \d+ \(/gm)]).toHaveLength(1);
  });
});
