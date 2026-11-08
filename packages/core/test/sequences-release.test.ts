// GTM-agents: tests for follow-ups at the cold batch's default level: drafts put up in one
// manifest, the sequence-release command, the resume command, and that the two release commands
// cannot release each other's manifests. Every person, company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { releaseCommand } from "../src/outreach/manifest.ts";
import { parseReleaseCommand, releaseBatch } from "../src/outreach/release.ts";
import { fakeJudge, fakeSendOutreach, flagReader, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "../src/outreach/testing.ts";
import type { OutreachSenderDeps } from "../src/sending/boundary.ts";
import { parseSequenceCommand, runSequenceCommand } from "../src/sequences/commands.ts";
import { parseSequenceReleaseCommand, releaseSequenceManifest } from "../src/sequences/release.ts";
import { createSequenceSender } from "../src/sequences/sender.ts";
import { runFollowUpSweep, type SweepDeps } from "../src/sequences/sweep.ts";
import { ACME_SEQUENCE_TEMPLATES, resetSequenceTables, seedFirstTouch, withMessageIds } from "../src/sequences/testing.ts";
import type { FakeEmailProvider } from "../src/sending/testing.ts";
import { acmeConfig } from "./fixtures.ts";
import { harness, NOW } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const CAMPAIGN = "cb20261101";
const config = defineConfig({ ...acmeConfig, models: { roles: { judge: "judge-test-model" }, pricing: { "judge-test-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } } } });
const MANUAL = { "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" };

let provider: FakeEmailProvider & ReturnType<typeof withMessageIds>;
let senderDeps: OutreachSenderDeps;
let operator: ReturnType<typeof harness>["operator"];
let contactId: string;

beforeEach(async () => {
  await resetSequenceTables(db);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
  const h = harness(db, { config });
  provider = withMessageIds(h.provider);
  senderDeps = h.deps;
  operator = h.operator;
  contactId = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
  await seedFirstTouch(db, { campaignId: CAMPAIGN, contactId, provider: provider.name, sentAt: new Date(NOW.getTime() - 3 * DAY - 3_600_000) });
});

const sweep = (flags: Record<string, string> = MANUAL, extra: Partial<SweepDeps> = {}) =>
  runFollowUpSweep({ db, kv: env.KV, flags: flagReader(flags), config, now: NOW, job: "sequence_sweep", log: silentLogger, send: createSequenceSender(senderDeps), provider, model: fakeJudge(), operator: operator.channel, ...extra });

const release = (text: string, flags: Record<string, string> = MANUAL, now: Date = NOW) => {
  const command = parseSequenceReleaseCommand(text);
  if (!command) throw new Error(`not a sequence release command: ${text}`);
  return releaseSequenceManifest({ db, flags: flagReader(flags), kv: env.KV, send: createSequenceSender({ ...senderDeps, now: () => now }), provider, config, actor: "operator:test", now: () => now }, command);
};

describe("follow-ups at the default level", () => {
  it("drafts the step, puts it up in one manifest with a sequence-release command, and sends nothing", async () => {
    const result = await sweep();
    expect(result.drafted).toBe(1);
    expect(result.manifest?.kind).toBe("sequence");
    expect(provider.messages()).toHaveLength(0);
    const draft = await db.prepare("SELECT kind, status, idempotency_key FROM drafts").first<{ kind: string; status: string; idempotency_key: string }>();
    expect(draft).toEqual({ kind: "follow_up", status: "pending_approval", idempotency_key: `seq:${CAMPAIGN}:${contactId}:2` });
    const command = releaseCommand(result.manifest ?? { id: "", code: "", kind: "sequence" });
    expect(command).toMatch(/^sequence-release-sq\d{12}[0-9a-f]{4}-[0-9a-f]{6}$/);
    expect(operator.messages.some((m) => m.text.includes(command) && m.text.includes("Re: Flaky builds at Globex Corporation"))).toBe(true);
  });

  it("does not put the same step up again while its manifest is live", async () => {
    await sweep();
    const again = await sweep();
    expect(again.drafted).toBe(0);
    expect(again.waiting).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM approval_manifests").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("releases the manifest: the step goes threaded with its approved digest, once", async () => {
    const { manifest } = await sweep();
    const command = releaseCommand(manifest ?? { id: "", code: "", kind: "sequence" });
    const result = await release(command);
    expect(result.ok).toBe(true);
    expect(result.report?.sent).toBe(1);
    const [message] = provider.messages();
    expect(message?.headers["In-Reply-To"]).toBe(`<pm-${contactId}-1@mail.fake.example>`);
    expect(message?.tags.draft_id).toBe(Object.keys(manifest?.entries ?? {})[0]);
    expect((await db.prepare("SELECT status, approved_by FROM drafts").first<{ status: string; approved_by: string }>())).toEqual({ status: "sent", approved_by: "operator:test" });
    expect((await db.prepare("SELECT sequence_step FROM campaign_contacts").first<{ sequence_step: number }>())?.sequence_step).toBe(2);
    // The same command again hands nothing over twice.
    const again = await release(command);
    expect(again.report?.sent ?? 0).toBe(0);
    expect(provider.messages()).toHaveLength(1);
  });

  it("refuses a wrong code, a missing manifest, an old manifest, and sequences switched off", async () => {
    const { manifest } = await sweep();
    const id = manifest?.id ?? "";
    const code = manifest?.code ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await release(`sequence-release-${id}-${wrong}`)).text).toMatch(/does not match/);
    expect((await release(`sequence-release-sq200001010000abcd-${code}`)).text).toMatch(/no approval manifest/);
    expect((await release(`sequence-release-${id}-${code}`, MANUAL, new Date(NOW.getTime() + 73 * 3_600_000))).text).toMatch(/more than 72 hours ago/);
    expect((await release(`sequence-release-${id}-${code}`, { "sequences:enabled": "false" })).text).toMatch(/switched off/);
    expect(provider.messages()).toHaveLength(0);
  });

  it("keeps the two release commands apart: neither releases the other's manifest", async () => {
    const { manifest } = await sweep();
    const id = manifest?.id ?? "";
    const code = manifest?.code ?? "";
    const asBatch = parseReleaseCommand(`batch-release-${id}-${code}`);
    expect(asBatch).not.toBeNull();
    const send = fakeSendOutreach();
    const refused = await releaseBatch({ db, flags: flagReader({ "cold_batch:enabled": "true" }), kv: env.KV, send: send.send, config, actor: "operator:test", now: () => NOW }, asBatch ?? { manifestId: "", code: "" });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/no approval manifest/);
    expect(send.calls).toHaveLength(0);
    expect(parseSequenceReleaseCommand(`batch-release-${id}-${code}`)).toBeNull();
    expect(parseReleaseCommand(`sequence-release-${id}-${code}`)).toBeNull();
  });

  it("approves a released step that is not due yet without sending it, and the sweep sends it when due", async () => {
    const { manifest } = await sweep();
    const later = new Date(NOW.getTime() + DAY).toISOString();
    await db.prepare("UPDATE campaign_contacts SET next_send_at = ?1").bind(later).run();
    const result = await release(releaseCommand(manifest ?? { id: "", code: "", kind: "sequence" }));
    expect(result.waiting).toHaveLength(1);
    expect(provider.messages()).toHaveLength(0);
    expect((await db.prepare("SELECT status FROM drafts").first<{ status: string }>())?.status).toBe("approved");
    const dayLater = new Date(NOW.getTime() + DAY + 60_000);
    const swept = await runFollowUpSweep({ db, kv: env.KV, flags: flagReader(MANUAL), config, now: dayLater, job: "sequence_sweep", log: silentLogger, send: createSequenceSender({ ...senderDeps, now: () => dayLater }), provider, operator: operator.channel });
    expect(swept.sent).toBe(1);
  });

  it("falls back to a release when auto-approve applies but the reviewer is off", async () => {
    const result = await sweep({ ...MANUAL, "cold_batch:auto_approve": "true" });
    expect(result.drafted).toBe(1);
    expect(provider.messages()).toHaveLength(0);
    expect(operator.messages.some((m) => m.text.includes("model reviewer is switched off"))).toBe(true);
  });
});

describe("the sequence commands", () => {
  it("parses only the exact forms", () => {
    expect(parseSequenceCommand("sequence-release-sq202611041700abcd-1a2b3c")).toEqual({ kind: "release", command: { manifestId: "sq202611041700abcd", code: "1a2b3c" } });
    expect(parseSequenceCommand("/sequence-resume-ct_123abc")).toEqual({ kind: "resume", contactId: "ct_123abc" });
    expect(parseSequenceCommand("channel-done-mt0123456789 x")).toEqual({ kind: "channel", decision: "done", touchId: "mt0123456789", channel: "x" });
    expect(parseSequenceCommand("channel-done-mt0123456789")).toEqual({ kind: "channel", decision: "done", touchId: "mt0123456789", channel: "linkedin" });
    expect(parseSequenceCommand("channel-skip-mt0123456789")).toEqual({ kind: "channel", decision: "skip", touchId: "mt0123456789", channel: "linkedin" });
    expect(parseSequenceCommand("please sequence-resume-ct_123abc")).toBeNull();
    expect(parseSequenceCommand("channel-skip-mt0123456789 x")).toBeNull();
    expect(parseSequenceCommand("sequence-resume-ct 123")).toBeNull();
  });

  it("resumes a paused contact, and the next sweep checks and sends the step", async () => {
    await db.prepare("UPDATE campaign_contacts SET sequence_paused_at = ?1, sequence_pause_reason = 'a test pause'").bind(NOW.toISOString()).run();
    expect((await sweep({ ...MANUAL, "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" })).due).toBe(0);
    const deps = { db, flags: flagReader(MANUAL), kv: env.KV, config, send: undefined, provider, userId: "42", now: () => NOW };
    expect(await runSequenceCommand(deps, { kind: "resume", contactId })).toMatch(/Resumed 1 sequence/);
    expect(await runSequenceCommand(deps, { kind: "resume", contactId })).toMatch(/No paused sequence/);
    const after = await sweep({ ...MANUAL, "cold_batch:auto_approve": "true", "quality:model_review_enabled": "true" });
    expect(after.sent).toBe(1);
  });

  it("refuses a release when no send function is wired", async () => {
    const { manifest } = await sweep();
    const text = await runSequenceCommand(
      { db, flags: flagReader(MANUAL), kv: env.KV, config, send: undefined, provider, userId: "42", now: () => NOW },
      { kind: "release", command: { manifestId: manifest?.id ?? "", code: manifest?.code ?? "" } },
    );
    expect(text).toMatch(/No send function/);
    expect(provider.messages()).toHaveLength(0);
  });
});
