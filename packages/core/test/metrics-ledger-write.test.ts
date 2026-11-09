// GTM-agents: tests that the send ledger is complete: the composer sets each message's template
// version and cohort, the draft carries them to the send function, and the send function records
// them on outreach_sends as bookkeeping only (a malformed value is dropped, never a reason to
// refuse a send). The deferred queue keeps them across a replay. Every person, company and address
// is invented.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { runColdBatch } from "../src/outreach/batch.ts";
import { fakeJudge, fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "../src/outreach/testing.ts";
import { createOutreachSender, deferredItemJson } from "../src/sending/boundary.ts";
import { itemFromRow, replayDeferred } from "../src/sending/deferred.ts";
import { releaseCommand } from "../src/outreach/manifest.ts";
import { parseReleaseCommand, releaseBatch } from "../src/outreach/release.ts";
import { parseSequenceReleaseCommand, releaseSequenceManifest } from "../src/sequences/release.ts";
import { sha256Hex } from "../src/shared/hash.ts";
import { createSequenceSender } from "../src/sequences/sender.ts";
import { runFollowUpSweep } from "../src/sequences/sweep.ts";
import { ACME_SEQUENCE_TEMPLATES, resetSequenceTables, seedFirstTouch, withMessageIds } from "../src/sequences/testing.ts";
import { coldItem, harness, insertContact, NOW } from "./delivery-fakes.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const SHA = "e".repeat(64);
const config = defineConfig({
  ...acmeConfig,
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } },
});

const ledgerRow = (sendId: string) => db.prepare("SELECT template_sha256, cohort FROM outreach_sends WHERE id = ?1").bind(sendId).first<{ template_sha256: string | null; cohort: string | null }>();

describe("the send function's bookkeeping", () => {
  it("records the template version and cohort an item carries", async () => {
    const h = harness(db);
    const contact = await insertContact(db);
    const [outcome] = await createOutreachSender(h.deps)([{ ...coldItem(contact), templateSha256: SHA, cohort: "segment_routed" }]);
    if (outcome?.status !== "sent") throw new Error(`expected a send, got ${JSON.stringify(outcome)}`);
    expect(await ledgerRow(outcome.sendId)).toEqual({ template_sha256: SHA, cohort: "segment_routed" });
  });

  it("still sends, recording nothing, when they are missing or malformed", async () => {
    const h = harness(db);
    const [a, b] = await Promise.all([insertContact(db), insertContact(db)]);
    if (!a || !b) throw new Error("two contacts");
    const outcomes = await createOutreachSender(h.deps)([{ ...coldItem(a), templateSha256: "NOT-A-HASH", cohort: "personalized" }, coldItem(b)]);
    for (const outcome of outcomes) {
      if (outcome.status !== "sent") throw new Error(`expected a send, got ${JSON.stringify(outcome)}`);
      expect(outcome.failedWrites).toBeUndefined();
      expect(await ledgerRow(outcome.sendId)).toEqual({ template_sha256: null, cohort: null });
    }
  });

  it("keeps both across the deferred queue", () => {
    const item = { idempotencyKey: "cold:2022-01-01:c1", path: "cold" as const, contactId: "c1", to: "jane@globex.example", subject: "Hello", body: "Body", templateId: "cold-intro", templateSha256: SHA, cohort: "signalled" };
    const replayed = itemFromRow({
      id: "d1",
      contact_id: "c1",
      campaign_id: null,
      draft_id: null,
      experiment_id: null,
      experiment_arm: null,
      send_path: "cold",
      recipient_email: item.to,
      subject: item.subject,
      body: item.body,
      attempt_count: 0,
      idempotency_key: item.idempotencyKey,
      item: deferredItemJson(item),
      created_at: "2022-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof itemFromRow>[0]);
    expect(replayed).toMatchObject({ templateId: "cold-intro", templateSha256: SHA, cohort: "signalled" });
  });
});

describe("the cold batch", () => {
  it("writes each draft's template version and cohort, and hands both to the send function", async () => {
    await resetOutreachTables(db);
    await uploadOutreachBrain(env.KV);
    const generic = templateFile("cold-intro");
    await uploadTemplates(env.KV, [generic]);
    const signalled = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex" });
    await seedContact(db, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
    await db.prepare("INSERT INTO signal_events (id, type, account_key, headline, detected_at) VALUES ('sig-1', 'hiring', 'globex.example', 'Hiring platform engineers', ?1)").bind(new Date(Date.parse("2026-11-09T13:00:00.000Z") - 5 * 86_400_000).toISOString()).run();
    const send = fakeSendOutreach();
    const now = new Date("2026-11-09T13:00:00.000Z");
    const result = await runColdBatch({
      db,
      kv: env.KV,
      flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0", "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" }),
      config,
      now,
      job: "cold_batch",
      log: silentLogger,
      send: send.send,
      volume: () => Promise.resolve(10),
      model: fakeJudge(),
    });
    expect(result.status).toBe("sent");
    const sha = await sha256Hex(generic.content);
    const { results: drafts } = await db.prepare("SELECT contact_id, template_sha256, cohort FROM drafts ORDER BY contact_id").all<{ contact_id: string; template_sha256: string; cohort: string }>();
    expect(drafts).toHaveLength(2);
    for (const d of drafts) expect(d).toMatchObject({ template_sha256: sha, cohort: d.contact_id === signalled ? "signalled" : "generic" });
    const items = send.items();
    expect(items).toHaveLength(2);
    for (const i of items) expect(i).toMatchObject({ templateSha256: sha, cohort: i.contactId === signalled ? "signalled" : "generic" });
  });

  it("records a targeted template's drafts as segment routed", async () => {
    await resetOutreachTables(db);
    await uploadOutreachBrain(env.KV);
    await uploadTemplates(env.KV, [templateFile("cold-intro-champions", { personas: "platform-champion" })]);
    await seedContact(db, { first: "Pat", email: "pat@contoso.example", accountName: "Contoso Labs", persona: "platform-champion" });
    const send = fakeSendOutreach();
    await runColdBatch({
      db,
      kv: env.KV,
      flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0" }),
      config,
      now: new Date("2026-11-10T13:00:00.000Z"),
      job: "cold_batch",
      log: silentLogger,
      send: send.send,
      volume: () => Promise.resolve(10),
    });
    expect(await db.prepare("SELECT cohort FROM drafts").first<{ cohort: string }>()).toEqual({ cohort: "segment_routed" });
  });
});

describe("the follow-up sweep", () => {
  it("writes the step's template version and cohort on the draft and the ledger row", async () => {
    await resetSequenceTables(db);
    await db.prepare("DELETE FROM signal_events").run();
    await uploadOutreachBrain(env.KV);
    await uploadTemplates(env.KV, [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
    const h = harness(db, { config });
    const provider = withMessageIds(h.provider);
    const contactId = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedFirstTouch(db, { campaignId: "cb20261101", contactId, provider: provider.name, sentAt: new Date(NOW.getTime() - 3 * 86_400_000 - 3_600_000) });
    const result = await runFollowUpSweep({
      db,
      kv: env.KV,
      flags: flagReader({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed", "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" }),
      config,
      now: NOW,
      job: "sequence_sweep",
      log: silentLogger,
      send: createSequenceSender({ ...h.deps, now: () => NOW }),
      provider,
      model: fakeJudge(),
      operator: h.operator.channel,
    });
    expect(result.sent).toBe(1);
    const followUp = ACME_SEQUENCE_TEMPLATES[0];
    if (!followUp) throw new Error("the example sequence has a follow-up");
    const sha = await sha256Hex(followUp.content);
    expect(await db.prepare("SELECT template_sha256, cohort FROM drafts WHERE kind = 'follow_up'").first()).toEqual({ template_sha256: sha, cohort: "generic" });
    expect(await db.prepare("SELECT template_sha256, cohort FROM outreach_sends WHERE sequence_step = 2").first()).toEqual({ template_sha256: sha, cohort: "generic" });
  });
});

describe("every way a message reaches the ledger", () => {
  it("keeps both through the deferred queue and its replay, onto the ledger row", async () => {
    const contact = await insertContact(db, { timezone: "Asia/Tokyo" });
    const queued = harness(db, { now: () => new Date("2026-01-07T17:00:00.000Z") });
    const [deferred] = await createOutreachSender(queued.deps)([{ ...coldItem(contact), templateSha256: SHA, cohort: "signalled" }]);
    expect(deferred?.status).toBe("deferred");
    const replay = harness(db, { now: () => new Date("2026-01-07T23:30:00.000Z") });
    expect(await replayDeferred({ ...replay.deps, maxRows: 50 })).toMatchObject({ sent: 1 });
    expect(await db.prepare("SELECT template_sha256, cohort FROM outreach_sends WHERE contact_id = ?1").bind(contact.id).first()).toEqual({ template_sha256: SHA, cohort: "signalled" });
  });

  it("carries both from a released cold batch onto the sent ledger row", async () => {
    await resetOutreachTables(db);
    await db.prepare("DELETE FROM signal_events").run();
    await uploadOutreachBrain(env.KV);
    const template = templateFile("cold-intro");
    await uploadTemplates(env.KV, [template]);
    const contactId = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex" });
    const batch = await runColdBatch({
      db,
      kv: env.KV,
      flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0" }),
      config,
      now: NOW,
      job: "cold_batch",
      log: silentLogger,
      send: fakeSendOutreach().send,
      volume: () => Promise.resolve(10),
    });
    const command = parseReleaseCommand(releaseCommand(batch.manifest ?? { id: "", code: "", kind: "cold_batch" }));
    if (!command) throw new Error("expected a release command");
    const h = harness(db, { config });
    const released = await releaseBatch({ db, flags: flagReader({ "cold_batch:enabled": "true" }), kv: env.KV, send: createOutreachSender(h.deps), config, actor: "operator:test", now: () => NOW }, command);
    expect(released.ok).toBe(true);
    expect(await db.prepare("SELECT template_sha256, cohort FROM outreach_sends WHERE contact_id = ?1 AND sequence_step = 1").bind(contactId).first()).toEqual({ template_sha256: await sha256Hex(template.content), cohort: "generic" });
  });

  it("carries both from a released follow-up manifest onto the sent ledger row", async () => {
    await resetSequenceTables(db);
    await db.prepare("DELETE FROM signal_events").run();
    await uploadOutreachBrain(env.KV);
    await uploadTemplates(env.KV, [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
    const h = harness(db, { config });
    const provider = withMessageIds(h.provider);
    const contactId = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedFirstTouch(db, { campaignId: "cb20261101", contactId, provider: provider.name, sentAt: new Date(NOW.getTime() - 3 * 86_400_000 - 3_600_000) });
    await db.prepare("INSERT INTO signal_events (id, type, contact_id, headline, detected_at) VALUES ('sig-2', 'post', ?1, 'Wrote about flaky tests', ?2)").bind(contactId, new Date(NOW.getTime() - 86_400_000).toISOString()).run();
    const flags = flagReader({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" });
    const sweep = await runFollowUpSweep({ db, kv: env.KV, flags, config, now: NOW, job: "sequence_sweep", log: silentLogger, send: createSequenceSender(h.deps), provider, model: fakeJudge(), operator: h.operator.channel });
    const command = parseSequenceReleaseCommand(releaseCommand(sweep.manifest ?? { id: "", code: "", kind: "sequence" }));
    if (!command) throw new Error("expected a sequence release command");
    const released = await releaseSequenceManifest({ db, flags, kv: env.KV, send: createSequenceSender({ ...h.deps, now: () => NOW }), provider, config, actor: "operator:test", now: () => NOW }, command);
    expect(released.report?.sent).toBe(1);
    const followUp = ACME_SEQUENCE_TEMPLATES[0];
    if (!followUp) throw new Error("the example sequence has a follow-up");
    expect(await db.prepare("SELECT template_sha256, cohort FROM outreach_sends WHERE contact_id = ?1 AND sequence_step = 2").bind(contactId).first()).toEqual({ template_sha256: await sha256Hex(followUp.content), cohort: "signalled" });
  });
});
