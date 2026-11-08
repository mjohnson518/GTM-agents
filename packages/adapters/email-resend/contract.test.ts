// GTM-agents: contract and behavior tests for the email-resend adapter, against recorded, synthetic
// API responses. The people, addresses, ids and keys are invented; nothing reaches the network.
import { describe, expect, it } from "vitest";
import { testContext } from "../_contract/context.ts";
import { runEmailProviderContract, type ContractEvent, type SentMessage } from "../_contract/email-provider.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { BATCH_LIMIT, DEFAULT_USD_PER_EMAIL, classifyStatus, createAdapter, formatAddress, isHardBounce, mapWebhookEvent, vendorTags } from "./index.ts";
import manifest from "./manifest.json";

const API_KEY = "test-resend-api-key";
// Built at run time so the source holds no secret-shaped literal.
const WEBHOOK_SIGNING = `whsec_${btoa("test-signing-key-for-acme-hooks")}`;
const SECRETS = { RESEND_API_KEY: API_KEY, RESEND_WEBHOOK_SECRET: WEBHOOK_SIGNING };
const NOW = new Date("2026-11-04T12:00:00.000Z");
const API = "https://api.resend.com";

let nextId = 0;
const acceptBatch: RecordedRoute = {
  method: "POST",
  url: `${API}/emails/batch`,
  respond: async (request) => {
    const body = await request.json<unknown[]>();
    return json({ data: body.map(() => ({ id: `msg-${String((nextId += 1)).padStart(4, "0")}` })) });
  },
};

function context(routes: RecordedRoute[] = [acceptBatch], secrets: Record<string, string> = SECRETS, options: Record<string, unknown> = {}) {
  const recorded = recordedFetch(routes);
  return { ctx: testContext({ secrets, fetch: recorded.fetch, now: NOW, options }), calls: recorded.calls };
}

async function svixRequest(body: string, options: { ageSeconds?: number; tamper?: boolean; unsigned?: boolean } = {}): Promise<Request> {
  const id = "msg_test_0001";
  const timestamp = String(Math.floor(NOW.getTime() / 1000) - (options.ageSeconds ?? 0));
  const key = Uint8Array.from(atob(WEBHOOK_SIGNING.slice(6)), (c) => c.charCodeAt(0));
  const hmac = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))));
  const sent = options.tamper ? body.replace("riley.7@", "mallory.7@") : body;
  return new Request("https://agent.acme.example/api/webhooks/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.unsigned ? {} : { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,bm90LXRoZS1zaWduYXR1cmU= v1,${signature}` }) },
    body: sent,
  });
}

function payloadFor(event: ContractEvent): Record<string, unknown> {
  const data: Record<string, unknown> = { email_id: event.providerMessageId, to: [event.to], from: "Avery at Acme <avery@outreach.acme.example>", subject: "Flaky builds", tags: event.tags, created_at: "2026-11-04T11:59:58.000Z" };
  const type = {
    delivered: "email.delivered",
    hard_bounce: "email.bounced",
    soft_bounce: "email.bounced",
    untyped_bounce: "email.bounced",
    complaint: "email.complained",
    opened: "email.opened",
    clicked: "email.clicked",
  }[event.kind];
  if (event.kind === "hard_bounce") data.bounce = { type: "Permanent", subType: "General", message: "mailbox does not exist" };
  if (event.kind === "soft_bounce") data.bounce = { type: "Temporary", subType: "MailboxFull", message: "mailbox full" };
  if (event.kind === "untyped_bounce") data.bounce = { message: "rejected" };
  return { type, created_at: "2026-11-04T11:59:59.000Z", data };
}

runEmailProviderContract((ctx) => createAdapter(ctx), {
  manifest,
  context: () => context(),
  refusing: () => ({ ...context([{ method: "POST", url: `${API}/emails/batch`, respond: json({ name: "validation_error", message: "Invalid `to` field." }, { status: 422 }) }]), code: "invalid", retryable: false }),
  unconfigured: () => context([acceptBatch], {}),
  async sent(request) {
    const body = await request.clone().json<Array<Record<string, unknown>>>();
    return body.map(
      (m): SentMessage => ({
        to: (m.to as string[]).join(","),
        from: String(m.from),
        ...(typeof m.reply_to === "string" ? { replyTo: m.reply_to } : {}),
        subject: String(m.subject),
        text: String(m.text),
        html: "html" in m,
        headers: m.headers as Record<string, string>,
        tags: Object.fromEntries((m.tags as Array<{ name: string; value: string }>).map((t) => [t.name, t.value])),
      }),
    );
  },
  idempotencyKey: (request) => request.headers.get("idempotency-key"),
  webhook: (event, options) => svixRequest(JSON.stringify(payloadFor(event)), options),
});

describe("email-resend", () => {
  it("keeps its constants in step with its manifest", () => {
    expect(manifest.limits.batchSize).toBe(BATCH_LIMIT);
    expect(manifest.costs.send.usd).toBe(DEFAULT_USD_PER_EMAIL);
    expect(manifest.requiredSecrets).toEqual(["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"]);
    expect(manifest.webhook).toEqual({ path: "/api/webhooks/email", signature: "svix" });
  });

  it("splits more than the batch limit into several requests, keeping one outcome per message", async () => {
    const { ctx, calls } = context();
    const messages = Array.from({ length: BATCH_LIMIT + 5 }, (_, i) => ({
      effectKey: `k-${i}`,
      from: { email: "avery@outreach.acme.example" },
      to: { email: `person.${i}@prospect.example` },
      subject: "Hello",
      text: "Plain text.",
      headers: {},
      tags: {},
    }));
    const result = await createAdapter(ctx).sendBatch(messages);
    expect(calls).toHaveLength(2);
    expect(result.outcomes).toHaveLength(BATCH_LIMIT + 5);
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
  });

  it("sends the bearer key and the batch endpoint's JSON shape", async () => {
    const { ctx, calls } = context();
    await createAdapter(ctx).sendBatch([{ effectKey: "k", from: { email: "avery@outreach.acme.example", name: "Avery at Acme" }, to: { email: "riley@prospect.example" }, replyTo: "avery@acme.example", subject: "Hi", text: "Plain.", headers: {}, tags: {} }]);
    const request = calls[0] as Request;
    expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    const [body] = await request.json<Array<Record<string, unknown>>>();
    expect(body).toEqual({ from: '"Avery at Acme" <avery@outreach.acme.example>', to: ["riley@prospect.example"], subject: "Hi", text: "Plain.", reply_to: "avery@acme.example", headers: {}, tags: [] });
  });

  it("maps statuses to codes core can act on", () => {
    expect(classifyStatus(422)).toEqual({ code: "invalid", retryable: false });
    expect(classifyStatus(401)).toEqual({ code: "auth", retryable: false });
    expect(classifyStatus(429)).toEqual({ code: "rate_limited", retryable: true });
    expect(classifyStatus(429, "daily_quota_exceeded")).toEqual({ code: "quota", retryable: true });
    expect(classifyStatus(503)).toEqual({ code: "unavailable", retryable: true });
    // Acceptance is uncertain: core keeps its claim rather than send twice.
    expect(classifyStatus(500).code).toBe("unknown");
    expect(classifyStatus(409).code).toBe("unknown");
  });

  it("reports a dropped connection as a time-out, never as a refusal", async () => {
    const { ctx } = context([
      {
        method: "POST",
        url: `${API}/emails/batch`,
        respond: () => {
          throw new TypeError("network connection lost");
        },
      },
    ]);
    const result = await createAdapter(ctx).sendBatch([{ effectKey: "k", from: { email: "a@outreach.acme.example" }, to: { email: "b@prospect.example" }, subject: "s", text: "t", headers: {}, tags: {} }]);
    expect(result.outcomes[0]).toMatchObject({ ok: false, code: "timeout" });
  });

  it("leaves out tags the vendor would reject and quotes display names", () => {
    expect(vendorTags({ contact_id: "c-1", "bad name": "x", campaign_id: "has:colon" })).toEqual([{ name: "contact_id", value: "c-1" }]);
    expect(formatAddress({ email: "jane@prospect.example", name: 'J. "Jay" Doe' })).toBe('"J. Jay Doe" <jane@prospect.example>');
    expect(formatAddress({ email: "jane@prospect.example" })).toBe("jane@prospect.example");
  });

  it("treats only explicitly temporary bounces as soft", () => {
    expect(isHardBounce("Permanent")).toBe(true);
    expect(isHardBounce(undefined)).toBe(true);
    expect(isHardBounce("Undetermined")).toBe(true);
    expect(isHardBounce("Temporary")).toBe(false);
    expect(isHardBounce("Transient")).toBe(false);
  });

  it("reports a provider-side suppression as a hard bounce and ignores unknown event types", () => {
    const data = { email_id: "msg-1", to: ["riley@prospect.example"], tags: { contact_id: "c-1" } };
    expect(mapWebhookEvent({ type: "email.suppressed", data }, NOW)).toEqual([expect.objectContaining({ type: "bounced", hard: true })]);
    expect(mapWebhookEvent({ type: "email.delivery_delayed", data }, NOW)).toEqual([]);
    expect(mapWebhookEvent({ type: "email.sent", data }, NOW)).toEqual([]);
    expect(mapWebhookEvent({ type: "email.delivered", data: { to: ["riley@prospect.example"] } }, NOW)).toEqual([]);
  });

  it("accepts the standard-webhooks header names as well as the svix ones", async () => {
    const { ctx } = context();
    const svix = await svixRequest(JSON.stringify(payloadFor({ kind: "delivered", providerMessageId: "msg-9", to: "riley.7@prospect.example", tags: {} })));
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["id", "timestamp", "signature"]) headers.set(`webhook-${name}`, svix.headers.get(`svix-${name}`) ?? "");
    const events = await createAdapter(ctx).parseWebhook(new Request(svix.url, { method: "POST", headers, body: await svix.text() }));
    expect(events).toEqual([expect.objectContaining({ type: "delivered", providerMessageId: "msg-9" })]);
  });

  it("fails closed on a malformed signing secret", async () => {
    const { ctx } = context([acceptBatch], { RESEND_API_KEY: API_KEY, RESEND_WEBHOOK_SECRET: "test-not-base64!!" });
    const request = await svixRequest(JSON.stringify(payloadFor({ kind: "delivered", providerMessageId: "msg-9", to: "riley.7@prospect.example", tags: {} })));
    await expect(createAdapter(ctx).parseWebhook(request)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("uses the configured price per email", async () => {
    const { ctx } = context([acceptBatch], SECRETS, { usdPerEmail: 0.001 });
    const result = await createAdapter(ctx).sendBatch([{ effectKey: "k", from: { email: "a@outreach.acme.example" }, to: { email: "b@prospect.example" }, subject: "s", text: "t", headers: {}, tags: {} }]);
    expect(result.cost).toEqual({ provider: "email-resend", capability: "send", units: 1, usd: 0.001 });
  });
});
