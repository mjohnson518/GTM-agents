// GTM-agents: tests for the provider boundary: every check inside the send function, the message
// that leaves, the per-send bookkeeping, the deferred queue and the provider failure rules.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addSuppression } from "../src/sending/suppression.ts";
import { createOutreachSender } from "../src/sending/boundary.ts";
import { COLD_PAUSE_KEY } from "../src/sending/kill-switch.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { HALT_KEY } from "../src/security/halt.ts";
import { verifyUnsubscribeToken } from "../src/sending/unsubscribe-token.ts";
import { coldItem, config, deliveryKv, failingOn, harness, insertCampaign, insertContact, insertDraft, insertInbound, insertLifecycle, NOW, SIGNING_KEY, uid } from "./delivery-fakes.ts";

const db = env.DB;

describe("the provider boundary: a send that goes out", () => {
  it("sends plain text with the footer, the unsubscribe and threading headers and the tags", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const campaignId = await insertCampaign(db);
    const draft = await insertDraft(db, contact, { subject: "Flaky builds at your team", body: coldItem(contact).body }, { campaignId });
    const item = coldItem(contact, { campaignId, draftId: draft.id, approvedDigest: draft.digest, experimentId: "exp-1", experimentArm: "arm-b", inReplyTo: "<first@outreach.acme.example>", toName: "Riley Example" });
    const [outcome] = await createOutreachSender(h.deps)([item]);
    expect(outcome).toMatchObject({ idempotencyKey: item.idempotencyKey, status: "sent" });
    expect(outcome?.status === "sent" && outcome.failedWrites).toBeFalsy();
    const [message] = h.provider.messages();
    expect(message).toBeDefined();
    if (!message) return;
    expect(message.from).toEqual(config.sending.from);
    expect(message.replyTo).toBe(config.sending.replyTo);
    expect(message.to).toEqual({ email: contact.email, name: "Riley Example" });
    expect(message.text.startsWith(item.body)).toBe(true);
    expect(message.text).toContain(config.sending.postalAddress);
    expect(message.text).toContain('reply "unsubscribe"');
    expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const link = /<(https:\/\/agent\.acme\.example\/u\/[^>]+)>/.exec(message.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect(message.headers["List-Unsubscribe"]).toContain(`<mailto:${config.sending.replyTo}?subject=unsubscribe>`);
    expect(message.text).toContain(link);
    expect(await verifyUnsubscribeToken(link.split("/u/")[1] ?? "", SIGNING_KEY)).toBe(contact.email);
    expect(message.headers["In-Reply-To"]).toBe("<first@outreach.acme.example>");
    expect(message.headers.References).toBe("<first@outreach.acme.example>");
    expect(message.tags).toMatchObject({ contact_id: contact.id, campaign_id: campaignId, draft_id: draft.id, experiment_id: "exp-1", variant_id: "arm-b", send_path: "cold" });
    expect(message.effectKey).toBe(item.idempotencyKey);
    expect(/<img|<a |https?:\/\/\S+\?/.test(message.text)).toBe(false);
  });

  it("records the ledger row, the outreach log, the draft, warmth, the campaign row, a funnel event and domain stats", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const campaignId = await insertCampaign(db);
    const draft = await insertDraft(db, contact, { subject: "Flaky builds at your team", body: coldItem(contact).body }, { campaignId });
    const [outcome] = await createOutreachSender(h.deps)([coldItem(contact, { campaignId, draftId: draft.id, approvedDigest: draft.digest, sequenceStep: 1 })]);
    if (outcome?.status !== "sent") throw new Error(`expected a send, got ${JSON.stringify(outcome)}`);
    const send = await db.prepare("SELECT * FROM outreach_sends WHERE id = ?1").bind(outcome.sendId).first<Record<string, unknown>>();
    expect(send).toMatchObject({ contact_id: contact.id, account_key: contact.accountKey, campaign_id: campaignId, draft_id: draft.id, send_path: "cold", provider: h.provider.name, provider_message_id: outcome.providerMessageId, sequence_step: 1 });
    expect(send?.recipient_domain).toBe(contact.email.split("@")[1]);
    const row = await db.prepare("SELECT warmth, total_touches, last_contacted_at FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string; total_touches: number; last_contacted_at: string }>();
    expect(row).toMatchObject({ warmth: "contacted", total_touches: 1, last_contacted_at: NOW.toISOString() });
    expect((await db.prepare("SELECT status FROM drafts WHERE id = ?1").bind(draft.id).first<{ status: string }>())?.status).toBe("sent");
    expect((await db.prepare("SELECT status FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2").bind(campaignId, contact.id).first<{ status: string }>())?.status).toBe("sent");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM outreach_log WHERE contact_id = ?1 AND outcome = 'sent'").bind(contact.id).first<{ n: number }>())?.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'outreach_sent'").bind(contact.id).first<{ n: number }>())?.n).toBe(1);
    expect((await db.prepare("SELECT sends FROM domain_delivery WHERE domain = ?1").bind(contact.email.split("@")[1]).first<{ sends: number }>())?.sends).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM cost_events WHERE provider = ?1").bind(h.provider.name).first<{ n: number }>())?.n).toBe(1);
  });

  it("schedules a cold first touch's follow-up from the sequence config, wherever it is sent from", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const campaignId = await insertCampaign(db);
    const [outcome] = await createOutreachSender(h.deps)([coldItem(contact, { campaignId, sequenceStep: 1 })]);
    expect(outcome?.status).toBe("sent");
    const step = config.sequences.cold.steps[1];
    if (!step) throw new Error("the example config has a second cold step");
    const row = await db.prepare("SELECT sequence_active, next_send_at FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2").bind(campaignId, contact.id).first<{ sequence_active: number; next_send_at: string | null }>();
    expect(row).toEqual({ sequence_active: 1, next_send_at: new Date(NOW.getTime() + step.delayDays * 86_400_000).toISOString() });
  });

  it("schedules over an existing pending row, but never re-arms one a bounce, reply or opt-out moved on", async () => {
    const h = harness(db);
    const campaignId = await insertCampaign(db);
    const pending = await insertContact(db);
    const optedOut = await insertContact(db);
    const seed = "INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_active, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)";
    await db.prepare(seed).bind(campaignId, pending.id, "pending", NOW.toISOString()).run();
    await db.prepare(seed).bind(campaignId, optedOut.id, "opted_out", NOW.toISOString()).run();
    await createOutreachSender(h.deps)([coldItem(pending, { campaignId, sequenceStep: 1 }), coldItem(optedOut, { campaignId, sequenceStep: 1 })]);
    const read = (id: string) =>
      db.prepare("SELECT status, sequence_active, next_send_at FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2").bind(campaignId, id).first<{ status: string; sequence_active: number; next_send_at: string | null }>();
    expect(await read(pending.id)).toMatchObject({ status: "sent", sequence_active: 1 });
    expect((await read(pending.id))?.next_send_at).not.toBeNull();
    expect(await read(optedOut.id)).toEqual({ status: "opted_out", sequence_active: 0, next_send_at: null });
  });

  it("leaves the schedule alone for a send that is not a cold first touch", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const campaignId = await insertCampaign(db);
    await createOutreachSender(h.deps)([coldItem(contact, { campaignId })]);
    const row = await db.prepare("SELECT sequence_active, next_send_at FROM campaign_contacts WHERE campaign_id = ?1 AND contact_id = ?2").bind(campaignId, contact.id).first<{ sequence_active: number; next_send_at: string | null }>();
    expect(row).toEqual({ sequence_active: 0, next_send_at: null });
  });

  it("keeps a send when bookkeeping fails, and reports the writes that failed", async () => {
    const h = harness(failingOn(db, /INSERT INTO outreach_log/));
    const contact = await insertContact(db);
    const [outcome] = await createOutreachSender(h.deps)([coldItem(contact)]);
    expect(outcome).toMatchObject({ status: "sent", failedWrites: ["outreach_log"] });
    expect((await db.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string }>())?.warmth).toBe("contacted");
  });

  it("chunks to the provider's batch limit", async () => {
    const h = harness(db);
    h.deps.provider = Object.assign(h.provider, { batchLimit: 2 });
    const contacts = await Promise.all(Array.from({ length: 5 }, () => insertContact(db)));
    const outcomes = await createOutreachSender(h.deps)(contacts.map((c) => coldItem(c)));
    expect(outcomes.every((o) => o.status === "sent")).toBe(true);
    expect(h.provider.batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("does not window replies", async () => {
    const h = harness(db);
    const contact = await insertContact(db, { timezone: "Asia/Tokyo", warmth: "engaged" });
    await insertInbound(db, contact);
    const [outcome] = await createOutreachSender(h.deps)([coldItem(contact, { path: "reply" })]);
    expect(outcome?.status).toBe("sent");
  });

  it("treats a reply to someone who never wrote in, or lifecycle mail to a non-user, as cold", async () => {
    const h = harness(db);
    const stranger = await insertContact(db, { timezone: "Asia/Tokyo" });
    const outcomes = await createOutreachSender(h.deps)([coldItem(stranger, { path: "reply" }), coldItem(stranger, { path: "lifecycle", idempotencyKey: uid("l") })]);
    expect(outcomes.map((o) => (o.status === "deferred" ? o.reason : o.status))).toEqual(["outside_window", "outside_window"]);
    const row = await db.prepare("SELECT send_path FROM deferred_sends WHERE contact_id = ?1 LIMIT 1").bind(stranger.id).first<{ send_path: string }>();
    expect(row?.send_path).toBe("cold");
  });

  it("treats lifecycle mail to a prospect with a lifecycle row but no sign-up as cold", async () => {
    const h = harness(db);
    const prospect = await insertContact(db, { timezone: "Asia/Tokyo" });
    // A booked meeting moves a prospect to engaged, which writes a lifecycle row; that is not a product user.
    await db.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'engaged')").bind(prospect.id).run();
    const [outcome] = await createOutreachSender(h.deps)([coldItem(prospect, { path: "lifecycle" })]);
    expect(outcome?.status === "deferred" && outcome.reason).toBe("outside_window");
    const row = await db.prepare("SELECT send_path FROM deferred_sends WHERE contact_id = ?1 LIMIT 1").bind(prospect.id).first<{ send_path: string }>();
    expect(row?.send_path).toBe("cold");
  });

  it("refuses an item that names a draft without its approved digest", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const draft = await insertDraft(db, contact, { subject: "Flaky builds at your team", body: coldItem(contact).body }, { approved: false });
    const [outcome] = await createOutreachSender(h.deps)([coldItem(contact, { draftId: draft.id })]);
    expect(outcome).toMatchObject({ status: "blocked", reason: "approval_mismatch" });
    expect(h.provider.batches).toHaveLength(0);
  });
});

describe("the provider boundary: what holds a send", () => {
  it("refuses everything while delivery:enabled is off or unreadable, without calling the provider", async () => {
    for (const kv of [deliveryKv({ [DELIVERY_FLAGS.enabled]: "false" }), (() => {
      const k = deliveryKv();
      k.map.delete(DELIVERY_FLAGS.enabled);
      return k;
    })()]) {
      const h = harness(db, { kv });
      const [outcome] = await createOutreachSender(h.deps)([coldItem(await insertContact(db))]);
      expect(outcome).toMatchObject({ status: "failed", retryable: true });
      expect(outcome?.status === "failed" && outcome.message.startsWith("[SEND BLOCKED:disabled]")).toBe(true);
      expect(h.provider.batches).toHaveLength(0);
    }
  });

  it("refuses everything without a provider, a usable signing key or an https base URL", async () => {
    const contact = await insertContact(db);
    for (const overrides of [{ provider: undefined }, { unsubscribeSigningKey: undefined }, { unsubscribeSigningKey: "short-key" }, { baseUrl: undefined }, { baseUrl: "http://agent.acme.example" }]) {
      const h = harness(db, overrides);
      const [outcome] = await createOutreachSender(h.deps)([coldItem(contact)]);
      expect(outcome, JSON.stringify(overrides)).toMatchObject({ status: "failed", retryable: true });
      expect(outcome?.status === "failed" && outcome.message.startsWith("[SEND BLOCKED:not_configured]")).toBe(true);
      expect(h.provider.batches).toHaveLength(0);
    }
  });

  it("refuses malformed items and reports duplicates within a call", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const good = coldItem(contact);
    const outcomes = await createOutreachSender(h.deps)([good, { ...good }, { ...coldItem(contact), subject: "Hello\nBcc: x@attacker.example" }, { ...coldItem(contact), idempotencyKey: "" }]);
    expect(outcomes.map((o) => o.status)).toEqual(["sent", "duplicate", "blocked", "blocked"]);
    expect(outcomes[2]).toMatchObject({ reason: "invalid" });
  });

  it("blocks suppressed and unparseable recipients", async () => {
    const h = harness(db);
    const suppressed = await insertContact(db);
    await addSuppression(db, { email: suppressed.email, reason: "opt_out" });
    const outcomes = await createOutreachSender(h.deps)([coldItem(suppressed), coldItem(suppressed, { to: "not an address" })]);
    expect(outcomes).toMatchObject([
      { status: "blocked", reason: "suppressed" },
      { status: "blocked", reason: "unparseable" },
    ]);
  });

  it("refuses a content lint block and lets a warning through", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const outcomes = await createOutreachSender(h.deps)([
      coldItem(contact, { body: "Hi {{first_name}}, a quick note." }),
      coldItem(contact, { subject: "A guaranteed improvement", idempotencyKey: uid("warn") }),
    ]);
    expect(outcomes[0]).toMatchObject({ status: "blocked", reason: "content_lint" });
    expect(outcomes[1]?.status).toBe("sent");
  });

  it("applies the verification policy per path, reading the cache when the contact has no status", async () => {
    const h = harness(db);
    const risky = await insertContact(db, { verification: "risky" });
    const bad = await insertContact(db, { verification: "undeliverable" });
    const cached = await insertContact(db, { verification: null });
    const hash = (await db.prepare("SELECT email_sha256 FROM contacts WHERE id = ?1").bind(cached.id).first<{ email_sha256: string }>())?.email_sha256;
    await db.prepare("INSERT INTO email_verifications (email_sha256, status, provider, verified_at) VALUES (?1, 'deliverable', 'test', ?2)").bind(hash, NOW.toISOString()).run();
    const outcomes = await createOutreachSender(h.deps)([
      coldItem(risky),
      coldItem(risky, { path: "sequence", idempotencyKey: uid("seq") }),
      coldItem(bad, { path: "sequence" }),
      coldItem(cached),
    ]);
    expect(outcomes.map((o) => (o.status === "blocked" ? o.reason : o.status))).toEqual(["undeliverable", "sent", "undeliverable", "sent"]);
  });

  it("refuses an unknown contact and an address that is not the contact's", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const outcomes = await createOutreachSender(h.deps)([coldItem(contact, { contactId: uid("nobody") }), coldItem(contact, { to: `someone.else@${contact.email.split("@")[1]}`, idempotencyKey: uid("k") })]);
    expect(outcomes).toMatchObject([
      { status: "blocked", reason: "invalid" },
      { status: "blocked", reason: "invalid" },
    ]);
  });

  it("refuses an item whose content no longer matches the approved digest", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const draft = await insertDraft(db, contact, { subject: "Flaky builds at your team", body: coldItem(contact).body });
    const send = createOutreachSender(h.deps);
    const [edited] = await send([coldItem(contact, { draftId: draft.id, approvedDigest: draft.digest, body: "Hi Riley, a different body." })]);
    expect(edited).toMatchObject({ status: "blocked", reason: "approval_mismatch" });
    const pending = await insertDraft(db, contact, { subject: "Flaky builds at your team", body: coldItem(contact).body }, { approved: false });
    const [unapproved] = await send([coldItem(contact, { draftId: pending.id, approvedDigest: pending.digest })]);
    expect(unapproved).toMatchObject({ status: "blocked", reason: "approval_mismatch" });
    const [matching] = await send([coldItem(contact, { draftId: draft.id, approvedDigest: draft.digest })]);
    expect(matching?.status).toBe("sent");
  });

  it("defers outside the recipient's window to the next opening, and queues one row per message", async () => {
    const h = harness(db);
    const contact = await insertContact(db, { timezone: "Asia/Tokyo" });
    const campaignId = await insertCampaign(db);
    const item = coldItem(contact, { campaignId, inReplyTo: "<a@outreach.acme.example>" });
    const send = createOutreachSender(h.deps);
    const [first] = await send([item]);
    // 17:00 UTC Wednesday is 02:00 Thursday in Tokyo; the window opens at 08:00 there.
    expect(first).toMatchObject({ status: "deferred", reason: "outside_window", nextAttemptAt: "2026-11-04T23:00:00.000Z" });
    await send([{ ...item, idempotencyKey: uid("again"), body: `${item.body}\nP.S. Updated.` }]);
    const { results } = await db
      .prepare("SELECT d.*, i.item, i.idempotency_key FROM deferred_sends d JOIN deferred_send_items i ON i.deferred_id = d.id WHERE d.contact_id = ?1 AND d.status = 'queued'")
      .bind(contact.id)
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ send_path: "cold", defer_reason: "outside_window", recipient_timezone: "Asia/Tokyo", campaign_id: campaignId });
    expect(String(results[0]?.body)).toContain("P.S. Updated.");
    expect(JSON.parse(String(results[0]?.item))).toMatchObject({ inReplyTo: "<a@outreach.acme.example>" });
    expect(h.provider.batches).toHaveLength(0);
  });

  it("defers over the per-domain daily cap to midnight UTC", async () => {
    const h = harness(db, { kv: deliveryKv({ [DELIVERY_FLAGS.domainDailyCap]: "1" }) });
    const [a, b] = [await insertContact(db), await insertContact(db)];
    const outcomes = await createOutreachSender(h.deps)([coldItem(a), coldItem(b)]);
    expect(outcomes[0]?.status).toBe("sent");
    expect(outcomes[1]).toMatchObject({ status: "deferred", reason: "domain_cap", nextAttemptAt: "2026-11-05T00:00:00.000Z" });
  });

  it("defers over the per-account cap, counting earlier sends from the ledger", async () => {
    const h = harness(db, { kv: deliveryKv({ [DELIVERY_FLAGS.accountWeeklyCap]: "2" }) });
    const domain = `${uid("globex")}.example`;
    const people = await Promise.all([1, 2, 3].map((n) => insertContact(db, { email: `person${n}@${domain}` })));
    const send = createOutreachSender(h.deps);
    expect((await send([coldItem(people[0] as never)]))[0]?.status).toBe("sent");
    const outcomes = await send([coldItem(people[1] as never), coldItem(people[2] as never)]);
    expect(outcomes[0]?.status).toBe("sent");
    expect(outcomes[1]).toMatchObject({ status: "deferred", reason: "account_cap" });
    // A reply to the same account is not held by the cap.
    const replier = await insertContact(db, { email: `person4@${domain}`, warmth: "engaged" });
    await insertInbound(db, replier);
    expect((await send([coldItem(replier, { path: "reply" })]))[0]?.status).toBe("sent");
  });

  it("defers every path while halted, and cold and sequence while the kill switch is on", async () => {
    const contact = await insertContact(db, { warmth: "engaged" });
    await insertInbound(db, contact);
    await insertLifecycle(db, contact);
    const halted = harness(db, { kv: deliveryKv({ [HALT_KEY]: JSON.stringify({ reason: "incident" }) }) });
    const [h1, h2] = await createOutreachSender(halted.deps)([coldItem(contact, { path: "reply" }), coldItem(contact, { path: "lifecycle", idempotencyKey: uid("l") })]);
    expect(h1).toMatchObject({ status: "deferred", reason: "halted" });
    expect(h2).toMatchObject({ status: "deferred", reason: "halted" });
    const paused = harness(db, { kv: deliveryKv({ [COLD_PAUSE_KEY]: JSON.stringify({ reason: "bounces", since: NOW.toISOString() }) }) });
    const cold = await insertContact(db);
    const outcomes = await createOutreachSender(paused.deps)([coldItem(cold), coldItem(contact, { path: "reply", idempotencyKey: uid("r") })]);
    expect(outcomes[0]).toMatchObject({ status: "deferred", reason: "cold_paused" });
    expect(outcomes[1]?.status).toBe("sent");
  });
});

describe("the provider boundary: provider failures", () => {
  it("defers a message the provider refused for now and releases its claim", async () => {
    const h = harness(db);
    h.provider.behavior = { code: "rate_limited", retryable: true };
    const contact = await insertContact(db);
    const item = coldItem(contact);
    const send = createOutreachSender(h.deps);
    expect((await send([item]))[0]).toMatchObject({ status: "deferred", reason: "provider_unavailable" });
    h.provider.behavior = "accept";
    expect((await send([item]))[0]?.status).toBe("sent");
  });

  it("fails a message the provider rejected, releasing its claim", async () => {
    const h = harness(db);
    h.provider.behavior = { code: "invalid", retryable: false };
    const [outcome] = await createOutreachSender(h.deps)([coldItem(await insertContact(db))]);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("keeps the claim when acceptance is uncertain, so the message is never sent twice", async () => {
    const h = harness(db);
    h.provider.behavior = "throw";
    const item = coldItem(await insertContact(db));
    const send = createOutreachSender(h.deps);
    expect((await send([item]))[0]).toMatchObject({ status: "failed", retryable: false });
    h.provider.behavior = "accept";
    expect((await send([item]))[0]?.status).toBe("duplicate");
    expect(h.provider.batches).toHaveLength(1);
  });

  it("sets last_contacted_at for a message whose own answer is unclear, and not for its sent neighbor's warmth", async () => {
    const h = harness(db);
    const unclear = await insertContact(db);
    const fine = await insertContact(db);
    h.provider.behavior = (m) => (m.to.email === unclear.email ? { effectKey: m.effectKey, ok: false, code: "unknown", retryable: false, detail: "time-out" } : { effectKey: m.effectKey, ok: true, providerMessageId: "fake-ok" });
    const outcomes = await createOutreachSender(h.deps)([coldItem(unclear), coldItem(fine)]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "sent"]);
    const row = await db.prepare("SELECT warmth, last_contacted_at FROM contacts WHERE id = ?1").bind(unclear.id).first<{ warmth: string; last_contacted_at: string | null }>();
    expect(row).toEqual({ warmth: "cold", last_contacted_at: NOW.toISOString() });
  });

  it("sets last_contacted_at when the provider call throws, so selection never gives a second first touch", async () => {
    const h = harness(db);
    h.provider.behavior = "throw";
    const contact = await insertContact(db);
    const [outcome] = await createOutreachSender(h.deps)([coldItem(contact)]);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(outcome?.status === "failed" && outcome.message).toContain("may have sent");
    const row = await db.prepare("SELECT warmth, last_contacted_at FROM contacts WHERE id = ?1").bind(contact.id).first<{ warmth: string; last_contacted_at: string | null }>();
    expect(row).toEqual({ warmth: "cold", last_contacted_at: NOW.toISOString() });
  });

  it("opens the circuit breaker after three consecutive failures, deferring the rest and paging once", async () => {
    const h = harness(db);
    h.deps.provider = Object.assign(h.provider, { batchLimit: 1 });
    h.provider.behavior = { code: "unavailable", retryable: true };
    const contacts = await Promise.all([1, 2, 3, 4].map(() => insertContact(db)));
    const outcomes = await createOutreachSender(h.deps)(contacts.map((c) => coldItem(c)));
    expect(outcomes.map((o) => (o.status === "deferred" ? o.reason : o.status))).toEqual(["provider_unavailable", "provider_unavailable", "provider_unavailable", "circuit_open"]);
    expect(h.provider.batches).toHaveLength(3);
    expect(h.operator.messages.filter((m) => m.text.includes("circuit breaker"))).toHaveLength(1);
    const later = await createOutreachSender(h.deps)([coldItem(await insertContact(db))]);
    expect(later[0]).toMatchObject({ status: "deferred", reason: "circuit_open", nextAttemptAt: "2026-11-05T00:00:00.000Z" });
    expect(h.operator.messages.filter((m) => m.text.includes("circuit breaker"))).toHaveLength(1);
  });

  it("does not count a message's own invalidity against the provider", async () => {
    const h = harness(db);
    h.deps.provider = Object.assign(h.provider, { batchLimit: 1 });
    h.provider.behavior = { code: "invalid", retryable: false };
    const contacts = await Promise.all([1, 2, 3, 4].map(() => insertContact(db)));
    const outcomes = await createOutreachSender(h.deps)(contacts.map((c) => coldItem(c)));
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
    expect(h.provider.batches).toHaveLength(4);
  });
});
