// GTM-agents: contract and behavior tests for the inbox-gmail adapter, against a recorded, synthetic
// Gmail mailbox. Acme, its people, addresses, ids and tokens are invented; nothing reaches the network.
import { createToolRegistry } from "@gtm-agents/core/security";
import { runSecurityContract } from "@gtm-agents/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { clearGoogleTokenCache } from "../_google-auth/index.ts";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { runInboxProviderContract, type WrittenMessage } from "../_contract/inbox-provider.ts";
import { createAdapter, gmailError, parseCursor } from "./index.ts";
import { buildRawMessage, decodeEncodedWords, decodePayload } from "./mime.ts";
import manifest from "./manifest.json";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Low-entropy synthetic credentials, so no scanner mistakes them for real ones.
const SECRETS = { GOOGLE_CLIENT_ID: "acme-test-client.apps.example", GOOGLE_CLIENT_SECRET: "s".repeat(24), GMAIL_REFRESH_TOKEN: "r".repeat(40) };
const TOPIC = "projects/acme-gtm-test/topics/gmail-push";
const E_ACUTE = String.fromCharCode(0xe9);

const enc = new TextEncoder();
function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const h = (name: string, value: string) => ({ name, value });

// The mailbox. m-100 is ours (sent), m-101 a reply, m-102 HTML-only in windows-1252, m-103 a
// delivery status notification, m-105 a reply whose text Gmail did not inline.
const messages: Record<string, unknown> = {
  "m-100": {
    id: "m-100",
    threadId: "t-1",
    labelIds: ["SENT"],
    internalDate: String(Date.parse("2026-11-02T09:00:00.000Z")),
    payload: { mimeType: "text/plain", headers: [h("From", "Avery at Acme <avery@acme.example>"), h("To", "riley@prospect.example"), h("Subject", "Flaky builds at Prospect"), h("Message-ID", "<first-1@acme.example>")], body: { data: b64url("Hi Riley, a short note.") } },
  },
  "m-101": {
    id: "m-101",
    threadId: "t-1",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.parse("2026-11-04T10:00:00.000Z")),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        h("From", '"Riley Example" <riley@prospect.example>'),
        h("To", "avery@acme.example"),
        h("Subject", "Re: Flaky builds at Prospect"),
        h("Message-ID", "<reply-1@prospect.example>"),
        h("In-Reply-To", "<first-1@acme.example>"),
        h("References", "<first-1@acme.example>"),
        h("Received", "from mail.prospect.example"),
      ],
      parts: [
        { mimeType: "text/plain", headers: [h("Content-Type", "text/plain; charset=UTF-8")], body: { data: b64url("Thanks, tell me more.\n\nOn Mon, Nov 2, 2026 Avery wrote:\n> Hi Riley") } },
        { mimeType: "text/html", headers: [h("Content-Type", "text/html; charset=UTF-8")], body: { data: b64url("<p>Thanks, <b>tell me more</b>.</p>") } },
      ],
    },
  },
  "m-102": {
    id: "m-102",
    threadId: "t-2",
    labelIds: ["INBOX"],
    internalDate: String(Date.parse("2026-11-04T11:00:00.000Z")),
    payload: {
      mimeType: "text/html",
      headers: [h("From", "=?UTF-8?B?Sm9yZGFuIENsYXJr?= <jordan@globex.example>"), h("To", "avery@acme.example"), h("Subject", "=?UTF-8?Q?Question_about_pricing?="), h("Content-Type", "text/html; charset=windows-1252")],
      body: { data: b64url(Uint8Array.from([...enc.encode("<div>Meet at the caf"), 0xe9, ...enc.encode("?</div><script>steal()</script><p>Jordan &amp; team</p>")])) },
    },
  },
  "m-103": {
    id: "m-103",
    threadId: "t-3",
    labelIds: ["INBOX"],
    internalDate: String(Date.parse("2026-11-04T11:30:00.000Z")),
    payload: {
      mimeType: "multipart/report",
      headers: [
        h("From", "Mail Delivery Subsystem <mailer-daemon@googlemail.example>"),
        h("To", "avery@acme.example"),
        h("Subject", "Delivery Status Notification (Failure)"),
        h("X-Failed-Recipients", "old.contact@initech.example"),
        h("Content-Type", 'multipart/report; report-type=delivery-status; boundary="b1"'),
        h("Auto-Submitted", "auto-replied"),
      ],
      parts: [
        { mimeType: "text/plain", headers: [h("Content-Type", "text/plain; charset=UTF-8")], body: { data: b64url("Your message wasn't delivered to old.contact@initech.example.") } },
        { mimeType: "message/delivery-status", headers: [h("Content-Type", "message/delivery-status")], body: { data: b64url("Reporting-MTA: dns; googlemail.example\n\nFinal-Recipient: rfc822; old.contact@initech.example\nAction: failed\nStatus: 5.1.1\n") } },
        { mimeType: "message/rfc822", headers: [h("Content-Type", "message/rfc822")], parts: [{ mimeType: "text/plain", headers: [h("From", "avery@acme.example"), h("To", "old.contact@initech.example"), h("Subject", "Hello")], body: { data: b64url("original text") } }] },
      ],
    },
  },
  "m-105": {
    id: "m-105",
    threadId: "t-5",
    labelIds: ["INBOX"],
    internalDate: String(Date.parse("2026-11-04T11:45:00.000Z")),
    payload: {
      mimeType: "multipart/mixed",
      headers: [h("From", "casey@initrode.example"), h("To", "avery@acme.example"), h("Subject", "Long note")],
      parts: [
        { mimeType: "text/plain", headers: [h("Content-Type", "text/plain; charset=UTF-8")], body: { size: 40, attachmentId: "att-1" } },
        { mimeType: "application/pdf", filename: "deck.pdf", headers: [h("Content-Disposition", "attachment; filename=deck.pdf")], body: { size: 9000, attachmentId: "att-2" } },
      ],
    },
  },
};

const history = [
  { id: "1001", messagesAdded: [{ message: { id: "m-101", threadId: "t-1", labelIds: ["INBOX", "UNREAD"] } }] },
  { id: "1002", messagesAdded: [{ message: { id: "m-100", threadId: "t-1", labelIds: ["SENT", "INBOX"] } }] },
  { id: "1003", messagesAdded: [{ message: { id: "m-102", threadId: "t-2", labelIds: ["INBOX"] } }] },
];

const draftMessage = {
  id: "dm-1",
  threadId: "t-1",
  payload: { mimeType: "text/plain", headers: [h("To", "riley@prospect.example"), h("Subject", "Re: Flaky builds at Prospect"), h("In-Reply-To", "<reply-1@prospect.example>"), h("References", "<first-1@acme.example> <reply-1@prospect.example>")], body: { data: b64url("Old text") } },
};

let sendCount = 0;
function mailboxRoutes(): RecordedRoute[] {
  return [
    { method: "POST", url: TOKEN_URL, respond: () => json({ access_token: "test-access-token", expires_in: 3599, token_type: "Bearer" }) },
    {
      method: "GET",
      url: /\/users\/me\/history\?/,
      respond: (request) => {
        const start = BigInt(new URL(request.url).searchParams.get("startHistoryId") ?? "0");
        if (start < 1000n) return json({ error: { code: 404, errors: [{ reason: "notFound" }], status: "NOT_FOUND" } }, { status: 404 });
        return json({ history: history.filter((r) => BigInt(r.id) > start), historyId: "1010" });
      },
    },
    { method: "GET", url: `${API}/profile`, respond: json({ emailAddress: "avery@acme.example", historyId: "1010" }) },
    { method: "GET", url: /\/users\/me\/messages\?q=/, respond: json({ messages: [{ id: "m-105" }, { id: "m-103" }, { id: "m-102" }, { id: "m-101" }], resultSizeEstimate: 4 }) },
    { method: "GET", url: `${API}/messages/m-105/attachments/att-1`, respond: json({ size: 40, data: b64url("This is the long note's text.") }) },
    {
      method: "GET",
      url: /\/users\/me\/messages\/m-\d+\?format=full$/,
      respond: (request) => {
        const id = /messages\/(m-\d+)/.exec(request.url)?.[1] ?? "";
        return messages[id] ? json(messages[id]) : json({ error: { code: 404 } }, { status: 404 });
      },
    },
    { method: "GET", url: `${API}/threads/t-1?format=full`, respond: json({ id: "t-1", messages: [messages["m-100"], messages["m-101"]] }) },
    { method: "POST", url: `${API}/drafts`, respond: json({ id: "d-new", message: { id: "dm-2", threadId: "t-1" } }) },
    { method: "GET", url: `${API}/drafts/d-existing?format=full`, respond: json({ id: "d-existing", message: draftMessage }) },
    { method: "GET", url: `${API}/drafts/d-existing?format=minimal`, respond: json({ id: "d-existing", message: { id: "dm-1" } }) },
    { method: "GET", url: `${API}/drafts/d-missing?format=minimal`, respond: json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 }) },
    { method: "PUT", url: `${API}/drafts/d-existing`, respond: json({ id: "d-existing", message: { id: "dm-3", threadId: "t-1" } }) },
    { method: "DELETE", url: `${API}/drafts/d-existing`, respond: new Response(null, { status: 204 }) },
    { method: "DELETE", url: `${API}/drafts/d-missing`, respond: json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 }) },
    { method: "POST", url: `${API}/messages/send`, respond: () => json({ id: `s-${(sendCount += 1)}`, threadId: "t-1", labelIds: ["SENT"] }) },
    { method: "POST", url: `${API}/watch`, respond: json({ historyId: "1010", expiration: String(NOW.getTime() + 7 * 86_400_000) }) },
  ];
}

function context(routes: RecordedRoute[] = mailboxRoutes(), secrets: Record<string, string> = SECRETS, options: Record<string, unknown> = { pubsubTopic: TOPIC, address: "avery@acme.example" }) {
  const recorded = recordedFetch(routes);
  return { ctx: testContext({ secrets, fetch: recorded.fetch, now: NOW, options }), calls: recorded.calls };
}

/** Decode the raw RFC 5322 message a draft or send request carried. */
async function written(request: Request): Promise<WrittenMessage> {
  const body = await request.clone().json<Record<string, unknown>>();
  const message = (body.message as Record<string, unknown> | undefined) ?? body;
  const rawText = new TextDecoder().decode(Uint8Array.from(atob(String(message.raw).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  const split = rawText.indexOf("\r\n\r\n");
  const head = rawText.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const encoded = rawText.slice(split + 4).replace(/\r\n/g, "");
  const text = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  return { headers, text, html: /html|multipart/i.test(headers["content-type"] ?? ""), ...(typeof message.threadId === "string" ? { threadId: message.threadId } : {}) };
}

beforeEach(() => clearGoogleTokenCache());

runInboxProviderContract((ctx) => createAdapter(ctx), {
  manifest,
  context: () => context(),
  unconfigured: () => context(mailboxRoutes(), {}),
  listing: {
    cursor: "h:1000",
    newIds: ["m-101", "m-102"],
    expiredCursor: "h:5",
    isMessageFetch: (r) => /\/messages\/m-\d+\?format=full$/.test(r.url),
    failingFetch: () => context([{ method: "GET", url: /\/messages\/m-\d+\?format=full$/, respond: json({ error: { code: 500 } }, { status: 500 }) }, ...mailboxRoutes()]),
    window: [
      { providerMessageId: "m-101", text: "Thanks, tell me more.\n\nOn Mon, Nov 2, 2026 Avery wrote:\n> Hi Riley", isFromUs: false, headers: { "message-id": "<reply-1@prospect.example>", "in-reply-to": "<first-1@acme.example>" } },
      { providerMessageId: "m-102", textExcludes: ["<div>", "<p>", "steal()", "&amp;"], isFromUs: false },
      { providerMessageId: "m-103", deliveryReportIncludes: "Final-Recipient: rfc822; old.contact@initech.example", headers: { "x-failed-recipients": "old.contact@initech.example" } },
      { providerMessageId: "m-105", text: "This is the long note's text." },
    ],
  },
  thread: { id: "t-1", messageIds: ["m-100", "m-101"], fromUs: ["m-100"] },
  drafts: { existingId: "d-existing", missingId: "d-missing", written, isDraftWrite: (r) => /\/drafts(\/d-existing)?$/.test(r.url) && (r.method === "POST" || r.method === "PUT") },
  send: {
    written,
    isSend: (r) => r.url === `${API}/messages/send`,
    refusing: () => ({
      ...context([mailboxRoutes()[0] as RecordedRoute, { method: "POST", url: `${API}/messages/send`, respond: json({ error: { code: 400, errors: [{ reason: "invalidArgument" }] } }, { status: 400 }) }]),
      code: "invalid",
      retryable: false,
    }),
  },
});

describe("inbox-gmail", () => {
  it("passes the security contract with its manifest's tools", async () => {
    await runSecurityContract(createToolRegistry({ manifests: [manifest] }));
  });

  it("decodes the HTML-only body in its own charset, with tags, scripts and entities removed", async () => {
    const { ctx } = context();
    const page = await createAdapter(ctx).listNew({ since: "2026-11-01T00:00:00.000Z", limit: 10 });
    const html = page.items.find((m) => m.providerMessageId === "m-102");
    expect(html?.text).toBe(`Meet at the caf${E_ACUTE}?\nJordan & team`);
    expect(html?.from).toEqual({ email: "jordan@globex.example", name: "Jordan Clark" });
    expect(html?.subject).toBe("Question about pricing");
  });

  it("keeps only the triage headers, and reads threading ids", async () => {
    const { ctx } = context();
    const page = await createAdapter(ctx).listNew({ cursor: "h:1000", limit: 10 });
    const reply = page.items.find((m) => m.providerMessageId === "m-101");
    expect(reply?.headers).toEqual({ "message-id": "<reply-1@prospect.example>", "in-reply-to": "<first-1@acme.example>", references: "<first-1@acme.example>" });
    expect(reply?.inReplyTo).toBe("<first-1@acme.example>");
    expect(reply?.references).toEqual(["<first-1@acme.example>"]);
    expect(reply?.threadId).toBe("t-1");
    expect(reply?.receivedAt).toBe("2026-11-04T10:00:00.000Z");
  });

  it("marks an unsent draft on a thread, so reply handling never takes it for a sent reply", async () => {
    const draft = { id: "m-199", threadId: "t-9", labelIds: ["DRAFT"], internalDate: String(Date.parse("2026-11-05T09:00:00.000Z")), payload: { mimeType: "text/plain", headers: [h("From", "avery@acme.example"), h("To", "riley@prospect.example"), h("Subject", "Re: Flaky builds")], body: { data: b64url("Draft reply") } } };
    const { ctx } = context([{ method: "GET", url: `${API}/threads/t-9?format=full`, respond: json({ id: "t-9", messages: [messages["m-100"], messages["m-101"], draft] }) }, ...mailboxRoutes()]);
    const thread = await createAdapter(ctx).getThread("t-9");
    expect(thread.map((m) => [m.providerMessageId, m.isDraft, m.isFromUs])).toEqual([
      ["m-100", false, true],
      ["m-101", false, false],
      ["m-199", true, true],
    ]);
  });

  it("reads the mailbox position before listing a window, so nothing arriving meanwhile is skipped", async () => {
    const { ctx, calls } = context();
    const page = await createAdapter(ctx).listNew({ since: "2026-11-01T00:00:00.000Z", limit: 10 });
    const order = calls.filter((r) => r.url !== TOKEN_URL).map((r) => new URL(r.url).pathname.split("/").pop());
    expect(order.indexOf("profile")).toBeLessThan(order.indexOf("messages"));
    expect(page.cursor).toBe("h:1010");
    const query = new URL(calls.find((r) => r.url.includes("/messages?q="))?.url ?? "").searchParams.get("q");
    expect(query).toBe(`in:anywhere -in:sent -in:drafts -in:trash -in:chats after:${Date.parse("2026-11-01T00:00:00.000Z") / 1000}`);
  });

  it("refreshes the token once and reuses it until shortly before it expires", async () => {
    const { ctx, calls } = context();
    const provider = createAdapter(ctx);
    await provider.listNew({ cursor: "h:1003", limit: 5 });
    await provider.listNew({ cursor: "h:1003", limit: 5 });
    expect(calls.filter((r) => r.url === TOKEN_URL)).toHaveLength(1);
    const form = new URLSearchParams(await calls.find((r) => r.url === TOKEN_URL)?.clone().text());
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(SECRETS.GMAIL_REFRESH_TOKEN);
  });

  it("refreshes the token and retries once when the API answers 401", async () => {
    let first = true;
    const routes: RecordedRoute[] = [
      mailboxRoutes()[0] as RecordedRoute,
      {
        method: "GET",
        url: /\/history\?/,
        respond: () => {
          if (first) {
            first = false;
            return json({ error: { code: 401 } }, { status: 401 });
          }
          return json({ historyId: "1010" });
        },
      },
    ];
    const { ctx, calls } = context(routes);
    const page = await createAdapter(ctx).listNew({ cursor: "h:1003", limit: 5 });
    expect(page.cursor).toBe("h:1010");
    expect(calls.filter((r) => r.url === TOKEN_URL)).toHaveLength(2);
  });

  it("maps API errors to typed codes", async () => {
    const response = (status: number, reason = "", headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { code: status, errors: reason ? [{ reason }] : [] } }), { status, headers });
    expect(await gmailError(response(400), "x")).toMatchObject({ code: "invalid", retryable: false });
    expect(await gmailError(response(403, "insufficientPermissions"), "x")).toMatchObject({ code: "auth", retryable: false });
    expect(await gmailError(response(403, "userRateLimitExceeded"), "x")).toMatchObject({ code: "rate_limited", retryable: true });
    expect(await gmailError(response(429, "", { "retry-after": "7" }), "x")).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 7000 });
    expect(await gmailError(response(404), "x")).toMatchObject({ code: "not_found", retryable: false });
    expect(await gmailError(response(503), "x")).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("offers watch only with a Pub/Sub topic configured", () => {
    expect(Reflect.get(createAdapter(context(mailboxRoutes(), SECRETS, {}).ctx), "watch")).toBeUndefined();
    expect(Reflect.get(createAdapter(context(mailboxRoutes(), SECRETS, { pubsubTopic: "not a topic" }).ctx), "watch")).toBeUndefined();
    expect(Reflect.get(createAdapter(context(mailboxRoutes(), { ...SECRETS, GMAIL_PUBSUB_TOPIC: TOPIC }, {}).ctx), "watch")).toBeTypeOf("function");
  });

  it("asks for push on the inbox only", async () => {
    const { ctx, calls } = context();
    const { expiresAt } = await (createAdapter(ctx).watch as () => Promise<{ expiresAt: string }>)();
    expect(expiresAt).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    expect(await calls.find((r) => r.url.endsWith("/watch"))?.clone().json()).toEqual({ topicName: TOPIC, labelIds: ["INBOX"] });
  });

  it("treats a server error after a send as uncertain, so core keeps its claim", async () => {
    const { ctx } = context([mailboxRoutes()[0] as RecordedRoute, { method: "POST", url: `${API}/messages/send`, respond: json({ error: { code: 500 } }, { status: 500 }) }]);
    const outcome = await createAdapter(ctx).send({ effectKey: "k1", from: { email: "avery@acme.example" }, to: { email: "riley@prospect.example" }, subject: "Re: hi", text: "Thanks.", headers: {}, tags: {} });
    expect(outcome).toMatchObject({ ok: false, code: "unknown", retryable: true });
  });

  it("builds plain-text messages that no header value can extend", () => {
    const raw = buildRawMessage({ to: "riley@prospect.example", subject: "Re: hi\r\nBcc: mallory@attacker.example", text: "Thanks.", headers: { "X-Note": "fine", "X-Bad": "a\r\nBcc: mallory@attacker.example", "Bad Name": "x", From: "mallory@attacker.example" } });
    const text = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    expect(head).toContain("X-Note: fine");
    expect(head).not.toMatch(/^Bcc:/im);
    // The subject's line break is flattened onto the subject line; nothing else names the address.
    expect(head.split("\r\n").filter((line) => line.includes("mallory"))).toEqual(["Subject: Re: hi Bcc: mallory@attacker.example"]);
    expect(head).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(() => buildRawMessage({ to: "a@prospect.example, b@prospect.example", subject: "s", text: "t" })).toThrow(TypeError);
  });

  it("encodes and decodes non-ASCII headers", async () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fm?= =?UTF-8?Q?=C3=A9?=")).toBe(`Caf${E_ACUTE}`);
    expect(decodeEncodedWords("=?ISO-8859-1?Q?caf=E9?=")).toBe(`caf${E_ACUTE}`);
    const decoded = await decodePayload({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }], body: { data: b64url(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])) } });
    expect(decoded.text).toBe(`caf${E_ACUTE}`);
  });

  it("reads history under every label, so a reply filtered past the inbox still counts", async () => {
    const { ctx, calls } = context();
    await createAdapter(ctx).listNew({ cursor: "h:1003", limit: 5 });
    const params = new URL(calls.find((r) => r.url.includes("/history?"))?.url ?? "").searchParams;
    expect(params.get("labelId")).toBeNull();
    expect(params.get("historyTypes")).toBe("messageAdded");
  });

  it("skips a text part Gmail no longer has, keeping the message", async () => {
    const routes = [{ method: "GET", url: `${API}/messages/m-105/attachments/att-1`, respond: json({ error: { code: 404 } }, { status: 404 }) }, ...mailboxRoutes()];
    const { ctx } = context(routes);
    const page = await createAdapter(ctx).listNew({ since: "2026-11-01T00:00:00.000Z", limit: 10 });
    const message = page.items.find((m) => m.providerMessageId === "m-105");
    expect(message).toBeDefined();
    expect(message?.text).toBe("");
  });

  it("reads only cursors it wrote", () => {
    expect(parseCursor("h:1234")).toBe(1234n);
    for (const bad of ["1234", "h:", "h:12a", "x:1", undefined]) expect(parseCursor(bad)).toBeNull();
  });
});
