// GTM-agents: tests that erasing a person removes their inbound mail and its bodies: mail they sent,
// mail naming them, and delivery reports about them. Every person and address is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eraseByHash, eraseContact } from "../src/data/erasure.ts";
import { recordInbound } from "../src/inbox/intake.ts";
import { inboundMessage } from "../src/inbox/testing.ts";
import { addressHash } from "../src/sending/suppression.ts";
import { NOW, config, insertContact, uid } from "./delivery-fakes.ts";

async function rowsFor(ids: string[]): Promise<Array<{ provider_message_id: string; body_key: string | null }>> {
  const { results } = await env.DB.prepare("SELECT provider_message_id, body_key FROM inbound_emails WHERE provider = 'erasure-inbox' AND provider_message_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .all<{ provider_message_id: string; body_key: string | null }>();
  return results;
}

describe("erasure of inbound mail", () => {
  it("deletes the rows and bodies of mail the person sent, mail that names them and reports about them, and keeps the rest", async () => {
    const person = await insertContact(env.DB);
    await env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sent_at) VALUES (?1, ?2, 'cold', 'test-esp', '2026-11-02T15:00:00.000Z')").bind(uid("send"), person.id).run();
    const [local, domain] = person.email.split("@");
    const sent = inboundMessage({ from: { email: `${local}+news@${domain}` }, text: "My reply." });
    const naming = inboundMessage({ from: { email: `${uid("jordan")}@${domain}` }, subject: `About ${person.email}`, text: "Forwarding this." });
    const report = inboundMessage({
      from: { email: "mailer-daemon@googlemail.example" },
      subject: "Delivery Status Notification (Failure)",
      text: "Not delivered.",
      deliveryReport: `Final-Recipient: rfc822; ${person.email}\nAction: failed\nStatus: 5.1.1\n`,
    });
    const unrelated = inboundMessage({ from: { email: `${uid("casey")}@initrode.example` }, text: "Unrelated." });
    const deps = { db: env.DB, bucket: env.BUCKET, config, provider: "erasure-inbox", now: NOW };
    expect((await recordInbound(deps, [sent, naming, report, unrelated])).recorded).toBe(4);
    const ids = [sent, naming, report, unrelated].map((m) => m.providerMessageId);
    const before = await rowsFor(ids);
    expect(before.every((r) => r.body_key !== null)).toBe(true);

    await eraseContact(env.DB, person.email, { source: "operator", bucket: env.BUCKET });
    const after = await rowsFor(ids);
    expect(after.map((r) => r.provider_message_id)).toEqual([unrelated.providerMessageId]);
    for (const row of before) {
      const body = await env.BUCKET.get(row.body_key ?? "");
      if (row.provider_message_id === unrelated.providerMessageId) expect(body).not.toBeNull();
      else expect(body, row.provider_message_id).toBeNull();
    }
  });

  it("touches no row when a body cannot be deleted, so the erasure can run again", async () => {
    const person = await insertContact(env.DB);
    const message = inboundMessage({ from: { email: person.email }, text: "Hello." });
    await recordInbound({ db: env.DB, bucket: env.BUCKET, config, provider: "erasure-inbox", now: NOW }, [message]);
    const failing = { delete: () => Promise.reject(new Error("R2 unavailable")) } as unknown as R2Bucket;
    await expect(eraseContact(env.DB, person.email, { source: "operator", bucket: failing })).rejects.toThrow(/R2 unavailable/);
    expect(await rowsFor([message.providerMessageId])).toHaveLength(1);
    expect(await env.DB.prepare("SELECT 1 AS hit FROM contacts WHERE id = ?1").bind(person.id).first()).not.toBeNull();
    await eraseContact(env.DB, person.email, { source: "operator", bucket: env.BUCKET });
    expect(await rowsFor([message.providerMessageId])).toHaveLength(0);
  });

  it("refuses to orphan bodies when no bucket is passed", async () => {
    const person = await insertContact(env.DB);
    const message = inboundMessage({ from: { email: person.email }, text: "Hello." });
    await recordInbound({ db: env.DB, bucket: env.BUCKET, config, provider: "erasure-inbox", now: NOW }, [message]);
    await expect(eraseContact(env.DB, person.email, { source: "operator" })).rejects.toThrow(/bucket/);
    expect(await rowsFor([message.providerMessageId])).toHaveLength(1);
  });

  it("removes mail a person sent when only their address hash is known", async () => {
    const address = `${uid("lee")}@umbrella.example`;
    const message = inboundMessage({ from: { email: address }, subject: "Pricing", text: "What does it cost?" });
    await recordInbound({ db: env.DB, bucket: env.BUCKET, config, provider: "erasure-inbox", now: NOW }, [message]);
    const [row] = await rowsFor([message.providerMessageId]);
    await eraseByHash(env.DB, await addressHash(address), { source: "product", bucket: env.BUCKET });
    expect(await rowsFor([message.providerMessageId])).toHaveLength(0);
    expect(await env.BUCKET.get(row?.body_key ?? "")).toBeNull();
  });

  it("removes delivery reports about an address known only by its hash", async () => {
    const address = `${uid("gone")}@initech.example`;
    const report = inboundMessage({ from: { email: "mailer-daemon@googlemail.example" }, subject: "Delivery Status Notification (Failure)", deliveryReport: `Final-Recipient: rfc822; ${address}\nAction: failed\nStatus: 5.1.1\n` });
    await recordInbound({ db: env.DB, bucket: env.BUCKET, config, provider: "erasure-inbox", now: NOW }, [report]);
    const [row] = await rowsFor([report.providerMessageId]);
    await eraseByHash(env.DB, await addressHash(address), { source: "product", bucket: env.BUCKET });
    expect(await rowsFor([report.providerMessageId])).toHaveLength(0);
    expect(await env.BUCKET.get(row?.body_key ?? "")).toBeNull();
  });
});
