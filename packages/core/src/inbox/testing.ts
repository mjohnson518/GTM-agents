// GTM-agents: test doubles for the inbox: an in-memory InboxProvider and a builder for synthetic
// inbound messages. For tests only; every address they make up is on a *.example domain.
//
//   const inbox = fakeInbox({ messages: [inboundMessage({ from: { email: "riley@prospect.example" } })] });
//
// The fake mailbox lists in arrival order. Its cursor is "n:<count of messages listed so far>",
// a window listing (no cursor) returns messages received since `since`, "n:expired" behaves like a
// cursor the provider no longer accepts, and `known` is honored before anything counts as fetched.
// Set failListing to make listNew throw, or listing: false for an inbound-only provider.
import type { InboundMessage, InboxProvider, OutboundMessage, SendOutcome } from "../ports/email.ts";
import { AdapterError } from "../ports/types.ts";

let sequence = 0;

/** A synthetic inbound message. Ids are unique per call unless given. */
export function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  sequence += 1;
  const id = overrides.providerMessageId ?? `fake-msg-${Date.now().toString(36)}-${sequence}`;
  return {
    providerMessageId: id,
    threadId: overrides.threadId ?? `fake-thread-${id}`,
    from: { email: "riley@prospect.example", name: "Riley Example" },
    to: ["avery@acme.example"],
    subject: "Question about Acme",
    text: "Hi Avery, how does the trial work?",
    receivedAt: "2026-11-04T11:00:00.000Z",
    headers: {},
    isFromUs: false,
    ...overrides,
  };
}

export interface FakeInbox extends InboxProvider {
  /** The mailbox, in arrival order. Push to it to deliver mail. */
  readonly mailbox: InboundMessage[];
  /** Every listNew call's arguments, without the known callback. */
  readonly listCalls: Array<{ cursor?: string; since?: string; limit: number }>;
  /** Ids the fake "fetched" (returned), across calls. */
  readonly fetched: string[];
  readonly drafts: Map<string, { threadId?: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[] }>;
  readonly sent: Array<OutboundMessage & { threadId?: string }>;
  /** When set, listNew throws it. */
  failListing: Error | null;
  watchCalls: number;
}

export interface FakeInboxOptions {
  name?: string;
  messages?: InboundMessage[];
  /** False for an inbound-only provider: listNew and getThread refuse as unsupported. */
  listing?: boolean;
  /** Offer watch(). */
  watch?: boolean;
  now?: () => Date;
}

const unsupported = (method: string) => new AdapterError(`this fake receives mail only; ${method} is not supported`, "invalid", false);

export function fakeInbox(options: FakeInboxOptions = {}): FakeInbox {
  const listing = options.listing !== false;
  let draftCount = 0;
  let sendCount = 0;
  const inbox: FakeInbox = {
    name: options.name ?? "fake-inbox",
    mailbox: [...(options.messages ?? [])],
    listCalls: [],
    fetched: [],
    drafts: new Map(),
    sent: [],
    failListing: null,
    watchCalls: 0,

    async listNew(args) {
      inbox.listCalls.push({ ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), ...(args.since !== undefined ? { since: args.since } : {}), limit: args.limit });
      if (!listing) throw unsupported("listNew");
      if (inbox.failListing) throw inbox.failListing;
      const match = /^n:(\d+)$/.exec(args.cursor ?? "");
      const reset = args.cursor !== undefined && !match;
      let candidates: Array<{ index: number; message: InboundMessage }>;
      if (match) {
        const start = Number(match[1]);
        candidates = inbox.mailbox.map((message, index) => ({ index, message })).slice(start);
      } else {
        const since = args.since ? Date.parse(args.since) : Number.NEGATIVE_INFINITY;
        candidates = inbox.mailbox.map((message, index) => ({ index, message })).filter((c) => Date.parse(c.message.receivedAt) >= since);
      }
      const held = args.known ? await args.known(candidates.map((c) => c.message.providerMessageId)) : new Set<string>();
      const wanted = candidates.filter((c) => !held.has(c.message.providerMessageId));
      const taken = wanted.slice(0, args.limit);
      const cut = wanted[args.limit];
      inbox.fetched.push(...taken.map((c) => c.message.providerMessageId));
      const cursor = `n:${cut ? cut.index : inbox.mailbox.length}`;
      return { items: taken.map((c) => c.message), cursor, ...(cut ? { more: true } : {}), ...(reset ? { reset: true } : {}) };
    },

    getThread(threadId) {
      if (!listing) return Promise.reject(unsupported("getThread"));
      return Promise.resolve(inbox.mailbox.filter((m) => m.threadId === threadId));
    },

    createDraft(draft) {
      draftCount += 1;
      const draftId = `fake-draft-${draftCount}`;
      inbox.drafts.set(draftId, { ...draft });
      return Promise.resolve({ draftId });
    },

    updateDraft(draftId, text) {
      const draft = inbox.drafts.get(draftId);
      if (!draft) return Promise.reject(new AdapterError("no such draft", "not_found", false));
      inbox.drafts.set(draftId, { ...draft, text });
      return Promise.resolve();
    },

    deleteDraft(draftId) {
      inbox.drafts.delete(draftId);
      return Promise.resolve();
    },

    send(message): Promise<SendOutcome> {
      sendCount += 1;
      inbox.sent.push(message);
      return Promise.resolve({ effectKey: message.effectKey, ok: true, providerMessageId: `fake-sent-${sendCount}` });
    },
  };
  if (options.watch) {
    inbox.watch = () => {
      inbox.watchCalls += 1;
      const now = (options.now ?? (() => new Date()))();
      return Promise.resolve({ expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString() });
    };
  }
  return inbox;
}
