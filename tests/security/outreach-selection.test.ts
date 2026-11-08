// GTM-agents: who the cold batch may never write to. Suppressed and opted-out contacts are never
// selected, and neither is anyone at an account where someone opted out or complained, nor anyone at
// an account already in a conversation. Every person and company is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "@gtm-agents/core/config";
import { addSuppression } from "@gtm-agents/core/sending";
import { runColdBatch } from "@gtm-agents/core/outreach";
import { fakeSendOutreach, flagReader, resetOutreachTables, seedContact, silentLogger, templateFile, uploadOutreachBrain, uploadTemplates } from "@gtm-agents/core/outreach/testing";

const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests in CI." } },
  agent: { name: "Avery" },
  sending: { from: { email: "avery@outreach.acme.example" }, replyTo: "avery@acme.example", supportAddress: "support@acme.example", postalAddress: "Acme Inc., 100 Example Street, Springfield", domain: "outreach.acme.example" },
});

beforeEach(async () => {
  await resetOutreachTables(env.DB);
  await uploadOutreachBrain(env.KV);
  await uploadTemplates(env.KV, [templateFile("cold-intro")]);
});

async function draftedAddresses(): Promise<string[]> {
  const result = await runColdBatch({
    db: env.DB,
    kv: env.KV,
    flags: flagReader({ "cold_batch:enabled": "true", "outreach:holdout_rate": "0" }),
    config,
    now: new Date("2026-11-09T13:00:00.000Z"),
    job: "cold_batch",
    log: silentLogger,
    send: fakeSendOutreach().send,
    volume: () => Promise.resolve(50),
  });
  expect(["manual", "empty"]).toContain(result.status);
  const { results } = await env.DB.prepare("SELECT recipient_email FROM drafts ORDER BY recipient_email").all<{ recipient_email: string }>();
  return results.map((r) => r.recipient_email);
}

describe("selection never reaches people who must not be emailed", () => {
  it("skips suppressed addresses, subaddresses of suppressed mailboxes, opted-out contacts and erased people", async () => {
    await seedContact(env.DB, { first: "Ok", email: "ok@fine.example", accountName: "Fine Industries" });
    await seedContact(env.DB, { first: "Bounced", email: "bounced@bounce.example", accountName: "Bounce Industries" });
    await addSuppression(env.DB, { email: "bounced@bounce.example", reason: "bounce", source: "test" });
    await seedContact(env.DB, { first: "Tagged", email: "tagged+news@tag.example", accountName: "Tag Industries" });
    await addSuppression(env.DB, { email: "tagged@tag.example", reason: "manual", source: "test" });
    const lifecycle = await seedContact(env.DB, { first: "Life", email: "life@lifecycle.example", accountName: "Lifecycle Industries" });
    await env.DB.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, 'opted_out')").bind(lifecycle).run();
    expect(await draftedAddresses()).toEqual(["ok@fine.example"]);
  });

  it("skips every colleague at an account where someone opted out or complained", async () => {
    await seedContact(env.DB, { first: "Ok", email: "ok@fine.example", accountName: "Fine Industries" });
    // An opt-out on the suppression list, by a known contact.
    await seedContact(env.DB, { first: "Quit", email: "quit@globex.example", accountName: "Globex Corporation", warmth: "contacted" });
    await addSuppression(env.DB, { email: "quit@globex.example", reason: "opt_out", source: "test" });
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    // A complaint from someone who is not a contact.
    await addSuppression(env.DB, { email: "angry@initrode.example", reason: "complaint", source: "test" });
    await seedContact(env.DB, { first: "Sam", email: "sam@initrode.example", accountName: "Initrode Corporation" });
    // An opt-out recorded only on the contact's warmth.
    await seedContact(env.DB, { first: "Gone", email: "gone@hooli.example", accountName: "Hooli Systems", warmth: "opted_out" });
    await seedContact(env.DB, { first: "Ada", email: "ada@hooli.example", accountName: "Hooli Systems" });
    expect(await draftedAddresses()).toEqual(["ok@fine.example"]);
  });

  it("skips every colleague at an account already in a conversation", async () => {
    await seedContact(env.DB, { first: "Ok", email: "ok@fine.example", accountName: "Fine Industries" });
    await seedContact(env.DB, { first: "Warm", email: "warm@globex.example", accountName: "Globex Corporation", warmth: "engaged" });
    await seedContact(env.DB, { first: "Jane", email: "jane@globex.example", accountName: "Globex Corporation" });
    await env.DB.prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, classification) VALUES ('in-sec-1', 'p', 'm-sec-1', 'replier@initrode.example', ?1, 'reply')").bind("2026-11-01T00:00:00.000Z").run();
    await seedContact(env.DB, { first: "Sam", email: "sam@initrode.example", accountName: "Initrode Corporation" });
    expect(await draftedAddresses()).toEqual(["ok@fine.example"]);
  });
});
