// GTM-agents: the cold batch end to end: seeded contacts, accounts, templates and an approved brain go
// through selection, the picker, composing and the quality gate to drafts and an approval manifest;
// the operator's release command then hands exactly those drafts to the send function with their
// digests. Auto-approve, readiness (YELLOW and RED) and resuming are covered too. Every company,
// person and address is invented, and the send function is a fake that records what it is given.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import type { ChatMessage, Env } from "../src/env.ts";
import { processChatMessage } from "../src/operator/chat.ts";
import { draftDigest } from "../src/security/approval-digest.ts";
import { addSuppression } from "../src/sending/suppression.ts";
import { campaignIdFor, createOutreachJobs, runColdBatch, type ColdBatchDeps } from "../src/outreach/index.ts";
import { fakeJudge, fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates, type FakeSend } from "../src/outreach/testing.ts";
import { recordSignal } from "../src/signals/record.ts";
import { acmeConfig } from "./fixtures.ts";
import { newSignal } from "./signals-fakes.ts";

const OPERATOR = "7310001";
const NOW = new Date("2026-11-09T13:00:00.000Z");
const config = defineConfig({
  ...acmeConfig,
  models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 } } },
  operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] },
});

const PEOPLE = [
  { first: "Jane", email: "jane@globex.example", accountName: "Globex", persona: "platform-champion", createdAt: "2026-10-30T00:00:00.000Z" },
  { first: "Sam", email: "sam@globex.example", accountName: "Globex", persona: "economic-buyer" },
  { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools", persona: "economic-buyer" },
  { first: "Pat", email: "pat@contoso.example", accountName: "Contoso Labs", persona: "platform-champion" },
  { first: "Lee", email: "lee@initech.example", accountName: "Initech Systems" },
  { first: null, email: "noname@umbrella.example", accountName: "Umbrella Group" },
];

async function seedWorld(): Promise<void> {
  await resetOutreachTables(env.DB);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("cold-intro")]);
  await env.DB.prepare("INSERT INTO copy_lines (id, kind, key, text) VALUES ('cl1', 'persona', 'platform-champion', 'You probably see this first in the CI dashboard.')").run();
  for (const p of PEOPLE) await seedContact(env.DB, p);
}

function deps(send: FakeSend, flags: Record<string, string>, patch: Partial<ColdBatchDeps> = {}): ColdBatchDeps {
  return {
    db: env.DB,
    kv: env.KV,
    flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0", ...flags }),
    config,
    now: NOW,
    job: "cold_batch",
    runId: "run-batch-1",
    log: silentLogger,
    send: send.send,
    volume: () => Promise.resolve(10),
    ...patch,
  };
}

const message = (text: string, id: string): ChatMessage => ({ updateId: `operator:${OPERATOR}:${id}`, chatId: OPERATOR, userId: OPERATOR, sessionKey: OPERATOR, text });

beforeEach(async () => {
  await seedWorld();
  await env.KV.put("operator:agent_enabled", "true");
  await env.KV.put("cold_batch:enabled", "true");
});

describe("the cold batch, manual mode", () => {
  it("writes drafts and a manifest, and the release command sends exactly those drafts with their digests", async () => {
    const send = fakeSendOutreach();
    const operator = recordingOperator();
    const result = await runColdBatch(deps(send, {}, { operator: operator.channel }));

    expect(result.status).toBe("manual");
    expect(result.campaignId).toBe(campaignIdFor(NOW));
    expect(send.calls).toHaveLength(0);
    // Globex gets one contact, Initech is on the never list, the nameless contact is held.
    const { results: drafts } = await env.DB.prepare("SELECT id, recipient_email, subject, body, status, idempotency_key FROM drafts ORDER BY recipient_email").all<Record<string, string>>();
    expect(drafts.map((d) => d.recipient_email)).toEqual(["ada@northwind.example", "jane@globex.example", "pat@contoso.example"]);
    expect(drafts.every((d) => d.status === "pending_approval")).toBe(true);
    expect(drafts.find((d) => d.recipient_email === "jane@globex.example")?.body).toContain("You probably see this first in the CI dashboard.");
    expect(drafts[0]?.idempotency_key).toBe(`cold:2026-11-09:${(await env.DB.prepare("SELECT id FROM contacts WHERE email = 'ada@northwind.example'").first<{ id: string }>())?.id}`);
    const held = await env.DB.prepare("SELECT findings FROM quality_checks WHERE subject_type = 'draft' AND verdict = 'hold'").first<{ findings: string }>();
    expect(held?.findings).toContain("MISSING_VARIABLE");
    expect(result.skippedByRule).toMatchObject({ never_list: 1, account_batch: 1 });

    const manifest = result.manifest;
    expect(manifest && Object.keys(manifest.entries).sort()).toEqual(drafts.map((d) => d.id).sort());
    const summary = operator.messages.at(-1)?.text ?? "";
    const command = `batch-release-${manifest?.id}-${manifest?.code}`;
    expect(summary).toContain(command);
    expect(summary).toContain("Sample 1 of 3");

    await processChatMessage({ config, operator: () => operator.channel, sendOutreach: () => send.send, now: () => NOW }, env as unknown as Env, message(command, "rel-1"));
    expect(operator.messages.at(-1)?.text).toMatch(/3 of 3 drafts released\. 3 sent/);
    const items = send.items();
    expect(items).toHaveLength(3);
    for (const item of items) {
      const draft = drafts.find((d) => d.id === item.draftId);
      expect(item.path).toBe("cold");
      expect(item.sequenceStep).toBe(1);
      expect(item.approvedDigest).toBe(await draftDigest({ to: draft?.recipient_email, subject: draft?.subject, body: draft?.body }));
    }
    const after = await env.DB.prepare("SELECT d.status, c.warmth, c.last_contacted_at FROM drafts d JOIN contacts c ON c.id = d.contact_id").all<Record<string, string>>();
    expect(after.results.every((r) => r.status === "sent" && r.warmth === "contacted" && r.last_contacted_at)).toBe(true);

    // The same command again hands nothing over twice.
    await processChatMessage({ config, operator: () => operator.channel, sendOutreach: () => send.send, now: () => NOW }, env as unknown as Env, message(command, "rel-2"));
    expect(send.items()).toHaveLength(3);
    expect(operator.messages.at(-1)?.text).toMatch(/0 of 3 drafts released/);
  });

  it("fills a template's angle from the contact's own dated signal, and holds it for contacts without one", async () => {
    const body = ["Hi {{first_name}},", "", "{{angle_opener}} Teams that grow {{angle_age}} usually find their test suite grows faster than their patience with reruns.", "", "Is flaky-test time something your team tracks at {{account_name}}, or does it mostly show up as frustration in standup?", "", "{{sender_name}}"].join("\n");
    await uploadTemplates(env.KV, [templateFile("cold-angle", { body })]);
    const day = 86_400_000;
    await recordSignal(env.DB, newSignal("globex.example", { type: "hiring", source: "hiring_board", eventDate: new Date(NOW.getTime() - 9 * day).toISOString(), expiresAt: new Date(NOW.getTime() + 20 * day).toISOString(), eventKey: "globex-hiring" }), NOW);
    await runColdBatch(deps(fakeSendOutreach(), {}));
    const { results } = await env.DB.prepare("SELECT recipient_email, body FROM drafts").all<{ recipient_email: string; body: string }>();
    const jane = results.find((d) => d.recipient_email === "jane@globex.example");
    expect(jane?.body).toContain("Teams that grow last week");
    expect(jane?.body).not.toContain("{{");
    // Nobody else has a signal: their drafts are held, never written without the reason.
    expect(results.map((d) => d.recipient_email)).toEqual(["jane@globex.example"]);
  });

  it("writes no first touch while the intent filter is on and nobody has a score, or when its switch cannot be read", async () => {
    await runColdBatch(deps(fakeSendOutreach(), { "intent_score:enforce": "true" }));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n).toBe(0);
    await seedWorld();
    await runColdBatch(deps(fakeSendOutreach(), {}, { flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0" }, ["intent_score:enforce"]) }));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n).toBe(0);
    // A contact in the first-touch band still gets a draft while the filter is on.
    await seedWorld();
    await env.DB.prepare("UPDATE contacts SET attributes = json_set(COALESCE(attributes, '{}'), '$.intent', json('{\"band\":\"first_touch\",\"score\":90}')) WHERE email = 'jane@globex.example'").run();
    await runColdBatch(deps(fakeSendOutreach(), { "intent_score:enforce": "true" }));
    const { results } = await env.DB.prepare("SELECT recipient_email FROM drafts").all<{ recipient_email: string }>();
    expect(results.map((d) => d.recipient_email)).toEqual(["jane@globex.example"]);
  });

  it("does not start a second batch the same day", async () => {
    const send = fakeSendOutreach();
    const first = await runColdBatch(deps(send, {}));
    const again = await runColdBatch(deps(send, {}));
    expect(first.status).toBe("manual");
    expect(again.status).toBe("resumed");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approval_manifests").first<{ n: number }>())?.n).toBe(1);
  });

  it("holds everything and pages once when readiness is RED", async () => {
    for (let i = 0; i < 30; i++) {
      await env.DB.prepare("INSERT INTO outreach_sends (id, account_key, send_path, provider, sent_at, bounced_at) VALUES (?1, 'old.example', 'cold', 'p', ?2, ?3)")
        .bind(`os-red-${i}`, "2026-11-09T08:00:00.000Z", i < 6 ? "2026-11-09T09:00:00.000Z" : null)
        .run();
    }
    const send = fakeSendOutreach();
    const operator = recordingOperator();
    const result = await runColdBatch(deps(send, {}, { operator: operator.channel }));
    expect(result.status).toBe("held");
    expect(result.readiness).toBe("red");
    expect(result.manifest).toBeUndefined();
    expect(operator.messages.at(-1)?.text).toMatch(/held: Readiness RED \(bounceRate block/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approval_manifests").first<{ n: number }>())?.n).toBe(0);
  });

  it("skips the day when there is no volume, no template or the flag is off", async () => {
    const send = fakeSendOutreach();
    expect((await runColdBatch(deps(send, {}, { volume: () => Promise.resolve(0) }))).summary).toMatch(/volume/);
    expect((await runColdBatch(deps(send, {}, { volume: () => Promise.reject(new Error("ramp unreadable")) }))).summary).toMatch(/could not be read/);
    expect((await runColdBatch(deps(send, { "cold_batch:enabled": "false" }))).status).toBe("skipped");
    await env.KV.delete("templates:lock");
    const operator = recordingOperator();
    const noTemplates = await runColdBatch(deps(send, {}, { operator: operator.channel }));
    expect(noTemplates.status).toBe("skipped");
    expect(operator.messages.at(-1)?.text).toMatch(/did not run: no template lock/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("the cold batch, auto-approve", () => {
  it("approves and sends drafts that pass the whole gate, with the reviewer's cost recorded", async () => {
    const send = fakeSendOutreach();
    const judge = fakeJudge();
    const result = await runColdBatch(deps(send, { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" }, { model: judge }));
    expect(result.status).toBe("sent");
    expect(result.handoff?.sent).toBe(3);
    // One template: one sample plus one more.
    expect(judge.requests).toHaveLength(1);
    const turn = judge.requests[0]?.messages[0]?.content;
    expect((typeof turn === "string" ? turn : "").match(/^Email \d+ \(/gm)).toHaveLength(2);
    const { results } = await env.DB.prepare("SELECT status, approved_by FROM drafts").all<Record<string, string>>();
    expect(results.every((r) => r.status === "sent" && r.approved_by === "auto:flag")).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cost_events WHERE job = 'cold_batch' AND run_id = 'run-batch-1'").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT outcome FROM autonomy_events").first<{ outcome: string }>())?.outcome).toBe("auto_sent");
  });

  it("sends half of a YELLOW batch now and the rest after 24 hours", async () => {
    for (let i = 0; i < 9; i++) await seedContact(env.DB, { first: "Kim", email: `kim@acct${i}.example`, accountName: `Account Number ${i}` });
    // Most of the batch has no cached verification: YELLOW.
    await env.DB.prepare("DELETE FROM email_verifications").run();
    const send = fakeSendOutreach();
    const flags = { "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" };
    const result = await runColdBatch(deps(send, flags, { model: fakeJudge(), volume: () => Promise.resolve(20) }));
    expect(result.readiness).toBe("yellow");
    expect(result.passed).toBe(12);
    expect(send.items()).toHaveLength(6);

    const tomorrow = new Date(NOW.getTime() + 25 * 3_600_000);
    // Deferred first touches still count against the day's volume: with none, nothing resumes.
    expect((await runColdBatch(deps(send, flags, { model: fakeJudge(), now: tomorrow, volume: () => Promise.resolve(0) }))).resumed).toBeUndefined();
    const next = await runColdBatch(deps(send, flags, { model: fakeJudge(), now: tomorrow, volume: () => Promise.resolve(20) }));
    expect(next.resumed?.submitted ?? 0).toBeGreaterThan(0);
    expect(send.items().length).toBeGreaterThan(6);
    expect(new Set(send.items().map((i) => i.draftId)).size).toBe(send.items().length);
  });

  it("registers one job with named days, its flag and a spend ceiling for the reviewer", () => {
    const [job] = createOutreachJobs({ send: () => fakeSendOutreach().send, volume: () => Promise.resolve(10) });
    expect(job?.name).toBe("cold_batch");
    expect(job?.schedule).toBe("0 13 * * MON-THU");
    expect(job?.flag).toBe("cold_batch:enabled");
    expect(job?.ceilings).toMatchObject({ maxRows: 1500, maxSpendCents: 50 });
    expect(() => createOutreachJobs({ send: () => fakeSendOutreach().send, volume: () => Promise.resolve(1), options: { batchSchedule: "* * * * *" } })).toThrow(/per-minute/);
  });

  it("drops suppressed recipients before composing", async () => {
    await addSuppression(env.DB, { email: "pat@contoso.example", reason: "opt_out", source: "test" });
    const result = await runColdBatch(deps(fakeSendOutreach(), {}));
    const { results } = await env.DB.prepare("SELECT recipient_email FROM drafts").all<{ recipient_email: string }>();
    expect(results.map((r) => r.recipient_email)).not.toContain("pat@contoso.example");
    expect(result.drafts).toBe(2);
  });
});
