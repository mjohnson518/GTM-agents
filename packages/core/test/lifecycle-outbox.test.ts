// GTM-agents: lifecycle follow-ups and the operator outbox: an approval binds to what was shown, so a
// preview the outbox holds is never recorded as shown, and the preview fu-approve shows of a changed
// follow-up is a reply the outbox never holds. Synthetic contacts on *.example; no network.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator, memoryKv } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { parseFollowupCommand, runFollowupCommand } from "../src/lifecycle/followup-commands.ts";
import { runLifecycleFollowups } from "../src/lifecycle/followups.ts";
import { flagReader, resetOutreachTables, silentLogger } from "../src/outreach/testing.ts";
import { createOutreachSender } from "../src/sending/boundary.ts";
import { withOperatorOutbox } from "../src/operator/outbox.ts";
import { NOW, harness, insertContact } from "./delivery-fakes.ts";
import { acmeConfig } from "./fixtures.ts";
import type { ModelGateway } from "../src/ports/model.ts";

const db = env.DB;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const CHAT = "4249001";
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: [CHAT], allowedUserIds: [CHAT] }, models: { roles: { classifier: "test-classifier" }, pricing: { "test-classifier": { inputCentsPerMTok: 10, outputCentsPerMTok: 40 } } } });
const ON = { "lifecycle:enabled": "true", "lifecycle:followups_enabled": "true" };
const T = (id: string, subject: string, body: string) => ({ id, meta: { id, kind: "lifecycle", status: "approved", angle: "none", subject, volume_weight: 1 }, subject, body, sha256: "0".repeat(64) });
const TEMPLATES = [T("lifecycle-first-use", "Getting started with Acme Quarantine", "Hi {{first_name}},\n\nThanks for signing up for Acme Quarantine. The quickest way to see it work is to connect one CI pipeline and let it watch a few runs.\n\nIf anything gets in the way, just reply and I will help you get set up.\n\n{{sender_name}}")];
const model: ModelGateway = { name: "fake", complete: () => Promise.resolve({ text: "yes", toolCalls: [], stopReason: "end", usage: { inputTokens: 40, outputTokens: 1 }, model: "test-classifier" }), embed: () => Promise.resolve({ vectors: [], model: "none" }) };
const spend = { allow: () => Promise.resolve(true), recordModel: () => Promise.resolve() };

beforeEach(async () => {
  await db.prepare("DELETE FROM lifecycle_followups").run();
  await db.prepare("DELETE FROM operator_outbox").run();
  await resetOutreachTables(db);
});

/** The outbox, on, with quiet hours covering NOW. */
const quietOutbox = (channel: ReturnType<typeof recordingOperator>["channel"]) => {
  const kv = memoryKv({ "operator:outbox_enabled": "true" });
  return withOperatorOutbox(channel, { db, flags: { get: (k) => kv.get(k) }, quietHours: { start: 0, end: 23, timeZone: "UTC" }, now: () => NOW });
};

async function signedUp(): Promise<string> {
  const contact = await insertContact(db, { warmth: "hot" });
  await db.prepare("INSERT INTO contact_lifecycle (contact_id, state, state_changed_at, signed_up_at) VALUES (?1, 'signed_up', ?2, ?2)").bind(contact.id, ago(25 * HOUR)).run();
  return contact.id;
}

describe("a lifecycle follow-up with the operator outbox on", () => {
  it("is never approved for a version the outbox held: fu-approve shows the changed version at once", async () => {
    const h = harness(db);
    const raw = recordingOperator();
    const contactId = await signedUp();
    await runLifecycleFollowups({ db, flags: flagReader(ON), config, now: NOW, log: silentLogger, templates: () => Promise.resolve(TEMPLATES as never), model, spend, send: createOutreachSender(h.deps), operator: raw.channel, chatId: CHAT });
    const id = (await db.prepare("SELECT id FROM lifecycle_followups WHERE contact_id = ?1").bind(contactId).first<{ id: string }>())?.id ?? "";
    await db.prepare("UPDATE drafts SET body = body || ' Edited since.' WHERE contact_id = ?1").bind(contactId).run();
    const before = raw.messages.length;
    const cmd = (t: string) =>
      runFollowupCommand({ db, flags: flagReader(ON), config, send: createOutreachSender(h.deps), operator: quietOutbox(raw.channel), chatId: CHAT, userId: CHAT, now: () => NOW }, parseFollowupCommand(t) ?? ({} as never));
    expect(await cmd(`fu-approve-${id}`)).toContain("review the version above");
    // The preview answered the command, so it went out in quiet hours, and nothing was held.
    expect(raw.messages.slice(before).some((m) => m.text.includes("Edited since."))).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM operator_outbox WHERE status = 'held'").first<{ n: number }>())?.n).toBe(0);
    expect(await cmd(`fu-approve-${id}`)).toContain("Sent");
  });

  it("does not record a preview the sweep's notice left held as shown", async () => {
    const h = harness(db);
    const raw = recordingOperator();
    const contactId = await signedUp();
    await runLifecycleFollowups({ db, flags: flagReader(ON), config, now: NOW, log: silentLogger, templates: () => Promise.resolve(TEMPLATES as never), model, spend, send: createOutreachSender(h.deps), operator: quietOutbox(raw.channel), chatId: CHAT });
    expect(raw.messages).toEqual([]);
    expect(await db.prepare("SELECT status, shown_digest FROM lifecycle_followups WHERE contact_id = ?1").bind(contactId).first()).toEqual({ status: "drafted", shown_digest: null });
  });
});
