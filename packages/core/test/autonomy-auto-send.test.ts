// GTM-agents: tests for automatic replies end to end: a reply that passes every auto-send rule goes
// out through the reply send path with its gates, records auto_sent evidence and tells the operator
// after; anything else goes back to review for a person, and a reply that may have gone out is
// never sent again. Every person, company and message is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { autoSendReply, type ReplyAutoSendCandidate, type ReplyAutoSendDeps } from "../src/autonomy/reply-auto-send.ts";
import { memoryKv, recordingOperator, type MemoryKvNamespace } from "../src/agents/testing.ts";
import type { ModelGateway } from "../src/ports/model.ts";
import { fakeJudge, flagReader, silentLogger, uploadOutreachBrain, ACME_BRAIN } from "../src/outreach/testing.ts";
import type { QualityResult } from "../src/quality/gate.ts";
import { runReplyPipeline } from "../src/replies/pipeline.ts";
import { inboundColumns, parseStoredTriage, type InboundRow } from "../src/replies/rows.ts";
import { fakeMailbox, replyModel, replyTestConfig, REPLY_TEST_MODEL, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, triageAnswer, writerAnswer, type FakeMailbox } from "../src/replies/testing.ts";
import { DELIVERY_FLAGS } from "../src/sending/flags.ts";
import { BASE_URL, SIGNING_KEY } from "./delivery-fakes.ts";

const db = env.DB;
const NOW = REPLY_TEST_NOW;
const config = replyTestConfig({
  models: {
    roles: { triage: REPLY_TEST_MODEL, writer: REPLY_TEST_MODEL, judge: "judge-test-model" },
    pricing: { [REPLY_TEST_MODEL]: { inputCentsPerMTok: 100, outputCentsPerMTok: 500 }, "judge-test-model": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 } },
  },
});
const SENDER_TEXT = "Sounds good, happy to chat about this. Can you send me a link to book a call?";
const BODY = "Hi Jane,\n\nGlad to hear it. You can pick a time that suits you here: https://acme.example/book\n\nAvery";
const BRAIN_TEXT = ["### facts (v1)", "- setup-time: text: Most teams finish setup in under an hour.; value: under an hour", "", "### competitors (v1)", "- globex-insights: name: Globex Test Insights; positioning: A dashboard."].join("\n");
const ON = { "inbound:auto_send_tier": "true", "replies:send_enabled": "true", "quality:model_review_enabled": "true", "autonomy:reply_send": "2", "autonomy:reply_demo_link": "2", [DELIVERY_FLAGS.enabled]: "true" };
const TRUSTED = { "fake-mailbox": ["mx.acme-test.example"] };
const AUTH = "mx.acme-test.example; dkim=pass header.i=@globex.example header.s=s1; spf=pass (sender permitted) smtp.mailfrom=jane@globex.example; dmarc=pass header.from=globex.example";
const PASS: QualityResult = { verdict: "pass", score: 100, findings: [] };

interface Fixture {
  candidate: ReplyAutoSendCandidate;
  deps: ReplyAutoSendDeps;
  kv: MemoryKvNamespace;
  mailbox: FakeMailbox;
  operator: ReturnType<typeof recordingOperator>;
}

async function fixture(options: { flags?: Record<string, string>; senderText?: string; body?: string; headers?: Record<string, string> | null; triage?: Partial<{ intent: string; confidence: number; proposed_time: string | null; asset_requested: boolean }>; actionClass?: "reply_send" | "reply_demo_link"; reviewPass?: boolean | null } = {}): Promise<Fixture> {
  const contact = await seedReplyContact(db, { email: "jane@globex.example", warmth: "engaged" });
  const text = options.senderText ?? SENDER_TEXT;
  const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: text, messageId: "<cafe.1@mail.globex.example>" });
  const headers = options.headers === undefined ? { "message-id": "<cafe.1@mail.globex.example>", "authentication-results": AUTH } : options.headers;
  await db.prepare("UPDATE inbound_emails SET headers = ?2 WHERE id = ?1").bind(inbound.id, headers === null ? null : JSON.stringify(headers)).run();
  const body = options.body ?? BODY;
  const draftId = `dr-${crypto.randomUUID().slice(0, 8)}`;
  const actionClass = options.actionClass ?? "reply_send";
  await db
    .prepare(
      `INSERT INTO drafts (id, contact_id, kind, recipient_email, subject, body, status, action_class, idempotency_key, notes)
       VALUES (?1, ?2, 'reply', ?3, 'Re: Flaky builds at Globex', ?4, 'pending_approval', ?5, ?6, '{}')`,
    )
    .bind(draftId, contact.id, contact.email, body, actionClass, `reply:${inbound.id}`)
    .run();
  await db.prepare("UPDATE inbound_emails SET draft_id = ?2, status = 'draft_created' WHERE id = ?1").bind(inbound.id, draftId).run();
  const row = await db.prepare(`SELECT ${inboundColumns()} FROM inbound_emails WHERE id = ?1`).bind(inbound.id).first<InboundRow>();
  if (!row) throw new Error("no inbound row");
  const mailbox = fakeMailbox();
  mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt, from: { email: contact.email }, text });
  const kv = memoryKv({ ...ON, ...(options.flags ?? {}) });
  for (const [k, v] of Object.entries(options.flags ?? {})) if (v === "") kv.map.delete(k);
  const operator = recordingOperator();
  const triage = { intent: "interested", confidence: 0.92, proposed_time: null, asset_requested: false, ...(options.triage ?? {}) };
  const candidate: ReplyAutoSendCandidate = {
    row,
    triage: { intent: triage.intent as never, confidence: triage.confidence, quote: null, problem_quote: null, timing_quote: null, proposed_time: triage.proposed_time, meeting_requested: true, asset_requested: triage.asset_requested, model: null, at: NOW.toISOString() },
    contact: { id: contact.id, email: contact.email, first_name: "Jane", job_title: "VP Engineering", account_key: contact.accountKey, account_name: "Globex Corporation", warmth: "engaged" },
    sender: text,
    qualification: null,
    draftId,
    subject: "Re: Flaky builds at Globex",
    body,
    actionClass,
    quality: PASS,
    assetUrls: ["https://acme.example/demo"],
    brainText: BRAIN_TEXT,
  };
  const reviewPass = options.reviewPass === undefined ? true : options.reviewPass;
  const deps: ReplyAutoSendDeps = {
    db,
    kv,
    flags: { get: (key) => kv.get(key) },
    config,
    inbox: mailbox,
    operator: operator.channel,
    spend: { allow: () => Promise.resolve(true), recordModel: () => Promise.resolve() },
    job: "replies_triage",
    judgeBrain: () => Promise.resolve(""),
    bucket: env.BUCKET,
    trustedAuthservIds: TRUSTED,
    unsubscribeSigningKey: SIGNING_KEY,
    baseUrl: BASE_URL,
    now: NOW,
    log: silentLogger,
    review: (sample) => Promise.resolve(reviewPass === null ? null : { key: sample.key, pass: reviewPass, scores: { relevance: 4, clarity: 4, tone: 4, claims: 4 }, reasons: reviewPass ? [] : ["too pushy"] }),
  };
  return { candidate, deps, kv, mailbox, operator };
}

const draft = (id: string) => db.prepare("SELECT status, approved_by, approved_digest FROM drafts WHERE id = ?1").bind(id).first<{ status: string; approved_by: string | null; approved_digest: string | null }>();
const evidence = async () => (await db.prepare("SELECT action_class, outcome FROM autonomy_events").all()).results;

beforeEach(async () => {
  await resetReplyTables(db);
  await db.batch([db.prepare("DELETE FROM autonomy_level_changes"), db.prepare("DELETE FROM autonomy_proposals")]);
});

describe("a reply that passes every rule", () => {
  it("goes out from the mailbox on its thread, records auto_sent evidence and tells the operator after", async () => {
    const f = await fixture();
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result).toEqual({ outcome: "sent", failures: [] });
    expect(f.mailbox.sent).toHaveLength(1);
    expect(f.mailbox.sent[0]?.text).toBe(BODY);
    expect(f.mailbox.sent[0]?.to.email).toBe("jane@globex.example");
    expect(await draft(f.candidate.draftId)).toMatchObject({ status: "sent", approved_by: "auto:autonomy:reply_send:L2" });
    expect(await evidence()).toEqual([{ action_class: "reply_send", outcome: "auto_sent" }]);
    expect(f.operator.messages.at(-1)?.text).toMatch(/^Sent automatically: a reply to jane@globex\.example \(reply_send at level 2/);
    expect(f.operator.messages.at(-1)?.text).toContain(BODY);
  });

  it("is sent once, however often it is offered", async () => {
    const f = await fixture();
    await autoSendReply(f.deps, f.candidate);
    expect((await autoSendReply(f.deps, f.candidate)).outcome).not.toBe("sent");
    expect(f.mailbox.sent).toHaveLength(1);
  });
});

describe("a reply that fails a rule waits for a person", () => {
  const cases: Array<[string, Parameters<typeof fixture>[0], number]> = [
    ["with the tier flag off", { flags: { "inbound:auto_send_tier": "" } }, 1],
    ["with the class at level 1", { flags: { "autonomy:reply_send": "1" } }, 1],
    ["with reply sending off", { flags: { "replies:send_enabled": "false" } }, 1],
    ["with the model reviewer off", { flags: { "quality:model_review_enabled": "" } }, 1],
    ["while cold outreach is paused", { flags: { "outreach:cold-pause": JSON.stringify({ reason: "test", source: "operator", since: NOW.toISOString() }) } }, 2],
    ["while the system is halted", { flags: { "system:halt": JSON.stringify({ reason: "test" }) } }, 2],
    ["when they propose a time", { senderText: "Happy to chat, does Tuesday at 3pm work?" }, 5],
    ["when triage found a proposed time", { triage: { proposed_time: "next week" } }, 5],
    ["when they ask to see the product", { triage: { asset_requested: true } }, 6],
    ["when Reply-To is someone else", { headers: { "reply-to": "assistant@globex.example", "authentication-results": AUTH } }, 7],
    ["when the sender is not authenticated (a forged From)", { headers: { "message-id": "<cafe.1@mail.globex.example>" } }, 7],
    ["when authentication failed", { headers: { "authentication-results": "mx.acme-test.example; dkim=fail header.i=@globex.example; spf=fail smtp.mailfrom=jane@globex.example" } }, 7],
    ["when the pass is for another domain", { headers: { "authentication-results": "mx.acme-test.example; dkim=pass header.i=@attacker.example; spf=pass smtp.mailfrom=bounce@attacker.example" } }, 7],
    ["when the results came from a server the mailbox does not trust", { headers: { "authentication-results": "mx.attacker.example; dkim=pass header.i=@globex.example" } }, 7],
    ["when the headers were not recorded", { headers: null }, 7],
    ["for a question", { triage: { intent: "question" } }, 8],
    ["for an objection", { triage: { intent: "objection" } }, 8],
    ["for a decline", { triage: { intent: "not_a_fit" } }, 8],
    ["under 0.8 confidence", { triage: { confidence: 0.79 } }, 8],
    ["without scheduling words", { senderText: "Interesting, tell me more." }, 8],
    ["when they mention pricing", { senderText: "Happy to chat, what does it cost per seat?" }, 9],
    ["when they mention a competitor", { senderText: "Happy to chat. How do you compare to Globex Test Insights?" }, 9],
    ["when the draft states a figure not in the facts", { body: "Hi Jane,\n\nTeams save 40% of reruns. Pick a time here: https://acme.example/book\n\nAvery" }, 10],
    ["when the draft promises to check and come back", { body: "Hi Jane,\n\nI will check that and come back to you. Pick a time here: https://acme.example/book\n\nAvery" }, 10],
    ["when the draft carries another link", { body: "Hi Jane,\n\nPick a time here: https://acme.example/book or see https://elsewhere.example/x\n\nAvery" }, 11],
    ["when an interest reply has no booking link", { body: "Hi Jane,\n\nGlad to hear it. Reply with a couple of options and I will set it up.\n\nAvery" }, 12],
  ];
  it.each(cases)("%s", async (_label, options, rule) => {
    const f = await fixture(options);
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result.outcome).toBe("not_sent");
    expect(result.failures.map((x) => x.rule)).toContain(rule);
    expect(f.mailbox.sent).toHaveLength(0);
    expect((await draft(f.candidate.draftId))?.status).toBe("pending_approval");
    expect(await evidence()).toEqual([]);
  });

  it("when the model reviewer fails or cannot run", async () => {
    for (const reviewPass of [false, null]) {
      await resetReplyTables(db);
      const f = await fixture({ reviewPass });
      const result = await autoSendReply(f.deps, f.candidate);
      expect(result.failures.map((x) => x.rule)).toEqual([14]);
      expect(f.mailbox.sent).toHaveLength(0);
    }
  });

  it("when the class has a standing demotion, whatever the flag says", async () => {
    const f = await fixture({ flags: { "autonomy:reply_send": "3" } });
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint')").run();
    expect((await autoSendReply(f.deps, f.candidate)).failures.map((x) => x.rule)).toContain(1);
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("when a demotion lands while it is being approved", async () => {
    const f = await fixture();
    let reads = 0;
    f.deps.flags = {
      get: async (key) => {
        if (key === "autonomy:reply_send" && ++reads === 4) {
          await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint')").run();
        }
        return f.kv.get(key);
      },
    };
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result.outcome).toBe("not_sent");
    expect(f.mailbox.sent).toHaveLength(0);
    expect(await draft(f.candidate.draftId)).toMatchObject({ status: "pending_approval", approved_by: null });
  });

  it("when only a preview of their text could be read", async () => {
    const f = await fixture();
    f.deps.bucket = { get: () => Promise.resolve(null) };
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result.failures.map((x) => x.rule)).toEqual(expect.arrayContaining([5, 9]));
    expect(f.mailbox.sent).toHaveLength(0);
  });

  it("when freshness refuses at send time: a newer message closes this draft, and it gets its own", async () => {
    const f = await fixture();
    f.mailbox.addMessage({ threadId: f.candidate.row.provider_thread_id ?? "", providerMessageId: "newer-1", receivedAt: new Date(NOW.getTime() - 60_000).toISOString(), from: { email: "jane@globex.example" }, text: "One more thing" });
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result.outcome).toBe("not_sent");
    expect(f.mailbox.sent).toHaveLength(0);
    expect((await draft(f.candidate.draftId))?.status).toBe("rejected");
    expect(await evidence()).toEqual([]);
  });

  it("when delivery is off, held and returned to review", async () => {
    const f = await fixture({ flags: { [DELIVERY_FLAGS.enabled]: "false" } });
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result.outcome).toBe("not_sent");
    expect(await draft(f.candidate.draftId)).toMatchObject({ status: "pending_approval", approved_by: null });
  });
});

describe("a reply that may have gone out", () => {
  it("is never returned to review or sent again, and the operator is told to check", async () => {
    const f = await fixture();
    f.mailbox.sendBehavior = "throw";
    const result = await autoSendReply(f.deps, f.candidate);
    expect(result.outcome).toBe("uncertain");
    expect((await draft(f.candidate.draftId))?.approved_by).toBe("auto:autonomy:reply_send:L2");
    expect(f.operator.messages.at(-1)?.text).toMatch(/may already have gone out/);
    f.mailbox.sendBehavior = "accept";
    expect((await autoSendReply(f.deps, f.candidate)).outcome).not.toBe("sent");
    expect(f.mailbox.sent).toHaveLength(0);
  });
});

describe("through the reply pipeline", () => {
  function gateway(): ModelGateway {
    const writer = replyModel({ triage: triageAnswer({ intent: "interested", confidence: 0.93, meeting_requested: true, problem_quote: "we rerun builds every day" }), writer: writerAnswer(BODY) });
    const judge = fakeJudge();
    return { name: "test-gateway", complete: (request) => (request.role === "judge" ? judge.complete(request) : writer.complete(request)), embed: () => Promise.reject(new Error("not used")) };
  }

  async function pipeline(flags: Record<string, string>) {
    // The replies slice needs the competitors block: without it, rule 9 cannot check names and fails closed.
    await uploadOutreachBrain(env.KV, { ...ACME_BRAIN, competitors: ["## globex-insights", "- name: Globex Test Insights", "- positioning: A broad CI analytics dashboard.", "- differentiators: Acme quarantines flaky tests instead of reporting them."].join("\n") });
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, provider: "inbox-gmail", body: "We rerun builds every day. Happy to chat, can you send me a link to book a call?" });
    await db.prepare("UPDATE inbound_emails SET headers = ?2 WHERE id = ?1").bind(inbound.id, JSON.stringify({ "message-id": "<m1@globex.example>", "authentication-results": "mx.google.com; dkim=pass header.i=@globex.example header.s=s1; spf=pass smtp.mailfrom=jane@globex.example" })).run();
    const mailbox = fakeMailbox();
    mailbox.addMessage({ threadId: inbound.threadId, providerMessageId: inbound.providerMessageId, receivedAt: inbound.receivedAt, from: { email: contact.email }, text: "Happy to chat" });
    const kv = memoryKv(flags);
    const operator = recordingOperator();
    const result = await runReplyPipeline({
      db,
      kv: env.KV,
      bucket: env.BUCKET,
      flags: flagReader(flags),
      config,
      model: gateway(),
      inbox: mailbox,
      operator: operator.channel,
      job: "replies_triage",
      now: NOW,
      log: silentLogger,
      maxRows: 10,
      store: kv,
      unsubscribeSigningKey: SIGNING_KEY,
      baseUrl: BASE_URL,
    });
    const stored = parseStoredTriage((await db.prepare("SELECT triage FROM inbound_emails WHERE id = ?1").bind(inbound.id).first<{ triage: string }>())?.triage);
    return { result, mailbox, operator, stored };
  }

  const triageFlags = { "replies:triage_enabled": "true", "replies:drafting_enabled": "true" };

  it("sends a drafted reply automatically once the class has earned it, and asks nobody", async () => {
    const { result, mailbox, operator, stored } = await pipeline({ ...triageFlags, ...ON });
    expect(stored?.intent).toBe("interested");
    expect(result).toMatchObject({ drafted: 1, autoSent: 1 });
    expect(mailbox.sent).toHaveLength(1);
    expect(operator.approvals).toHaveLength(0);
    expect(operator.messages.some((m) => m.text.startsWith("Sent automatically"))).toBe(true);
  });

  it("asks for approval as before when the class is at level 1", async () => {
    const { result, mailbox, operator } = await pipeline({ ...triageFlags, ...ON, "autonomy:reply_send": "1" });
    expect(result).toMatchObject({ drafted: 1, autoSent: 0 });
    expect(mailbox.sent).toHaveLength(0);
    expect(operator.approvals).toHaveLength(1);
  });
});
