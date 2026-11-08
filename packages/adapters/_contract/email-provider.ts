// GTM-agents: the shared contract every EmailProvider adapter runs in its contract.test.ts.
//
//   runEmailProviderContract((ctx) => createAdapter(ctx), fixtures)
//
// With recorded responses only, it checks what core relies on, whatever the vendor:
//   - the manifest validates, declares the EmailProvider port, a send price, a batch size and the
//     /api/webhooks/email route;
//   - sendBatch returns one outcome per message, in order, each echoing its effect key, and a cost;
//   - what reaches the vendor is plain text only (no HTML part, so no tracking pixel), with core's
//     List-Unsubscribe, List-Unsubscribe-Post and threading headers and its tags intact;
//   - the request carries an idempotency key derived from the effect keys: the same batch gets the
//     same key, a different batch a different one;
//   - a vendor refusal comes back as per-message outcomes with a code and a retryable flag, never a
//     throw, and a missing API key refuses every message without making a request;
//   - only the injected fetch is used;
//   - parseWebhook maps delivered, hard bounce, soft bounce, a bounce with no type (hard),
//     complaint, open and click events, and rejects a tampered body, a stale or future timestamp
//     and an unsigned request with a non-retryable auth error before parsing anything. With its
//     webhook secret unset it refuses with a code other than auth, which core answers with 503;
//   - getMessageId, when the adapter implements it (it is optional, and fixtures for it are then
//     required): a known email's Message-ID comes back in angle brackets, an unknown email is null,
//     a malformed id is null without a request, and with its API key unset it rejects with an
//     AdapterError without making a request. Follow-ups thread under the first email by this id.
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type EmailEvent, type EmailProvider, type OutboundMessage } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

export interface SentMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  /** True when the vendor was given an HTML part. */
  html: boolean;
  headers: Record<string, string>;
  tags: Record<string, string>;
}

export interface ContractEvent {
  kind: "delivered" | "hard_bounce" | "soft_bounce" | "untyped_bounce" | "complaint" | "opened" | "clicked";
  providerMessageId: string;
  to: string;
  tags: Record<string, string>;
}

export interface EmailProviderFixtures {
  manifest: unknown;
  /** A context with every secret set and a recorded fetch that accepts batch sends. */
  context(): { ctx: AdapterContext; calls: Request[] };
  /** A context whose vendor refuses every send, and the code and retryable flag that refusal maps to. */
  refusing(): { ctx: AdapterContext; calls: Request[]; code: AdapterErrorCode; retryable: boolean };
  /** A context with no secrets set. */
  unconfigured(): { ctx: AdapterContext; calls: Request[] };
  /** The messages one outbound request asked the vendor to send. */
  sent(request: Request): Promise<SentMessage[]>;
  /** The idempotency key the request carried, or null. */
  idempotencyKey(request: Request): string | null;
  /** A webhook request for `event`, signed `ageSeconds` ago (default 0), tampered after signing, or unsigned. */
  webhook(event: ContractEvent, options?: { ageSeconds?: number; tamper?: boolean; unsigned?: boolean }): Promise<Request>;
  /**
   * Required when the adapter implements getMessageId: a context whose recorded fetch knows one sent
   * email's Message-ID (`known`) and answers "not found" for `unknownProviderMessageId`.
   */
  messageIds?(): { ctx: AdapterContext; calls: Request[]; known: { providerMessageId: string; messageId: string }; unknownProviderMessageId: string };
}

const MESSAGE_ID_SHAPE = /^<[^\s<>@"]+@[^\s<>@"]+>$/;

const message = (n: number, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
  effectKey: `2026-11-04:contact-${n}`,
  from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
  to: { email: `riley.${n}@prospect.example`, name: "Riley Example" },
  replyTo: "avery@acme.example",
  subject: `Flaky builds at Prospect ${n}`,
  text: `Hi Riley,\n\nA short note.\n\n-- \nAcme Inc., 100 Example Street, Springfield, EX 00000\nTo stop hearing from us, reply "unsubscribe" or open https://agent.acme.example/u/token-${n}`,
  headers: {
    "List-Unsubscribe": `<https://agent.acme.example/u/token-${n}>, <mailto:avery@acme.example?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
  tags: { send_id: `send-${n}`, contact_id: `contact-${n}`, campaign_id: "campaign-1", send_path: "cold" },
  ...extra,
});

async function rejection(promise: Promise<unknown>): Promise<{ code: unknown; retryable: unknown; adapterError: boolean }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown };
    return { code: e.code, retryable: e.retryable, adapterError: error instanceof AdapterError };
  }
  throw new Error("expected the call to be rejected");
}

export function runEmailProviderContract(create: (ctx: AdapterContext) => EmailProvider, fixtures: EmailProviderFixtures): void {
  describe("the EmailProvider contract", () => {
    let globalFetch: { mock: { calls: unknown[] }; mockRestore(): void };
    beforeEach(() => {
      globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("adapters use ctx.fetch, never the global fetch");
      });
    });
    afterEach(() => {
      expect(globalFetch.mock.calls).toHaveLength(0);
      globalFetch.mockRestore();
    });

    it("declares the port, a send price, a batch size and the webhook route in a valid manifest", () => {
      const manifest = manifestSchema.parse(fixtures.manifest);
      expect(manifest.ports).toContain("EmailProvider");
      expect(manifest.costs.send?.usd).toBeGreaterThan(0);
      expect(manifest.limits.batchSize).toBeGreaterThan(0);
      expect(manifest.webhook?.path).toBe("/api/webhooks/email");
    });

    it("returns one outcome per message, in order, echoing effect keys, with a cost", async () => {
      const { ctx } = fixtures.context();
      const messages = [message(1), message(2), message(3)];
      const result = await create(ctx).sendBatch(messages);
      expect(result.outcomes.map((o) => o.effectKey)).toEqual(messages.map((m) => m.effectKey));
      for (const outcome of result.outcomes) {
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.providerMessageId.length).toBeGreaterThan(0);
      }
      expect(new Set(result.outcomes.map((o) => (o.ok ? o.providerMessageId : ""))).size).toBe(3);
      expect(result.cost).toMatchObject({ capability: "send", units: 3 });
      expect(result.cost?.usd).toBeGreaterThan(0);
    });

    it("sends plain text only, with core's headers and tags intact", async () => {
      const { ctx, calls } = fixtures.context();
      const threaded = message(4, { headers: { ...message(4).headers, "In-Reply-To": "<first@outreach.acme.example>", References: "<first@outreach.acme.example>" } });
      await create(ctx).sendBatch([threaded]);
      const [sent] = await fixtures.sent(calls.at(-1) as Request);
      expect(sent?.html).toBe(false);
      expect(sent?.text).toBe(threaded.text);
      expect(sent?.subject).toBe(threaded.subject);
      expect(sent?.to).toContain("riley.4@prospect.example");
      expect(sent?.from).toContain("avery@outreach.acme.example");
      expect(sent?.replyTo).toBe("avery@acme.example");
      expect(sent?.headers).toEqual(threaded.headers);
      expect(sent?.tags).toEqual(threaded.tags);
    });

    it("derives the idempotency key from the effect keys", async () => {
      const { ctx, calls } = fixtures.context();
      const provider = create(ctx);
      await provider.sendBatch([message(1), message(2)]);
      await provider.sendBatch([message(2), message(1)]);
      await provider.sendBatch([message(1), message(3)]);
      const [a, b, c] = calls.slice(-3).map((r) => fixtures.idempotencyKey(r));
      expect(a).toBeTruthy();
      expect(b).toBe(a);
      expect(c).not.toBe(a);
    });

    it("reports a vendor refusal per message, without throwing", async () => {
      const { ctx, code, retryable } = fixtures.refusing();
      const messages = [message(1), message(2)];
      const result = await create(ctx).sendBatch(messages);
      expect(result.outcomes).toHaveLength(2);
      for (const [i, outcome] of result.outcomes.entries()) {
        expect(outcome).toMatchObject({ effectKey: messages[i]?.effectKey, ok: false, code, retryable });
      }
    });

    it("refuses every message without a request when its API key is unset", async () => {
      const { ctx, calls } = fixtures.unconfigured();
      const result = await create(ctx).sendBatch([message(1)]);
      expect(result.outcomes).toEqual([expect.objectContaining({ effectKey: message(1).effectKey, ok: false, code: "auth", retryable: false })]);
      expect(calls).toHaveLength(0);
    });

    it("makes no request for an empty batch", async () => {
      const { ctx, calls } = fixtures.context();
      expect((await create(ctx).sendBatch([])).outcomes).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    const tags = { send_id: "send-7", contact_id: "contact-7", campaign_id: "campaign-1" };
    const base = { providerMessageId: "msg-0007", to: "riley.7@prospect.example", tags };

    it("maps a signed delivered event", async () => {
      const { ctx } = fixtures.context();
      const events = await create(ctx).parseWebhook(await fixtures.webhook({ kind: "delivered", ...base }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "delivered", providerMessageId: "msg-0007", to: "riley.7@prospect.example", tags });
    });

    it("maps hard, soft and untyped bounces, treating a missing type as hard", async () => {
      const { ctx } = fixtures.context();
      const provider = create(ctx);
      const kinds = [
        ["hard_bounce", true],
        ["soft_bounce", false],
        ["untyped_bounce", true],
      ] as const;
      for (const [kind, hard] of kinds) {
        const events = await provider.parseWebhook(await fixtures.webhook({ kind, ...base }));
        expect(events, kind).toEqual([expect.objectContaining({ type: "bounced", providerMessageId: "msg-0007", to: "riley.7@prospect.example", hard })]);
      }
    });

    it("maps a complaint", async () => {
      const { ctx } = fixtures.context();
      const events = await create(ctx).parseWebhook(await fixtures.webhook({ kind: "complaint", ...base }));
      expect(events).toEqual([expect.objectContaining({ type: "complained", providerMessageId: "msg-0007", to: "riley.7@prospect.example" })]);
    });

    it("passes opens and clicks on only as opens and clicks, which core ignores", async () => {
      const { ctx } = fixtures.context();
      const provider = create(ctx);
      for (const kind of ["opened", "clicked"] as const) {
        const events: EmailEvent[] = await provider.parseWebhook(await fixtures.webhook({ kind, ...base }));
        for (const e of events) expect(e.type).toBe(kind);
      }
    });

    it("rejects a tampered, stale, future or unsigned webhook with a non-retryable auth error", async () => {
      const { ctx } = fixtures.context();
      const provider = create(ctx);
      const cases: Array<[string, { ageSeconds?: number; tamper?: boolean; unsigned?: boolean }]> = [
        ["tampered", { tamper: true }],
        ["stale", { ageSeconds: 6 * 60 }],
        ["future", { ageSeconds: -6 * 60 }],
        ["unsigned", { unsigned: true }],
      ];
      for (const [name, options] of cases) {
        expect(await rejection(provider.parseWebhook(await fixtures.webhook({ kind: "delivered", ...base }, options))), name).toEqual({ code: "auth", retryable: false, adapterError: true });
      }
    });

    it("refuses to verify, with a code other than auth, while its webhook secret is unset", async () => {
      const { ctx } = fixtures.unconfigured();
      const outcome = await rejection(create(ctx).parseWebhook(await fixtures.webhook({ kind: "delivered", ...base })));
      expect(outcome.adapterError).toBe(true);
      expect(outcome.code).not.toBe("auth");
    });

    it("looks up a sent email's Message-ID, when it implements getMessageId", async () => {
      const probe = create(fixtures.context().ctx);
      if (!probe.getMessageId) return;
      expect(typeof fixtures.messageIds, "an adapter that implements getMessageId must provide messageIds fixtures").toBe("function");
      const setup = fixtures.messageIds?.();
      if (!setup) return;
      const provider = create(setup.ctx);
      const found = await provider.getMessageId?.(setup.known.providerMessageId);
      expect(found).toBe(setup.known.messageId);
      expect(found).toMatch(MESSAGE_ID_SHAPE);
      expect(await provider.getMessageId?.(setup.unknownProviderMessageId)).toBeNull();
      const before = setup.calls.length;
      expect(await provider.getMessageId?.("not/an id?")).toBeNull();
      expect(setup.calls).toHaveLength(before);
    });

    it("rejects a Message-ID lookup without a request while its API key is unset", async () => {
      const { ctx, calls } = fixtures.unconfigured();
      const provider = create(ctx);
      if (!provider.getMessageId) return;
      const outcome = await rejection(provider.getMessageId(fixtures.messageIds?.().known.providerMessageId ?? "msg-0001"));
      expect(outcome.adapterError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });
}
