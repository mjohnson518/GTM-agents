// GTM-agents: the SDK's host side behaves exactly as the event contract says: the emitter sends the
// exact signed bytes once and never throws or retries, the builders produce valid envelopes for the
// whole catalogue (the same catalogue the agent accepts), the read handler verifies before reading
// and returns only whitelisted fields, and the attribution cookie keeps the first touch. Every
// person and company is invented, on *.example domains.
import { describe, expect, it } from "vitest";
import { PRODUCT_EVENT_TYPES as AGENT_TYPES, parseEnvelope } from "../../packages/core/src/product-bridge/envelope.ts";
import {
  PRODUCT_EVENT_TYPES,
  billingPaymentFailed,
  billingSubscribed,
  billingSubscriptionCanceled,
  billingSubscriptionChanged,
  billingTopupPurchased,
  createProductEmitter,
  createReadHandler,
  customEvent,
  eventProblem,
  feedbackSubmitted,
  orgApiKeyCreated,
  orgCreated,
  refCookie,
  refCookieToSet,
  refFromCookies,
  refFromUrl,
  signPush,
  signRead,
  usageLimitReached,
  userActivated,
  userDeleted,
  userSignedUp,
  type ProductEvent,
} from "../../packages/sdk/src/index.ts";

const SECRET = "s".repeat(40);
const READ_SECRET = "r".repeat(40);
const ada = { id: "usr_ada", email: "ada@acme.example", name: "Ada Lovelace", role: "owner" };
const acme = { id: "org_acme", name: "Acme", domain: "acme.example", plan_tier: "free" };

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const call = { url: input instanceof Request ? input.url : input.toString(), init: init ?? {} };
      calls.push(call);
      return answer(call);
    },
  };
}

describe("the catalogue", () => {
  it("is the same list the agent accepts", () => {
    expect([...PRODUCT_EVENT_TYPES]).toEqual([...AGENT_TYPES]);
  });

  it("has a builder for every entry, and each builds an envelope the agent accepts", async () => {
    const at = "2026-03-01T12:00:00Z";
    const events: ProductEvent[] = [
      userSignedUp({ user: ada, org: acme, ref: "ref_q1launch", data: { plan: "free", source: "google" }, occurredAt: at }),
      orgCreated({ user: ada, org: acme, data: { plan: "free" }, occurredAt: at }),
      userActivated({ user: ada, org: acme, data: { event: "first_report", count: 1 }, occurredAt: at }),
      usageLimitReached({ user: ada, org: acme, data: { limit: "reports", used: 10, period: "month" }, occurredAt: at }),
      billingSubscribed({ user: ada, org: acme, data: { plan: "pro", interval: "month", amount: 4900, currency: "usd" }, occurredAt: at }),
      billingSubscriptionChanged({ user: ada, org: acme, data: { from_plan: "pro", to_plan: "team", status: "active" }, occurredAt: at }),
      billingSubscriptionCanceled({ user: ada, org: acme, data: { plan: "team", ends_at: "2026-04-01T00:00:00Z", reason: "too_expensive" }, occurredAt: at }),
      billingPaymentFailed({ user: ada, org: acme, data: { amount: 4900, currency: "usd", attempt: 1 }, occurredAt: at }),
      billingTopupPurchased({ user: ada, org: acme, data: { sku: "credits_100", amount: 1000, currency: "usd" }, occurredAt: at }),
      orgApiKeyCreated({ user: ada, org: acme, data: { scopes: ["read"] }, occurredAt: at }),
      feedbackSubmitted({ user: ada, org: acme, data: { text: "The export could be faster.", rating: 4 }, occurredAt: at }),
      await userDeleted({ userId: ada.id, email: ada.email, occurredAt: at }),
      customEvent("trial_extended", { user: ada, data: { days: 7 }, occurredAt: at }),
    ];
    expect(new Set(events.map((e) => e.type))).toEqual(new Set([...PRODUCT_EVENT_TYPES, "custom.trial_extended"]));
    for (const event of events) {
      expect(eventProblem(event)).toBeNull();
      const parsed = parseEnvelope(JSON.parse(JSON.stringify(event)));
      expect(parsed.ok, event.type).toBe(true);
      expect(event.version).toBe(1);
      expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
    }
    expect(events[0]?.occurred_at).toBe("2026-03-01T12:00:00.000Z");
    expect(events[1]?.ref).toBeNull();
  });

  it("names what is wrong with a malformed event", () => {
    expect(eventProblem({ id: "e1", version: 2 })).toMatch(/version/);
    expect(eventProblem({ id: "e1", version: 1, type: "user.exploded", occurred_at: "2026-03-01T12:00:00Z", data: {} })).toMatch(/type/);
    expect(eventProblem({ id: "e1", version: 1, type: "user.signed_up", occurred_at: "2026-03-01T12:00:00Z", user: { id: "u" }, data: {} })).toMatch(/email/);
    expect(eventProblem({ id: "e1", version: 1, type: "user.deleted", occurred_at: "2026-03-01T12:00:00Z", user: { id: "u", email_sha256: "a".repeat(64), email: "x@acme.example" }, data: {} })).toMatch(/no email/);
  });
});

describe("the emitter", () => {
  it("posts the exact signed bytes once, with the event id header", async () => {
    const host = recordingFetch(() => new Response(JSON.stringify({ ok: true, duplicate: false }), { status: 200 }));
    const emitter = createProductEmitter({ url: "https://agent.acme.example/api/webhooks/product", secret: SECRET, fetch: host.fetch });
    const event = userSignedUp({ user: ada, org: acme, data: { plan: "free" } });
    expect(await emitter.emit(event)).toEqual({ sent: true, status: 200, duplicate: false });
    expect(host.calls).toHaveLength(1);
    const call = host.calls[0] as Call;
    const headers = call.init.headers as Record<string, string>;
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(JSON.stringify(event));
    expect(headers["X-Event-Id"]).toBe(event.id);
    expect(headers["X-Signature"]).toBe(await signPush(call.init.body as string, SECRET));
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a duplicate the agent recognized", async () => {
    const host = recordingFetch(() => new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 }));
    const emitter = createProductEmitter({ url: "https://agent.acme.example/api/webhooks/product", secret: SECRET, fetch: host.fetch });
    expect(await emitter.emit(userActivated({ user: ada, data: { event: "first_report" } }))).toEqual({ sent: true, status: 200, duplicate: true });
  });

  it("is a no-op without a URL or a secret", async () => {
    const host = recordingFetch(() => new Response("{}"));
    for (const options of [{ url: "", secret: SECRET }, { url: "https://agent.acme.example/api/webhooks/product", secret: undefined }]) {
      const emitter = createProductEmitter({ ...options, fetch: host.fetch });
      expect(emitter.enabled).toBe(false);
      expect(await emitter.emit(userSignedUp({ user: ada, data: { plan: "free" } }))).toEqual({ sent: false, reason: "not_configured" });
    }
    expect(host.calls).toHaveLength(0);
  });

  it("never throws and never retries: a network error, a timeout, a rejection, a bad event", async () => {
    const errors: string[] = [];
    const failing = recordingFetch(() => Promise.reject(new TypeError("connection refused")));
    const emitter = createProductEmitter({ url: "https://agent.acme.example/api/webhooks/product", secret: SECRET, fetch: failing.fetch, onError: (e) => errors.push(e.reason) });
    expect(await emitter.emit(userSignedUp({ user: ada, data: { plan: "free" } }))).toEqual({ sent: false, reason: "network" });
    expect(failing.calls).toHaveLength(1);

    const slow = recordingFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    const timed = createProductEmitter({ url: "https://agent.acme.example/api/webhooks/product", secret: SECRET, fetch: slow.fetch, timeoutMs: 20 });
    expect(await timed.emit(userSignedUp({ user: ada, data: { plan: "free" } }))).toEqual({ sent: false, reason: "timeout" });
    expect(slow.calls).toHaveLength(1);

    const rejecting = recordingFetch(() => new Response("{}", { status: 401 }));
    const rejected = createProductEmitter({ url: "https://agent.acme.example/api/webhooks/product", secret: SECRET, fetch: rejecting.fetch, onError: () => {
      throw new Error("the host's logger broke");
    } });
    expect(await rejected.emit(userSignedUp({ user: ada, data: { plan: "free" } }))).toEqual({ sent: false, reason: "rejected", status: 401 });
    expect(rejecting.calls).toHaveLength(1);

    const bad = await emitter.emit({ id: "", version: 1 } as unknown as ProductEvent);
    expect(bad).toMatchObject({ sent: false, reason: "invalid_event" });
    expect(failing.calls).toHaveLength(1);
    expect(errors).toContain("network error");
  });
});

describe("the read handler", () => {
  const base = "https://app.acme.example/api/internal/gtm";
  const users = async () => ({
    items: [
      {
        id: "usr_ada",
        email: "ada@acme.example",
        name: "Ada Lovelace",
        role: "owner",
        created_at: "2026-03-01T12:00:00Z",
        updated_at: "2026-03-04T08:10:00Z",
        signup_ref: "ref_q1launch",
        password_hash: "never-returned",
        org: { id: "org_acme", name: "Acme", domain: "acme.example", plan_tier: "pro", usage_this_period: 14, billing_card: "never-returned", flags: { founding: false, whitelisted: false, internal_note: "never-returned" } },
      },
    ],
    hasMore: true,
  });
  const handler = createReadHandler({ secret: READ_SECRET, users, deletions: async () => ({ items: [{ user_id: "usr_old", email_sha256: "b".repeat(64), deleted_at: "2026-03-02T09:30:00Z", reason: "never-returned" }] }) });

  async function signed(url: string, init: { method?: string; timestamp?: number; secret?: string } = {}): Promise<Request> {
    const headers = await signRead({ secret: init.secret ?? READ_SECRET, method: init.method ?? "GET", url, timestamp: init.timestamp ?? Math.floor(Date.now() / 1000) });
    return new Request(url, { method: init.method ?? "GET", headers });
  }

  it("returns only the whitelisted fields, with the next cursor", async () => {
    const response = await handler(await signed(`${base}/users?since=2026-03-01T00%3A00%3A00Z&limit=200`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>>; cursor?: string };
    expect(body.cursor).toBe("usr_ada");
    expect(JSON.stringify(body)).not.toContain("never-returned");
    expect(body.items[0]).toEqual({
      id: "usr_ada",
      email: "ada@acme.example",
      name: "Ada Lovelace",
      role: "owner",
      created_at: "2026-03-01T12:00:00Z",
      updated_at: "2026-03-04T08:10:00Z",
      signup_ref: "ref_q1launch",
      org: { id: "org_acme", name: "Acme", domain: "acme.example", plan_tier: "pro", usage_this_period: 14, flags: { founding: false, whitelisted: false } },
    });
    const deletions = (await (await handler(await signed(`${base}/deletions?limit=200`))).json()) as { items: unknown[]; cursor?: string };
    expect(deletions).toEqual({ items: [{ user_id: "usr_old", email_sha256: "b".repeat(64), deleted_at: "2026-03-02T09:30:00Z" }] });
  });

  it("refuses before reading: unsigned, stale, tampered, wrong secret, wrong method, unconfigured", async () => {
    let reads = 0;
    const counting = createReadHandler({
      secret: READ_SECRET,
      users: async () => {
        reads += 1;
        return { items: [] };
      },
    });
    expect((await counting(new Request(`${base}/users`))).status).toBe(401);
    expect((await counting(await signed(`${base}/users`, { timestamp: Math.floor(Date.now() / 1000) - 301 }))).status).toBe(401);
    const tampered = await signed(`${base}/users?limit=10`);
    expect((await counting(new Request(`${base}/users?limit=200`, { headers: tampered.headers }))).status).toBe(401);
    expect((await counting(await signed(`${base}/users`, { secret: "w".repeat(40) }))).status).toBe(401);
    expect((await counting(await signed(`${base}/users`, { method: "POST" }))).status).toBe(405);
    expect((await createReadHandler({ secret: "", users: async () => ({ items: [] }) })(await signed(`${base}/users`))).status).toBe(503);
    expect(reads).toBe(0);
    expect((await counting(await signed(`${base}/feedback`))).status).toBe(404);
    expect((await counting(await signed(`${base}/users?since=yesterday`))).status).toBe(400);
    expect(reads).toBe(0);
    expect((await counting(await signed(`${base}/users`))).status).toBe(200);
    expect(reads).toBe(1);
  });
});

describe("the attribution cookie", () => {
  it("captures a valid token on the first touch only, as a first-party cookie", () => {
    expect(refFromUrl("https://acme.example/pricing?ref=ref_q1launch")).toBe("ref_q1launch");
    expect(refFromUrl("https://acme.example/pricing?ref=not%20a%20token")).toBeNull();
    expect(refCookieToSet("https://acme.example/?ref=ref_q1launch", null)).toBe("gtm_ref=ref_q1launch; Max-Age=2592000; Path=/; SameSite=Lax; Secure; HttpOnly");
    expect(refCookieToSet("https://acme.example/?ref=ref_later", "theme=dark; gtm_ref=ref_q1launch")).toBeNull();
    expect(refFromCookies("theme=dark; gtm_ref=ref_q1launch")).toBe("ref_q1launch");
    expect(refFromCookies("gtm_ref=<script>")).toBeNull();
    expect(() => refCookie("bad token; Domain=evil.example")).toThrow(TypeError);
  });
});
