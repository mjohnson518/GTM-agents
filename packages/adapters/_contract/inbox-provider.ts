// GTM-agents: the shared contract every InboxProvider adapter runs in its contract.test.ts.
//
//   runInboxProviderContract((ctx) => createAdapter(ctx), fixtures)
//
// With recorded responses only, it checks what core relies on, whatever the mailbox:
//   - the manifest validates, declares the InboxProvider port, the inbox:enabled flag and a cost
//     table, and its capabilities say which methods work: "list" (listNew), "threads"
//     (getThread), "drafts" (createDraft, updateDraft, deleteDraft), "send", "watch" and "inbound"
//     (parseRouted, for mail delivered to the Worker). A capability-limited adapter refuses every
//     other method with a non-retryable "invalid" AdapterError (send: the same refusal as an
//     outcome), without a request. The runner options can name more unsupported methods, never fewer;
//   - only the injected fetch is used;
//   - listed and parsed messages are well formed: ids, thread, sender, recipients, subject, text,
//     an ISO receivedAt, a boolean isFromUs and headers limited to the triage set with lowercase
//     keys. text/plain is preferred, HTML-only mail arrives as text without tags, and a delivery
//     report carries its machine-readable part;
//   - listNew honors its cursor and limit: known ids are never fetched, a limited page says more is
//     waiting and its cursor resumes at the next message, an expired cursor falls back to `since`
//     with reset set, every page returns a cursor, and a message that cannot be fetched makes the
//     call throw a retryable error instead of being dropped;
//   - watch exists only with the watch capability (core reads it as "push configured"), and a
//     `capabilities` object, when present, agrees with the manifest; draftExists, when offered,
//     tells an existing draft from a missing one;
//   - drafts and sends are plain text only, on the thread, with In-Reply-To and References; a
//     recipient that is not one plain address is refused before any request; updateDraft keeps the
//     recipient, subject and threading; deleting a draft twice succeeds; send echoes its effect key,
//     never throws, reports a refusal with a code and a retryable flag, and gives the same effect
//     the same Message-ID;
//   - with no credentials, listing throws a non-retryable auth error and send refuses with auth,
//     before any request.
import { INBOUND_HEADER_NAMES } from "@gtm-agents/core/inbox";
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type InboundMessage, type InboxProvider, type OutboundMessage } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

export type InboxMethod = "listNew" | "getThread" | "createDraft" | "updateDraft" | "deleteDraft" | "send" | "watch" | "parseRouted";

/** Which methods each manifest capability turns on. */
export const CAPABILITY_METHODS: Readonly<Record<string, readonly InboxMethod[]>> = Object.freeze({
  list: ["listNew"],
  threads: ["getThread"],
  drafts: ["createDraft", "updateDraft", "deleteDraft"],
  send: ["send"],
  watch: ["watch"],
  inbound: ["parseRouted"],
});

const ALL_METHODS: readonly InboxMethod[] = ["listNew", "getThread", "createDraft", "updateDraft", "deleteDraft", "send"];

/** What a draft or send request asked the vendor to write. */
export interface WrittenMessage {
  /** Header names lowercase. */
  headers: Record<string, string>;
  text: string;
  /** True when the vendor was given an HTML part. */
  html: boolean;
  threadId?: string;
}

/** What one listed or parsed message must look like, for the fixtures that know. */
export interface MessageExpectation {
  providerMessageId: string;
  text?: string;
  /** Strings the text must not contain (tags of an HTML-only message, quoted parts). */
  textExcludes?: string[];
  isFromUs?: boolean;
  deliveryReportIncludes?: string;
  headers?: Record<string, string>;
}

export interface ListingFixtures {
  /** A cursor the recorded mailbox serves history from. */
  cursor: string;
  /** The ids new since `cursor`, in the order they arrived (at least two). */
  newIds: string[];
  /** A cursor the mailbox no longer accepts. */
  expiredCursor: string;
  /** True for a request that fetches one full message. */
  isMessageFetch(request: Request): boolean;
  /** A context whose mailbox answers every full-message fetch with a server error. */
  failingFetch(): { ctx: AdapterContext; calls: Request[] };
  /** Messages the window listing (no cursor) returns, and what each must look like. */
  window: MessageExpectation[];
}

export interface ThreadFixtures {
  id: string;
  /** The ids in the thread, and which of them the mailbox sent. */
  messageIds: string[];
  fromUs: string[];
}

export interface DraftFixtures {
  /** A draft the recorded mailbox holds, and one it does not. */
  existingId: string;
  missingId: string;
  /** The message a draft-create or draft-update request wrote. */
  written(request: Request): Promise<WrittenMessage>;
  isDraftWrite(request: Request): boolean;
}

export interface SendFixtures {
  written(request: Request): Promise<WrittenMessage>;
  isSend(request: Request): boolean;
  /** A context whose vendor refuses every send, and the code and retryable flag that maps to. */
  refusing(): { ctx: AdapterContext; calls: Request[]; code: AdapterErrorCode; retryable: boolean };
}

export interface InboundFixtures {
  /** Raw messages as Email Routing delivers them. */
  reply: { raw: string; from: string; to: string; expect: MessageExpectation & { inReplyTo?: string } };
  htmlOnly: { raw: string; from: string; to: string; expect: MessageExpectation };
  bounce: { raw: string; from: string; to: string; expect: MessageExpectation };
  /** A message with no Message-ID. */
  noMessageId: { raw: string; from: string; to: string };
}

export interface InboxProviderFixtures {
  manifest: unknown;
  /** A context with every secret set and a recorded fetch serving the fixture mailbox. */
  context(): { ctx: AdapterContext; calls: Request[] };
  /** A context with no secrets set. */
  unconfigured(): { ctx: AdapterContext; calls: Request[] };
  /** More unsupported methods, on top of those the manifest's capabilities imply. */
  unsupported?: readonly InboxMethod[];
  listing?: ListingFixtures;
  thread?: ThreadFixtures;
  drafts?: DraftFixtures;
  send?: SendFixtures;
  inbound?: InboundFixtures;
}

type Parser = { parseRouted(message: { from: string; to: string; raw: string }): Promise<InboundMessage> };

const SINCE = "2026-11-01T00:00:00.000Z";
const TRIAGE: ReadonlySet<string> = new Set(INBOUND_HEADER_NAMES);

function expectWellFormed(message: InboundMessage): void {
  expect(typeof message.providerMessageId).toBe("string");
  expect(message.providerMessageId.length).toBeGreaterThan(0);
  expect(typeof message.threadId).toBe("string");
  expect(message.threadId.length).toBeGreaterThan(0);
  expect(typeof message.from.email).toBe("string");
  expect(Array.isArray(message.to)).toBe(true);
  expect(typeof message.subject).toBe("string");
  expect(typeof message.text).toBe("string");
  expect(Number.isFinite(Date.parse(message.receivedAt))).toBe(true);
  expect(new Date(message.receivedAt).toISOString()).toBe(message.receivedAt);
  expect(typeof message.isFromUs).toBe("boolean");
  for (const [name, value] of Object.entries(message.headers)) {
    expect(name, "header names are lowercase").toBe(name.toLowerCase());
    expect(TRIAGE.has(name), `${name} is a triage header`).toBe(true);
    expect(value).not.toMatch(/[\r\n]/);
  }
}

function expectMatches(message: InboundMessage | undefined, expectation: MessageExpectation): void {
  expect(message, expectation.providerMessageId).toBeDefined();
  if (!message) return;
  expectWellFormed(message);
  if (expectation.text !== undefined) expect(message.text.trim()).toBe(expectation.text.trim());
  for (const excluded of expectation.textExcludes ?? []) expect(message.text).not.toContain(excluded);
  if (expectation.isFromUs !== undefined) expect(message.isFromUs).toBe(expectation.isFromUs);
  if (expectation.deliveryReportIncludes !== undefined) expect(message.deliveryReport ?? "").toContain(expectation.deliveryReportIncludes);
  for (const [name, value] of Object.entries(expectation.headers ?? {})) expect(message.headers[name]).toBe(value);
}

async function rejection(promise: Promise<unknown>): Promise<{ code: unknown; retryable: unknown; adapterError: boolean }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown };
    return { code: e.code, retryable: e.retryable, adapterError: error instanceof AdapterError };
  }
  throw new Error("expected the call to be refused");
}

const outbound = (n: number, extra: Partial<OutboundMessage & { threadId?: string }> = {}): OutboundMessage & { threadId?: string } => ({
  effectKey: `reply:inbound-${n}`,
  from: { email: "avery@acme.example", name: "Avery at Acme" },
  to: { email: `riley.${n}@prospect.example`, name: "Riley Example" },
  subject: "Re: Flaky builds at Prospect",
  text: `Hi Riley,\n\nHappy to show you. Does Thursday work?\n\nAvery\n\n-- \nAcme Inc., 100 Example Street, Springfield, EX 00000`,
  headers: {
    "In-Reply-To": "<reply-1@prospect.example>",
    References: "<first-1@acme.example> <reply-1@prospect.example>",
    "List-Unsubscribe": "<mailto:avery@acme.example?subject=unsubscribe>",
  },
  tags: { send_path: "reply" },
  threadId: "thread-acme-1",
  ...extra,
});

export function runInboxProviderContract(create: (ctx: AdapterContext) => InboxProvider, fixtures: InboxProviderFixtures): void {
  const manifest = manifestSchema.parse(fixtures.manifest);
  const supported = new Set(manifest.capabilities.flatMap((c) => CAPABILITY_METHODS[c] ?? []));
  const unsupported = new Set<InboxMethod>([...ALL_METHODS.filter((m) => !supported.has(m)), ...(fixtures.unsupported ?? [])]);
  const has = (method: InboxMethod) => supported.has(method) && !unsupported.has(method);

  describe("the InboxProvider contract", () => {
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

    it("declares the port, the inbox flag, a cost table and its capabilities in a valid manifest", () => {
      expect(manifest.ports).toContain("InboxProvider");
      expect(manifest.flags).toContain("inbox:enabled");
      expect(Object.keys(manifest.costs).length).toBeGreaterThan(0);
      expect(manifest.capabilities.length).toBeGreaterThan(0);
      for (const capability of manifest.capabilities) expect(Object.keys(CAPABILITY_METHODS), capability).toContain(capability);
    });

    it("exposes watch only with the watch capability, and declares capabilities that agree with its manifest", () => {
      const { ctx } = fixtures.context();
      const provider = create(ctx);
      // Core reads the presence of watch as "push is configured".
      if (!has("watch")) expect(Reflect.get(provider, "watch"), "watch without the watch capability").toBeUndefined();
      const declared = Reflect.get(provider, "capabilities") as Partial<Record<string, boolean>> | undefined;
      if (declared) {
        expect(declared.threads !== false, "capabilities.threads").toBe(has("getThread"));
        expect(declared.drafts !== false, "capabilities.drafts").toBe(has("createDraft"));
        expect(declared.send !== false, "capabilities.send").toBe(has("send"));
      }
    });

    if (unsupported.size > 0) {
      it("refuses the methods it does not support with a non-retryable invalid error, without a request", async () => {
        const { ctx, calls } = fixtures.context();
        const provider = create(ctx);
        for (const method of unsupported) {
          if (method === "watch") {
            expect(Reflect.get(provider, "watch"), "watch is absent when unsupported").toBeUndefined();
            continue;
          }
          if (method === "parseRouted") continue;
          if (method === "send") {
            const outcome = await provider.send(outbound(1));
            expect(outcome).toMatchObject({ effectKey: outbound(1).effectKey, ok: false, code: "invalid", retryable: false });
            continue;
          }
          const call =
            method === "listNew"
              ? provider.listNew({ since: SINCE, limit: 5 })
              : method === "getThread"
                ? provider.getThread("thread-acme-1")
                : method === "createDraft"
                  ? provider.createDraft({ to: "riley@prospect.example", subject: "Re: hello", text: "Thanks." })
                  : method === "updateDraft"
                    ? provider.updateDraft("draft-1", "Thanks.")
                    : provider.deleteDraft("draft-1");
          expect(await rejection(call), method).toEqual({ code: "invalid", retryable: false, adapterError: true });
        }
        expect(calls).toHaveLength(0);
      });
    }

    if (has("listNew")) {
      const listing = fixtures.listing;
      if (!listing) throw new Error("an adapter with the list capability needs listing fixtures");

      it("lists new mail from a cursor as well-formed messages, with a cursor to resume from", async () => {
        const { ctx } = fixtures.context();
        const page = await create(ctx).listNew({ cursor: listing.cursor, since: SINCE, limit: 50 });
        expect(page.items.map((m) => m.providerMessageId)).toEqual(listing.newIds);
        for (const item of page.items) expectWellFormed(item);
        expect(typeof page.cursor).toBe("string");
        expect(page.more ?? false).toBe(false);
      });

      it("never fetches a message core already holds", async () => {
        const { ctx, calls } = fixtures.context();
        const page = await create(ctx).listNew({ cursor: listing.cursor, since: SINCE, limit: 50, known: (ids) => Promise.resolve(new Set(ids)) });
        expect(page.items).toEqual([]);
        expect(calls.filter((r) => listing.isMessageFetch(r))).toHaveLength(0);
        expect(typeof page.cursor).toBe("string");
      });

      it("honors the limit: a short page says more is waiting, and its cursor resumes at the next message", async () => {
        const { ctx } = fixtures.context();
        const provider = create(ctx);
        const first = await provider.listNew({ cursor: listing.cursor, since: SINCE, limit: 1 });
        expect(first.items.map((m) => m.providerMessageId)).toEqual(listing.newIds.slice(0, 1));
        expect(first.more).toBe(true);
        const second = await provider.listNew({ cursor: first.cursor, since: SINCE, limit: 1, known: (ids) => Promise.resolve(new Set(ids.filter((id) => id === listing.newIds[0]))) });
        expect(second.items.map((m) => m.providerMessageId)).toEqual(listing.newIds.slice(1, 2));
      });

      it("falls back to the window when its cursor has expired, and says so", async () => {
        const { ctx } = fixtures.context();
        const page = await create(ctx).listNew({ cursor: listing.expiredCursor, since: SINCE, limit: 50 });
        expect(page.reset).toBe(true);
        expect(typeof page.cursor).toBe("string");
        expect(page.items.length).toBeGreaterThan(0);
      });

      it("lists a window without a cursor, decoding text, HTML-only mail, delivery reports and our own mail", async () => {
        const { ctx } = fixtures.context();
        const page = await create(ctx).listNew({ since: SINCE, limit: 50 });
        expect(typeof page.cursor).toBe("string");
        for (const expectation of listing.window) expectMatches(page.items.find((m) => m.providerMessageId === expectation.providerMessageId), expectation);
      });

      it("throws a retryable error when a message cannot be fetched, rather than drop it", async () => {
        const { ctx } = listing.failingFetch();
        const failure = await rejection(create(ctx).listNew({ cursor: listing.cursor, since: SINCE, limit: 50 }));
        expect(failure.adapterError).toBe(true);
        expect(failure.retryable).toBe(true);
      });

      it("throws a non-retryable auth error without a request when its credentials are unset", async () => {
        const { ctx, calls } = fixtures.unconfigured();
        expect(await rejection(create(ctx).listNew({ since: SINCE, limit: 5 }))).toEqual({ code: "auth", retryable: false, adapterError: true });
        expect(calls).toHaveLength(0);
      });
    }

    if (has("getThread")) {
      const thread = fixtures.thread;
      if (!thread) throw new Error("an adapter with the threads capability needs thread fixtures");
      it("reads a thread, marking the mailbox's own messages", async () => {
        const { ctx } = fixtures.context();
        const messages = await create(ctx).getThread(thread.id);
        expect(messages.map((m) => m.providerMessageId)).toEqual(thread.messageIds);
        for (const message of messages) {
          expectWellFormed(message);
          expect(message.threadId).toBe(thread.id);
          expect(message.isFromUs).toBe(thread.fromUs.includes(message.providerMessageId));
        }
      });
    }

    if (has("createDraft")) {
      const drafts = fixtures.drafts;
      if (!drafts) throw new Error("an adapter with the drafts capability needs draft fixtures");
      it("writes drafts as plain text on the thread, with threading headers", async () => {
        const { ctx, calls } = fixtures.context();
        const { draftId } = await create(ctx).createDraft({
          threadId: "thread-acme-1",
          to: "riley@prospect.example",
          subject: "Re: Flaky builds",
          text: "Hi Riley,\n\nThursday at 10 works.\n\nAvery",
          inReplyTo: "<reply-1@prospect.example>",
          references: ["<first-1@acme.example>"],
        });
        expect(draftId.length).toBeGreaterThan(0);
        const written = await drafts.written(calls.filter((r) => drafts.isDraftWrite(r)).at(-1) as Request);
        expect(written.html).toBe(false);
        expect(written.threadId).toBe("thread-acme-1");
        expect(written.text.replace(/\r\n/g, "\n").trim()).toBe("Hi Riley,\n\nThursday at 10 works.\n\nAvery");
        expect(written.headers.to).toBe("riley@prospect.example");
        expect(written.headers["in-reply-to"]).toBe("<reply-1@prospect.example>");
        expect(written.headers.references).toContain("<first-1@acme.example>");
        expect(written.headers.references).toContain("<reply-1@prospect.example>");
      });

      it("refuses a draft whose recipient is not one plain address, before any request", async () => {
        const { ctx, calls } = fixtures.context();
        const provider = create(ctx);
        for (const to of ["riley@prospect.example, mallory@attacker.example", "riley@prospect.example\r\nBcc: mallory@attacker.example", "not an address"]) {
          expect(await rejection(provider.createDraft({ to, subject: "Re: hi", text: "Thanks." })), JSON.stringify(to)).toMatchObject({ code: "invalid", retryable: false, adapterError: true });
        }
        expect(calls).toHaveLength(0);
      });

      it("updates a draft's text, keeping its recipient, subject and threading", async () => {
        const { ctx, calls } = fixtures.context();
        await create(ctx).updateDraft(drafts.existingId, "Hi Riley,\n\nFriday works too.\n\nAvery");
        const written = await drafts.written(calls.filter((r) => drafts.isDraftWrite(r)).at(-1) as Request);
        expect(written.html).toBe(false);
        expect(written.text.replace(/\r\n/g, "\n").trim()).toBe("Hi Riley,\n\nFriday works too.\n\nAvery");
        expect(written.headers.to).toBeTruthy();
        expect(written.headers.subject).toBeTruthy();
        expect(written.headers["in-reply-to"]).toBeTruthy();
      });

      it("tells a draft that still exists from one that is gone, when it offers draftExists", async () => {
        const { ctx } = fixtures.context();
        const provider = create(ctx);
        if (!provider.draftExists) return;
        expect(await provider.draftExists(drafts.existingId)).toBe(true);
        expect(await provider.draftExists(drafts.missingId)).toBe(false);
      });

      it("deletes a draft, and deleting one that is already gone succeeds", async () => {
        const { ctx } = fixtures.context();
        const provider = create(ctx);
        await expect(provider.deleteDraft(drafts.existingId)).resolves.toBeUndefined();
        await expect(provider.deleteDraft(drafts.missingId)).resolves.toBeUndefined();
      });
    }

    if (has("send")) {
      const send = fixtures.send;
      if (!send) throw new Error("an adapter with the send capability needs send fixtures");
      it("sends plain text on the thread, echoing the effect key, with core's headers", async () => {
        const { ctx, calls } = fixtures.context();
        const outcome = await create(ctx).send(outbound(1));
        expect(outcome).toMatchObject({ effectKey: outbound(1).effectKey, ok: true });
        if (outcome.ok) expect(outcome.providerMessageId.length).toBeGreaterThan(0);
        const written = await send.written(calls.filter((r) => send.isSend(r)).at(-1) as Request);
        expect(written.html).toBe(false);
        expect(written.threadId).toBe("thread-acme-1");
        expect(written.text.replace(/\r\n/g, "\n").trim()).toBe(outbound(1).text.trim());
        expect(written.headers["in-reply-to"]).toBe("<reply-1@prospect.example>");
        expect(written.headers["list-unsubscribe"]).toBe("<mailto:avery@acme.example?subject=unsubscribe>");
      });

      it("gives the same effect the same Message-ID, and another effect another", async () => {
        const { ctx, calls } = fixtures.context();
        const provider = create(ctx);
        await provider.send(outbound(1));
        await provider.send(outbound(1));
        await provider.send(outbound(2));
        const ids = await Promise.all(calls.filter((r) => send.isSend(r)).slice(-3).map(async (r) => (await send.written(r)).headers["message-id"]));
        expect(ids[0]).toBeTruthy();
        expect(ids[1]).toBe(ids[0]);
        expect(ids[2]).not.toBe(ids[0]);
      });

      it("reports a refusal as an outcome with a code, never a throw", async () => {
        const { ctx, code, retryable } = send.refusing();
        expect(await create(ctx).send(outbound(3))).toMatchObject({ effectKey: outbound(3).effectKey, ok: false, code, retryable });
      });

      it("refuses an unusable recipient, and refuses with auth when unconfigured, without a request", async () => {
        const { ctx, calls } = fixtures.context();
        expect(await create(ctx).send(outbound(4, { to: { email: "riley@prospect.example, mallory@attacker.example" } }))).toMatchObject({ ok: false, code: "invalid", retryable: false });
        expect(calls).toHaveLength(0);
        const bare = fixtures.unconfigured();
        expect(await create(bare.ctx).send(outbound(5))).toMatchObject({ ok: false, code: "auth", retryable: false });
        expect(bare.calls).toHaveLength(0);
      });
    }

    if (has("watch")) {
      it("registers push notifications and reports when they expire", async () => {
        const { ctx } = fixtures.context();
        const provider = create(ctx);
        expect(Reflect.get(provider, "watch")).toBeTypeOf("function");
        const { expiresAt } = await (provider.watch as () => Promise<{ expiresAt: string }>)();
        expect(Number.isFinite(Date.parse(expiresAt))).toBe(true);
      });
    }

    if (supported.has("parseRouted")) {
      const inbound = fixtures.inbound;
      if (!inbound) throw new Error("an adapter with the inbound capability needs inbound fixtures");
      const parserOf = (provider: InboxProvider): Parser => {
        const parser = provider as unknown as Partial<Parser>;
        if (typeof parser.parseRouted !== "function") throw new Error("an adapter with the inbound capability implements parseRouted");
        return parser as Parser;
      };

      it("parses a routed reply into a well-formed message with its threading", async () => {
        const { ctx } = fixtures.context();
        const message = await parserOf(create(ctx)).parseRouted(inbound.reply);
        expectMatches(message, inbound.reply.expect);
        expect(message.providerMessageId).toBe(inbound.reply.expect.providerMessageId);
        if (inbound.reply.expect.inReplyTo) expect(message.inReplyTo).toBe(inbound.reply.expect.inReplyTo);
      });

      it("derives text from HTML-only mail and reads a delivery report", async () => {
        const { ctx } = fixtures.context();
        const parser = parserOf(create(ctx));
        expectMatches(await parser.parseRouted(inbound.htmlOnly), inbound.htmlOnly.expect);
        expectMatches(await parser.parseRouted(inbound.bounce), inbound.bounce.expect);
      });

      it("gives a message without a Message-ID the same id every time it arrives", async () => {
        const { ctx } = fixtures.context();
        const parser = parserOf(create(ctx));
        const first = await parser.parseRouted(inbound.noMessageId);
        const again = await parser.parseRouted(inbound.noMessageId);
        expect(first.providerMessageId.length).toBeGreaterThan(0);
        expect(again.providerMessageId).toBe(first.providerMessageId);
      });
    }
  });
}
