// GTM-agents: contract and behavior tests for the email-cloudflare adapter, with synthetic raw
// messages as Cloudflare Email Routing delivers them. Every person and address is invented.
import { describe, expect, it } from "vitest";
import { testContext } from "../_contract/context.ts";
import { recordedFetch } from "../_contract/fetch.ts";
import { runInboxProviderContract } from "../_contract/inbox-provider.ts";
import { createAdapter, NAME } from "./index.ts";
import manifest from "./manifest.json";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const crlf = (lines: string[]) => lines.join("\r\n");

const reply = crlf([
  "From: Riley Example <riley@prospect.example>",
  "To: avery@acme.example",
  "Subject: Re: Flaky builds at Prospect",
  "Message-ID: <reply-2@prospect.example>",
  "In-Reply-To: <first-2@acme.example>",
  "References: <root-2@acme.example> <first-2@acme.example>",
  "Date: Wed, 04 Nov 2026 11:00:00 +0000",
  "Received: from mail.prospect.example",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Sounds good, send times.",
  "--alt",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<p>Sounds good, <b>send times</b>.</p>",
  "--alt--",
  "",
]);

const htmlOnly = crlf([
  "From: jordan@globex.example",
  "To: avery@acme.example",
  "Subject: Question",
  "Message-ID: <html-2@globex.example>",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<div>Hello <b>Acme</b></div><script>steal()</script><p>Jordan &amp; team</p>",
  "",
]);

const bounce = crlf([
  "From: Mail Delivery System <MAILER-DAEMON@mx.acme-mail.example>",
  "To: avery@acme.example",
  "Subject: Undelivered Mail Returned to Sender",
  "Message-ID: <bounce-2@mx.acme-mail.example>",
  "Auto-Submitted: auto-replied",
  "MIME-Version: 1.0",
  'Content-Type: multipart/report; report-type=delivery-status; boundary="rep"',
  "",
  "--rep",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "I'm sorry to have to inform you that your message could not be delivered.",
  "--rep",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns; mx.acme-mail.example",
  "",
  "Final-Recipient: rfc822; old.contact@initech.example",
  "Action: failed",
  "Status: 5.1.1",
  "",
  "--rep",
  "Content-Type: message/rfc822",
  "",
  "From: avery@acme.example",
  "To: old.contact@initech.example",
  "Subject: Hello",
  "",
  "original text",
  "--rep--",
  "",
]);

const noMessageId = crlf(["From: casey@initrode.example", "To: avery@acme.example", "Subject: No id here", "", "Just a note.", ""]);

function context(options: Record<string, unknown> = {}) {
  const recorded = recordedFetch([]);
  return { ctx: testContext({ fetch: recorded.fetch, now: NOW, options }), calls: recorded.calls };
}

runInboxProviderContract((ctx) => createAdapter(ctx), {
  manifest,
  context: () => context(),
  unconfigured: () => context(),
  inbound: {
    reply: { raw: reply, from: "riley@prospect.example", to: "avery@acme.example", expect: { providerMessageId: "<reply-2@prospect.example>", text: "Sounds good, send times.", isFromUs: false, inReplyTo: "<first-2@acme.example>", headers: { "message-id": "<reply-2@prospect.example>" } } },
    htmlOnly: { raw: htmlOnly, from: "jordan@globex.example", to: "avery@acme.example", expect: { providerMessageId: "<html-2@globex.example>", textExcludes: ["<div>", "<b>", "steal()", "&amp;"] } },
    bounce: { raw: bounce, from: "", to: "avery@acme.example", expect: { providerMessageId: "<bounce-2@mx.acme-mail.example>", deliveryReportIncludes: "Final-Recipient: rfc822; old.contact@initech.example" } },
    noMessageId: { raw: noMessageId, from: "casey@initrode.example", to: "avery@acme.example" },
  },
});

describe("email-cloudflare", () => {
  it("threads by the root of References, and stamps the arrival time, not the Date header", async () => {
    const message = await createAdapter(context().ctx).parseRouted({ raw: reply, from: "riley@prospect.example", to: "avery@acme.example" });
    expect(message.threadId).toBe("<root-2@acme.example>");
    expect(message.references).toEqual(["<root-2@acme.example>", "<first-2@acme.example>"]);
    expect(message.receivedAt).toBe(NOW.toISOString());
    expect(message.from).toEqual({ email: "riley@prospect.example", name: "Riley Example" });
    expect(message.headers).toEqual({ "message-id": "<reply-2@prospect.example>", "in-reply-to": "<first-2@acme.example>", references: "<root-2@acme.example> <first-2@acme.example>", "content-type": 'multipart/alternative; boundary="alt"' });
  });

  it("derives clean text from HTML-only mail", async () => {
    const message = await createAdapter(context().ctx).parseRouted({ raw: htmlOnly, from: "jordan@globex.example", to: "avery@acme.example" });
    expect(message.text).toBe("Hello Acme\nJordan & team");
  });

  it("keeps the returned message's headers, not its body, in a delivery report", async () => {
    const message = await createAdapter(context().ctx).parseRouted({ raw: bounce, from: "", to: "avery@acme.example" });
    expect(message.deliveryReport).toContain("Status: 5.1.1");
    expect(message.deliveryReport).toContain("To: old.contact@initech.example");
    expect(message.deliveryReport).not.toContain("original text");
    expect(message.headers["auto-submitted"]).toBe("auto-replied");
  });

  it("marks the deployment's own addresses, and keys a message without a Message-ID by its content", async () => {
    const adapter = createAdapter(context({ ownAddresses: ["Casey@Initrode.example"] }).ctx);
    const message = await adapter.parseRouted({ raw: noMessageId, from: "casey@initrode.example", to: "avery@acme.example" });
    expect(message.isFromUs).toBe(true);
    expect(message.providerMessageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    const other = await adapter.parseRouted({ raw: noMessageId.replace("Just a note.", "Another note."), from: "casey@initrode.example", to: "avery@acme.example" });
    expect(other.providerMessageId).not.toBe(message.providerMessageId);
  });

  it("reads a raw stream and refuses a message over its size limit", async () => {
    const adapter = createAdapter(context({ maxBytes: 200 }).ctx);
    const stream = new Response(noMessageId).body as ReadableStream<Uint8Array>;
    expect((await adapter.parseRouted({ raw: stream, from: "casey@initrode.example", to: "avery@acme.example" })).subject).toBe("No id here");
    await expect(adapter.parseRouted({ raw: reply, from: "riley@prospect.example", to: "avery@acme.example" })).rejects.toMatchObject({ code: "invalid", retryable: false });
    await expect(adapter.parseRouted({ raw: "x", rawSize: 10_000, from: "a@b.example", to: "c@d.example" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("is named for its manifest", () => {
    expect(NAME).toBe(manifest.name);
  });
});
