// GTM-agents: test doubles and synthetic fixtures for reply handling.
//
// Import them from "@gtm-agents/core/replies/testing" in tests only:
//   - fakeMailbox: a recording warm mailbox. It keeps threads in memory, records every draft it
//     creates and every message it sends, and answers with whatever the test scripts. Its
//     capabilities can be turned off to stand in for an inbound-only mailbox;
//   - replyModel: a model gateway that answers the triage and writer roles from functions the test
//     supplies, and keeps every request, so a test can assert what each role was shown;
//   - seed helpers for an invented company (Acme), invented people on *.example domains, and
//     inbound messages with their bodies in blob storage.
import { defineConfig } from "../config/define-config.ts";
import type { GtmConfig, GtmConfigInput } from "../config/schema.ts";
import { contactEmailFields } from "../data/contacts.ts";
import { putInboundBody } from "../inbox/body.ts";
import type { InboundMessage, InboxProvider, OutboundMessage, SendOutcome } from "../ports/email.ts";
import type { CompletionRequest, CompletionResult, ModelGateway } from "../ports/model.ts";
import { AdapterError } from "../ports/types.ts";

export interface FakeMailbox extends InboxProvider {
  threads: Map<string, InboundMessage[]>;
  drafts: Map<string, { threadId?: string; to: string; subject: string; text: string; inReplyTo?: string }>;
  sent: Array<OutboundMessage & { threadId?: string }>;
  /** How send answers: accept (default), throw, or a scripted outcome. */
  sendBehavior: "accept" | "throw" | ((message: OutboundMessage & { threadId?: string }) => SendOutcome);
  /** Thread reads throw while set. */
  failReads: boolean;
  capabilities: { threads: boolean; drafts: boolean; send: boolean };
  /** Present unless the mailbox was built with `canProbeDrafts: false`. */
  draftExists?: (draftId: string) => Promise<boolean>;
  /** Put a message on a thread. */
  addMessage(message: Partial<InboundMessage> & { threadId: string; providerMessageId: string; receivedAt: string; isDraft?: boolean }): void;
  /** What the operator does in the mail client: send a mirrored draft (it becomes a sent message on its thread). */
  sendDraft(draftId: string, at: string, text?: string): void;
}

/**
 * Like a real mailbox, a draft created on a thread also shows up in that thread's messages, from
 * the mailbox. `marksDrafts` (default true) sets isDraft on them, as an adapter that can tell does;
 * with it false, the mailbox's own messages carry no draft or sent mark.
 */
export function fakeMailbox(options: { name?: string; marksDrafts?: boolean; canProbeDrafts?: boolean; now?: () => Date } = {}): FakeMailbox {
  let counter = 0;
  const marks = options.marksDrafts !== false;
  const clock = options.now ?? (() => REPLY_TEST_NOW);
  const mark = (isDraft: boolean) => (marks ? { isDraft } : {});
  const box: FakeMailbox = {
    name: options.name ?? "fake-mailbox",
    threads: new Map(),
    drafts: new Map(),
    sent: [],
    sendBehavior: "accept",
    failReads: false,
    capabilities: { threads: true, drafts: true, send: true },
    addMessage(message) {
      const full = { from: { email: "someone@prospect.example" }, to: [], subject: "", text: "", headers: {}, isFromUs: false, ...message };
      box.threads.set(message.threadId, [...(box.threads.get(message.threadId) ?? []), full]);
    },
    sendDraft(draftId, at, text) {
      const draft = box.drafts.get(draftId);
      box.drafts.delete(draftId);
      for (const [threadId, messages] of box.threads) {
        box.threads.set(
          threadId,
          messages.map((m) => (m.providerMessageId === `draft-msg-${draftId}` ? ({ ...m, receivedAt: at, text: text ?? draft?.text ?? m.text, ...mark(false) }) : m)),
        );
      }
    },
    listNew: () => Promise.resolve({ items: [] }),
    getThread(threadId) {
      if (box.failReads) return Promise.reject(new AdapterError("fake mailbox: unavailable", "unavailable", true));
      return Promise.resolve(structuredClone(box.threads.get(threadId) ?? []));
    },
    createDraft(draft) {
      counter += 1;
      const id = `mbd-${counter}`;
      box.drafts.set(id, { ...draft });
      if (draft.threadId) {
        box.addMessage({ threadId: draft.threadId, providerMessageId: `draft-msg-${id}`, receivedAt: clock().toISOString(), isFromUs: true, text: draft.text, to: [draft.to], ...mark(true) });
      }
      return Promise.resolve({ draftId: id });
    },
    updateDraft(draftId, text) {
      const draft = box.drafts.get(draftId);
      if (!draft) return Promise.reject(new AdapterError("fake mailbox: no such draft", "not_found", false));
      draft.text = text;
      return Promise.resolve();
    },
    deleteDraft(draftId) {
      box.drafts.delete(draftId);
      for (const [threadId, messages] of box.threads) box.threads.set(threadId, messages.filter((m) => m.providerMessageId !== `draft-msg-${draftId}`));
      return Promise.resolve();
    },
    send(message) {
      if (box.sendBehavior === "throw") return Promise.reject(new Error("fake mailbox: connection reset"));
      box.sent.push(structuredClone(message));
      if (typeof box.sendBehavior === "function") return Promise.resolve(box.sendBehavior(message));
      counter += 1;
      return Promise.resolve({ effectKey: message.effectKey, ok: true, providerMessageId: `mbs-${counter}` });
    },
  };
  if (options.canProbeDrafts !== false) box.draftExists = (draftId) => Promise.resolve(box.drafts.has(draftId));
  return box;
}

export type RoleAnswer = string | Error | ((request: CompletionRequest) => string | Error);

export interface ReplyModel extends ModelGateway {
  requests: CompletionRequest[];
  byRole(role: string): CompletionRequest[];
}

/** A gateway answering the triage and writer roles. A role without an answer throws. */
export function replyModel(answers: { triage?: RoleAnswer; writer?: RoleAnswer }, options: { model?: string } = {}): ReplyModel {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake-reply-model",
    requests,
    byRole: (role) => requests.filter((r) => r.role === role),
    complete(request): Promise<CompletionResult> {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const answer = request.role === "triage" ? answers.triage : request.role === "writer" ? answers.writer : undefined;
      const value = typeof answer === "function" ? answer(request) : answer;
      if (value === undefined) return Promise.reject(new Error(`no scripted answer for the ${request.role} role`));
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve({ text: value, toolCalls: [], stopReason: "end", usage: { inputTokens: 800, outputTokens: 120 }, model: options.model ?? request.model ?? "reply-test-model" });
    },
    embed: () => Promise.reject(new Error("not used")),
  };
}

/** A triage answer as the model would return it. */
export function triageAnswer(fields: Partial<Record<"intent" | "quote" | "problem_quote" | "timing_quote" | "proposed_time", string>> & { confidence?: number; meeting_requested?: boolean; asset_requested?: boolean }): string {
  return JSON.stringify({
    intent: fields.intent ?? "interested",
    confidence: fields.confidence ?? 0.9,
    quote: fields.quote ?? "",
    problem_quote: fields.problem_quote ?? "",
    timing_quote: fields.timing_quote ?? "",
    proposed_time: fields.proposed_time ?? "",
    meeting_requested: fields.meeting_requested ?? false,
    asset_requested: fields.asset_requested ?? false,
  });
}

/** A writer answer. */
export const writerAnswer = (body: string): string => JSON.stringify({ body });

export const REPLY_TEST_NOW = new Date("2026-11-04T17:00:00.000Z");
export const REPLY_TEST_MODEL = "reply-test-model";

/** The synthetic Acme configuration, with triage and writer models priced. */
export function replyTestConfig(overrides: Partial<GtmConfigInput> = {}): GtmConfig {
  return defineConfig({
    company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Detects flaky tests in CI and quarantines them automatically." } },
    agent: { name: "Avery" },
    sending: {
      from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
      replyTo: "avery@acme.example",
      supportAddress: "support@acme.example",
      postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
      domain: "outreach.acme.example",
      bookingUrl: "https://acme.example/book",
    },
    models: {
      roles: { triage: REPLY_TEST_MODEL, writer: REPLY_TEST_MODEL },
      pricing: { [REPLY_TEST_MODEL]: { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } },
    },
    operator: { allowedChatIds: ["chat-1"], allowedUserIds: ["user-1"] },
    ...overrides,
  });
}

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

export interface SeededContact {
  id: string;
  email: string;
  accountKey: string;
}

/** An account and a contact. */
export async function seedReplyContact(
  db: D1Database,
  input: { email: string; firstName?: string | null; title?: string | null; warmth?: string; accountName?: string },
): Promise<SeededContact> {
  const fields = await contactEmailFields(input.email);
  if (!fields) throw new Error(`not an address: ${input.email}`);
  const accountKey = fields.email.slice(fields.email.indexOf("@") + 1);
  const id = uid("ct");
  await db.prepare("INSERT OR IGNORE INTO accounts (account_key, name, domain) VALUES (?1, ?2, ?1)").bind(accountKey, input.accountName ?? "Globex Corporation").run();
  await db
    .prepare(
      `INSERT INTO contacts (id, first_name, email, email_sha256, mailbox_sha256, account_key, job_title, warmth, verification_status, timezone)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'deliverable', 'America/New_York')`,
    )
    .bind(id, input.firstName === undefined ? "Jane" : input.firstName, fields.email, fields.email_sha256, fields.mailbox_sha256, accountKey, input.title === undefined ? "VP Engineering" : input.title, input.warmth ?? "contacted")
    .run();
  return { id, email: fields.email, accountKey };
}

export interface SeededInbound {
  id: string;
  threadId: string;
  providerMessageId: string;
  receivedAt: string;
}

/** An inbound message from a contact (or a stranger), with its body stored in blob storage. */
export async function seedInbound(
  db: D1Database,
  bucket: Pick<R2Bucket, "put">,
  input: {
    sender: string;
    body: string;
    contactId?: string | null;
    subject?: string;
    receivedAt?: string;
    classification?: string;
    threadId?: string;
    provider?: string;
    status?: string;
    /** The RFC 5322 Message-ID inbox intake records. */
    messageId?: string;
  },
): Promise<SeededInbound> {
  const id = uid("in").replace(/[^A-Za-z0-9_-]/g, "");
  const threadId = input.threadId ?? uid("thread");
  const providerMessageId = uid("msg");
  const receivedAt = input.receivedAt ?? new Date(REPLY_TEST_NOW.getTime() - 60 * 60_000).toISOString();
  const key = await putInboundBody(bucket, id, input.body);
  await db
    .prepare(
      `INSERT INTO inbound_emails (id, provider, provider_message_id, provider_thread_id, sender_email, subject, body_preview, body_key, received_at, classification, contact_id, status, message_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      id,
      input.provider ?? "fake-mailbox",
      providerMessageId,
      threadId,
      input.sender,
      input.subject ?? "Re: Flaky builds at Globex",
      input.body.replace(/\s+/g, " ").slice(0, 280),
      key,
      receivedAt,
      input.classification ?? "reply",
      input.contactId ?? null,
      input.status ?? "new",
      input.messageId ?? null,
    )
    .run();
  return { id, threadId, providerMessageId, receivedAt };
}

/** Delete the rows reply tests write. Storage is per test file, so this touches no other suite. */
export async function resetReplyTables(db: D1Database): Promise<void> {
  const tables = [
    "reply_qualifications",
    "objections",
    "reply_assets",
    "quality_checks",
    "autonomy_events",
    "outreach_log",
    "outreach_sends",
    "deferred_send_items",
    "deferred_sends",
    "campaign_contacts",
    "outreach_sequence_runs",
    "funnel_events",
    "domain_delivery",
    "deal_stage_history",
    "deals",
    "inbound_emails",
    "drafts",
    "campaigns",
    "event_effects",
    "cost_events",
    "suppression",
    "calendar_meetings",
    "account_fit",
    "email_verifications",
    "contacts",
    "accounts",
  ];
  await db
    .prepare("INSERT OR IGNORE INTO erasure_tombstones (email_sha256, mailbox_sha256, source, erased_at) SELECT email_sha256, mailbox_sha256, 'operator', created_at FROM contacts WHERE warmth = 'opted_out'")
    .run();
  await db.batch([...tables.map((t) => db.prepare(`DELETE FROM ${t}`)), db.prepare("DELETE FROM erasure_tombstones")]);
}
