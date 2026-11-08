// GTM-agents: the release command binds to what the operator was shown. It refuses without a manifest
// or with a wrong code, refuses every draft edited after the manifest was written, refuses drafts
// whose contact replied or was written to since, and hands nothing over twice. Every person and
// company is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "@gtm-agents/core/config";
import { draftDigest } from "@gtm-agents/core/security";
import { parseReleaseCommand, releaseBatch, runColdBatch, type Manifest } from "@gtm-agents/core/outreach";
import { fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates, type FakeSend } from "@gtm-agents/core/outreach/testing";

const NOW = new Date("2026-11-09T13:00:00.000Z");
const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests in CI." } },
  agent: { name: "Avery" },
  sending: { from: { email: "avery@outreach.acme.example" }, replyTo: "avery@acme.example", supportAddress: "support@acme.example", postalAddress: "Acme Inc., 100 Example Street, Springfield", domain: "outreach.acme.example" },
});
const enabled = flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0" });

async function batch(): Promise<Manifest> {
  await resetOutreachTables(env.DB);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("cold-intro")]);
  await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
  await seedContact(env.DB, { first: "Ada", email: "ada@northwind.example", accountName: "Northwind Tools" });
  const result = await runColdBatch({ db: env.DB, kv: env.KV, flags: enabled, config, now: NOW, job: "cold_batch", log: silentLogger, send: fakeSendOutreach().send, volume: () => Promise.resolve(10) });
  if (!result.manifest) throw new Error(`expected a manifest, got ${result.status}: ${result.summary}`);
  return result.manifest;
}

const release = (send: FakeSend, text: string, flags = enabled) => {
  const command = parseReleaseCommand(text);
  if (!command) throw new Error(`not a release command: ${text}`);
  return releaseBatch({ db: env.DB, flags, kv: env.KV, send: send.send, config, actor: "operator:test", now: () => NOW }, command);
};

let manifest: Manifest;
beforeEach(async () => {
  manifest = await batch();
});

describe("the release command", () => {
  it("parses only the exact command form", () => {
    expect(parseReleaseCommand(`batch-release-${manifest.id}-${manifest.code}`)).toEqual({ manifestId: manifest.id, code: manifest.code });
    expect(parseReleaseCommand(`/batch-release-${manifest.id}-${manifest.code}`)).not.toBeNull();
    expect(parseReleaseCommand(`please batch-release-${manifest.id}-${manifest.code}`)).toBeNull();
    expect(parseReleaseCommand(`batch-release-${manifest.id}-zzzzzz`)).toBeNull();
  });

  it("refuses without a manifest and with a wrong code, and sends nothing", async () => {
    const send = fakeSendOutreach();
    const missing = await release(send, `batch-release-cb20000101-${manifest.code}`);
    expect(missing.ok).toBe(false);
    expect(missing.text).toMatch(/no approval manifest/);
    const wrongCode = manifest.code === "000000" ? "111111" : "000000";
    const wrong = await release(send, `batch-release-${manifest.id}-${wrongCode}`);
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toMatch(/does not match/);
    expect(send.calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status <> 'pending_approval'").first<{ n: number }>())?.n).toBe(0);
  });

  it("refuses while the cold batch is switched off, or when its flag cannot be read", async () => {
    const send = fakeSendOutreach();
    expect((await release(send, `batch-release-${manifest.id}-${manifest.code}`, flagReader({ "cold_batch:enabled": "false" }))).ok).toBe(false);
    expect((await release(send, `batch-release-${manifest.id}-${manifest.code}`, flagReader({}, ["*"]))).ok).toBe(false);
    expect(send.calls).toHaveLength(0);
  });

  it("refuses a draft edited after the manifest was written, and sends the rest with their digests", async () => {
    const [editedId, keptId] = Object.keys(manifest.entries);
    await env.DB.prepare("UPDATE drafts SET body = body || ?2 WHERE id = ?1").bind(editedId, "\n\nP.S. One more thing.").run();
    const send = fakeSendOutreach();
    const result = await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(result.refused).toEqual([{ draftId: editedId, reason: "the draft changed after the batch was put up for approval" }]);
    expect(send.items().map((i) => i.draftId)).toEqual([keptId]);
    const kept = await env.DB.prepare("SELECT recipient_email, subject, body FROM drafts WHERE id = ?1").bind(keptId).first<{ recipient_email: string; subject: string; body: string }>();
    expect(send.items()[0]?.approvedDigest).toBe(await draftDigest({ to: kept?.recipient_email, subject: kept?.subject, body: kept?.body }));
    expect(send.items()[0]?.approvedDigest).toBe(manifest.entries[keptId ?? ""]);
    expect((await env.DB.prepare("SELECT status FROM drafts WHERE id = ?1").bind(editedId).first<{ status: string }>())?.status).toBe("pending_approval");
  });

  it("refuses a draft whose contact replied, unsubscribed or was written to since it was drafted", async () => {
    const ids = Object.keys(manifest.entries);
    const drafts = await env.DB.prepare(`SELECT id, contact_id, recipient_email FROM drafts WHERE id IN ('${ids.join("','")}')`).all<{ id: string; contact_id: string; recipient_email: string }>();
    const [first, second] = drafts.results;
    await env.DB.prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification) VALUES ('in-rel-1', 'p', 'm-rel-1', ?1, ?2, 'unsubscribe')").bind(first?.recipient_email, "2026-11-09T14:00:00.000Z").run();
    await env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sent_at) VALUES ('os-rel-1', ?1, 'reply', 'p', ?2)").bind(second?.contact_id, "2026-11-09T14:00:00.000Z").run();
    const send = fakeSendOutreach();
    const result = await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(result.ok).toBe(false);
    expect(result.refused.map((r) => r.reason).sort()).toEqual(["mail from the contact arrived after this was drafted (a reply, an inquiry, an unsubscribe or mail not yet triaged)", "something was sent to the contact after this was drafted"]);
    expect(send.calls).toHaveLength(0);
  });

  it("refuses drafts at an account where someone complained or entered a conversation after drafting", async () => {
    await env.DB.prepare("INSERT INTO suppression (email_sha256, email, reason, source) VALUES (?1, 'angry@globex.example', 'complaint', 'test')").bind("a".repeat(64)).run();
    await env.DB.prepare("INSERT INTO deals (id, account_key, name, stage) VALUES ('deal-rel-1', 'northwind.example', 'Northwind', 'demo_scheduled')").run();
    const send = fakeSendOutreach();
    const result = await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(result.refused.map((r) => r.reason).sort()).toEqual(["someone at the account is now in a conversation", "someone at the account opted out or complained"]);
    expect(send.calls).toHaveLength(0);
  });

  it("refuses a draft whose contact sent mail not yet triaged", async () => {
    await env.DB.prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at) VALUES ('in-rel-2', 'p', 'm-rel-2', 'jane@globex.example', ?1)").bind("2026-11-09T14:00:00.000Z").run();
    const send = fakeSendOutreach();
    await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(send.items().map((i) => i.to)).toEqual(["ada@northwind.example"]);
  });

  it("refuses everything when the brain cannot be read whole, or readiness is RED", async () => {
    const send = fakeSendOutreach();
    const icp = await env.KV.get("brain:file:icp");
    await env.KV.put("brain:file:icp", `${icp ?? ""}\n## edited-after-lock\n- kind: who\n- text: Edited.\n`);
    expect((await release(send, `batch-release-${manifest.id}-${manifest.code}`)).text).toMatch(/brain could not be read whole/);
    await env.KV.put("brain:file:icp", icp ?? "");
    for (let i = 0; i < 30; i++) {
      await env.DB.prepare("INSERT INTO outreach_sends (id, account_key, send_path, provider, sent_at, bounced_at) VALUES (?1, 'old.example', 'cold', 'p', ?2, ?2)").bind(`os-red-rel-${i}`, "2026-11-09T12:00:00.000Z").run();
    }
    expect((await release(send, `batch-release-${manifest.id}-${manifest.code}`)).text).toMatch(/not released: Readiness RED/);
    expect(send.calls).toHaveLength(0);
  });

  it("refuses a draft older than 14 days", async () => {
    await env.DB.prepare("UPDATE drafts SET created_at = '2026-10-20T00:00:00.000Z'").run();
    const send = fakeSendOutreach();
    const result = await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(result.refused.every((r) => /older than 14 days/.test(r.reason))).toBe(true);
    expect(send.calls).toHaveLength(0);
  });

  it("hands each draft over once, however often the command is sent", async () => {
    const send = fakeSendOutreach();
    await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(send.items()).toHaveLength(2);
    expect(new Set(send.items().map((i) => i.idempotencyKey)).size).toBe(2);
  });

  it("keeps the claim when the send function throws, so nothing can go out twice", async () => {
    const throwing: FakeSend = { calls: [], items: () => [], send: () => Promise.reject(new Error("provider exploded")) };
    const first = await release(throwing, `batch-release-${manifest.id}-${manifest.code}`);
    expect(first.report?.unknown).toBe(2);
    const send = fakeSendOutreach();
    const second = await release(send, `batch-release-${manifest.id}-${manifest.code}`);
    expect(send.calls).toHaveLength(0);
    expect(second.report?.alreadyHandedOff).toBe(2);
  });
});
