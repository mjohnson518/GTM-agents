// GTM-agents: the chat consumer routes sequence commands without the model, once per message, and
// a released follow-up goes out through the email provider the deployment wired in. Every person,
// company and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import type { Env } from "../src/env.ts";
import { processChatMessage, type OperatorAgentOptions } from "../src/operator/chat.ts";
import { releaseCommand } from "../src/outreach/manifest.ts";
import { flagReader, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "../src/outreach/testing.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { fakeEmailProvider } from "../src/sending/testing.ts";
import { createSequenceSender } from "../src/sequences/sender.ts";
import { runFollowUpSweep } from "../src/sequences/sweep.ts";
import { ACME_SEQUENCE_TEMPLATES, resetSequenceTables, seedFirstTouch, withMessageIds } from "../src/sequences/testing.ts";
import { acmeConfig } from "./fixtures.ts";
import { BASE_URL, NOW, SIGNING_KEY } from "./delivery-fakes.ts";

const db = env.DB;
const OPERATOR = "4249001";
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] } });

describe("sequence commands in the operator chat", () => {
  let contactId: string;
  let provider: ReturnType<typeof fakeEmailProvider> & ReturnType<typeof withMessageIds>;
  let operator: ReturnType<typeof recordingOperator>;
  let chatEnv: Env;
  let options: OperatorAgentOptions;
  let updates = 0;

  beforeEach(async () => {
    await resetSequenceTables(db);
    await uploadOutreachBrain(env.KV);
    await uploadTemplates(env.KV, [templateFile("cold-intro"), ...ACME_SEQUENCE_TEMPLATES]);
    await env.KV.put("operator:agent_enabled", "true");
    await env.KV.put("sequences:enabled", "true");
    await env.KV.put("inbox:enabled", "true");
    await env.KV.put("sequences:reply_intake", "routed");
    await env.KV.put(DELIVERY_FLAGS.enabled, "true");
    provider = withMessageIds(fakeEmailProvider({ name: "fake-esp-chat", now: () => NOW }));
    operator = recordingOperator();
    contactId = await seedContact(db, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await seedFirstTouch(db, { campaignId: "cb20261101", contactId, provider: provider.name, sentAt: new Date(NOW.getTime() - 3 * 86_400_000 - 3_600_000) });
    chatEnv = { ...(env as unknown as Env), UNSUBSCRIBE_SIGNING_KEY: SIGNING_KEY, AGENT_BASE_URL: BASE_URL };
    options = {
      config,
      operator: () => operator.channel,
      model: () => {
        throw new Error("the model must never see a sequence command");
      },
      email: () => provider,
      now: () => NOW,
    };
  });

  const say = async (text: string, updateId = `u-seq-${(updates += 1)}`) => {
    await processChatMessage(options, chatEnv, { updateId, chatId: OPERATOR, userId: OPERATOR, sessionKey: `s-${OPERATOR}`, text });
    return operator.messages.at(-1)?.text ?? "";
  };

  it("releases waiting follow-ups through the wired email provider, and a redelivered message does not run twice", async () => {
    const { manifest } = await runFollowUpSweep({
      db,
      kv: env.KV,
      flags: flagReader({ "sequences:enabled": "true", "inbox:enabled": "true", "sequences:reply_intake": "routed" }),
      config,
      now: NOW,
      job: "sequence_sweep",
      log: silentLogger,
      send: createSequenceSender({ db, kv: memoryKv({ [DELIVERY_FLAGS.enabled]: "true" }), config, provider, unsubscribeSigningKey: SIGNING_KEY, baseUrl: BASE_URL, now: () => NOW }),
      provider,
    });
    const command = releaseCommand(manifest ?? { id: "", code: "", kind: "sequence" });
    expect(await say(command, "u-seq-release")).toMatch(/1 of 1 released\. 1 sent/);
    expect(provider.messages()).toHaveLength(1);
    const before = operator.messages.length;
    await say(command, "u-seq-release");
    expect(operator.messages).toHaveLength(before);
    expect(provider.messages()).toHaveLength(1);
  });

  it("resumes a paused sequence without the model", async () => {
    await db.prepare("UPDATE campaign_contacts SET sequence_paused_at = ?1, sequence_pause_reason = 'a test pause'").bind(NOW.toISOString()).run();
    expect(await say(`sequence-resume-${contactId}`)).toMatch(/Resumed 1 sequence/);
    expect((await db.prepare("SELECT sequence_paused_at FROM campaign_contacts").first<{ sequence_paused_at: string | null }>())?.sequence_paused_at).toBeNull();
  });

  it("refuses a release when no email provider is wired into the chat", async () => {
    delete options.email;
    expect(await say("sequence-release-sq202611041700abcd-1a2b3c")).toMatch(/No send function is configured for follow-up steps/);
  });
});
