// GTM-agents: the meeting qualifier and reply drafting: what the writer is shown, the quality gate,
// the stored draft and its approval request. Every person, company and message is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv, recordingOperator } from "../src/agents/testing.ts";
import { flagReader, silentLogger, uploadOutreachBrain, ACME_BRAIN } from "../src/outreach/testing.ts";
import { runReplyPipeline, type PipelineDeps } from "../src/replies/pipeline.ts";
import { decideQualification } from "../src/replies/qualify.ts";
import { replyModel, replyTestConfig, REPLY_TEST_NOW, resetReplyTables, seedInbound, seedReplyContact, triageAnswer, writerAnswer, type RoleAnswer } from "../src/replies/testing.ts";
import { draftDigest, wasShown } from "../src/security/approval-digest.ts";
import { commercialBody, brainFile } from "./fixtures.ts";

const db = env.DB;
const config = replyTestConfig();
const flags = flagReader({ "replies:triage_enabled": "true", "replies:drafting_enabled": "true" });
const dash = String.fromCharCode(0x2014);
const BRAIN = {
  ...ACME_BRAIN,
  objections: ["## we-retry", "- objection: Our CI already retries failed tests automatically.", "- response: Retries hide flakes and slow every build; quarantine takes the flaky test off the critical path."].join("\n"),
};

async function run(triage: string, writer: RoleAnswer, deps: Partial<PipelineDeps> = {}) {
  const operator = recordingOperator();
  const model = replyModel({ triage, writer });
  const result = await runReplyPipeline({ db, kv: env.KV, bucket: env.BUCKET, flags, config, model, operator: operator.channel, job: "replies_triage", now: REPLY_TEST_NOW, log: silentLogger, maxRows: 10, ...deps });
  return { operator, model, result };
}

const draftOf = (inboundId: string) =>
  db
    .prepare("SELECT d.* FROM drafts d JOIN inbound_emails i ON i.draft_id = d.id WHERE i.id = ?1")
    .bind(inboundId)
    .first<{ id: string; kind: string; status: string; recipient_email: string; subject: string; body: string; action_class: string; notes: string }>();

beforeEach(async () => {
  await resetReplyTables(db);
  await uploadOutreachBrain(env.KV, BRAIN);
});

describe("the meeting qualifier", () => {
  const base = { problem_quote: "we rerun builds daily", timing_quote: "before our Q1 release", meeting_requested: false, proposed_time: null };
  it("books with no gaps, asks about the first gap, and passes at three gaps", () => {
    expect(decideQualification({ triage: base, roleKeep: true, roleFit: "keep", accountFit: true, icpFit: "fit" }).status).toBe("book");
    const ask = decideQualification({ triage: { ...base, problem_quote: null }, roleKeep: false, roleFit: "maybe", accountFit: true, icpFit: "fit" });
    expect(ask.status).toBe("ask");
    expect(ask.gaps).toEqual(["problem", "role"]);
    expect(ask.rule).toMatch(/what they are trying to solve/);
    const pass = decideQualification({ triage: { ...base, problem_quote: null, timing_quote: null }, roleKeep: false, roleFit: "drop", accountFit: true, icpFit: "fit" });
    expect(pass.status).toBe("pass");
    expect(pass.rule).toMatch(/no booking language/);
  });

  it("books a meeting request with one gap, and a proposed time always, confirming it with no link", () => {
    expect(decideQualification({ triage: { ...base, problem_quote: null, meeting_requested: true }, roleKeep: true, roleFit: "keep", accountFit: true, icpFit: "fit" }).status).toBe("book");
    const proposed = decideQualification({ triage: { ...base, problem_quote: null, timing_quote: null, proposed_time: "Thursday at 3pm" }, roleKeep: false, roleFit: "maybe", accountFit: false, icpFit: "low: 2" });
    expect(proposed.status).toBe("book");
    expect(proposed.rule).toMatch(/invite will follow, and include no link/);
  });

  it("reads the role from the CRM title and the fit from the account score, and saves the decision", async () => {
    const vp = await seedReplyContact(db, { email: "jane@globex.example", title: "VP Engineering" });
    const nobody = await seedReplyContact(db, { email: "ada@northwind.example", title: null });
    await db.prepare("INSERT INTO account_fit (account_key, fit_score, status) VALUES ('northwind.example', 2, 'scored')").run();
    const a = await seedInbound(db, env.BUCKET, { sender: vp.email, contactId: vp.id, body: "We rerun builds daily. I am the CEO, by the way. Can we talk?" });
    await run(triageAnswer({ intent: "interested", problem_quote: "We rerun builds daily.", meeting_requested: true }), writerAnswer("Hi Jane,\n\nThanks for writing. A short call would be great: https://acme.example/book\n\nAvery"));
    const b = await seedInbound(db, env.BUCKET, { sender: nobody.email, contactId: nobody.id, body: "I run engineering here. What is this?" });
    await run(triageAnswer({ intent: "question", confidence: 0.75 }), writerAnswer("Hi Jane,\n\nThanks for asking. Acme quarantines flaky tests so builds stop being rerun.\n\nAvery"));
    expect(await db.prepare("SELECT status, role_fit, icp_fit, gaps FROM reply_qualifications WHERE inbound_id = ?1").bind(a.id).first()).toEqual({ status: "book", role_fit: "keep: economic-buyer", icp_fit: "unscored", gaps: "[]" });
    expect(await db.prepare("SELECT status, role_fit, icp_fit, gaps FROM reply_qualifications WHERE inbound_id = ?1").bind(b.id).first()).toEqual({ status: "pass", role_fit: "unknown", icp_fit: "low: 2", gaps: JSON.stringify(["problem", "role", "timing", "fit"]) });
  });
});

describe("drafting", () => {
  it("shows the writer approved material in the system prompt and the message only fenced in the user turn", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "SENDERWORDS: we rerun builds daily. Can we talk next week?" });
    const { model } = await run(triageAnswer({ intent: "interested", meeting_requested: true }), writerAnswer("Hi Jane,\n\nThanks for writing back. A short call next week works: https://acme.example/book\n\nAvery"));
    const [writer] = model.byRole("writer");
    expect(writer?.system).toContain("Most teams finish setup in under an hour.");
    expect(writer?.system).not.toContain("SENDERWORDS");
    expect(writer?.system).not.toContain("interested");
    const user = JSON.stringify(writer?.messages);
    expect(user).toContain("SENDERWORDS");
    expect(user).toContain('trust=\\"untrusted\\"');
  });

  it("stores a pending reply draft to the contact's address, and asks for approval bound to its digest", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: "JANE@globex.example", contactId: contact.id, subject: "Re: Flaky builds at Globex", body: "We rerun builds daily. Can we talk?" });
    const body = "Hi Jane,\n\nThanks for writing back. A short call would help: https://acme.example/book\n\nAvery";
    const { operator, result } = await run(triageAnswer({ intent: "interested", problem_quote: "We rerun builds daily.", meeting_requested: true }), writerAnswer(body));
    expect(result.drafted).toBe(1);
    const draft = await draftOf(inbound.id);
    expect(draft).toMatchObject({ kind: "reply", status: "pending_approval", recipient_email: contact.email, subject: "Re: Flaky builds at Globex", body, action_class: "reply_send" });
    expect((await db.prepare("SELECT status FROM inbound_emails WHERE id = ?1").bind(inbound.id).first<{ status: string }>())?.status).toBe("draft_created");
    const digest = await draftDigest({ to: contact.email, subject: "Re: Flaky builds at Globex", body });
    expect(operator.approvals).toHaveLength(1);
    expect(operator.approvals[0]).toMatchObject({ approvalId: draft?.id, digest, chatId: "chat-1" });
    expect(await wasShown(env.KV, draft?.id ?? "", { to: contact.email, subject: "Re: Flaky builds at Globex", body })).toBe(true);
    expect(operator.texts().join("\n")).not.toContain("We rerun builds daily");
  });

  it("gives a request to see the product the approved asset instead of a call, filed as reply_demo_link", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await db.prepare("INSERT INTO reply_assets (id, kind, title, url) VALUES ('asset-1', 'demo', 'Two-minute tour', 'https://acme.example/tour')").run();
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Could you send me a demo video first?" });
    const { model } = await run(triageAnswer({ intent: "interested", asset_requested: true }), writerAnswer("Hi Jane,\n\nHere is a short tour of how it works:\nhttps://acme.example/tour\n\nAvery"));
    expect(JSON.stringify(model.byRole("writer")[0]?.messages)).toContain("instead of offering a call: https://acme.example/tour");
    expect((await draftOf(inbound.id))?.action_class).toBe("reply_demo_link");
  });

  it("files a confident question answered from approved facts as reply_question", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "How long does setup take?" });
    await run(triageAnswer({ intent: "question", confidence: 0.9 }), writerAnswer("Hi Jane,\n\nMost teams finish setup in under an hour. Happy to walk you through it.\n\nAvery"));
    expect((await draftOf(inbound.id))?.action_class).toBe("reply_question");
  });

  it("saves nothing when the quality gate blocks the draft, tells the operator, and does not try again", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "What does it do?" });
    const { operator, result } = await run(triageAnswer({ intent: "question", confidence: 0.9 }), writerAnswer(`Hi Jane,\n\nIt quarantines flaky tests ${dash} automatically, so builds stop being rerun.\n\nAvery`));
    expect(result.blocked).toBe(1);
    expect(await draftOf(inbound.id)).toBeNull();
    expect(operator.texts().join("\n")).toMatch(/quality gate blocked the draft \(LINT_HOUSE_RULE_CHARACTER/);
    const later = await run(triageAnswer({ intent: "question" }), writerAnswer("Hi Jane,\n\nFine.\n\nAvery"), { now: new Date(REPLY_TEST_NOW.getTime() + 86_400_000) });
    expect(later.model.byRole("writer")).toHaveLength(0);
  });

  it("blocks a link in a reply to someone who proposed a time", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "We rerun builds daily. Does Thursday at 3pm work?" });
    const { model, result } = await run(
      triageAnswer({ intent: "interested", proposed_time: "Thursday at 3pm", problem_quote: "We rerun builds daily." }),
      writerAnswer("Hi Jane,\n\nThursday works. Book here: https://acme.example/book\n\nAvery"),
    );
    expect(JSON.stringify(model.byRole("writer")[0]?.messages)).toMatch(/invite will follow, and include no link/);
    expect(result.blocked).toBe(1);
    expect(await draftOf(inbound.id)).toBeNull();
  });

  it("never serves the commercial component, so no price reaches the writer", async () => {
    await uploadOutreachBrain(env.KV, { ...BRAIN, commercial: commercialBody });
    expect(brainFile("commercial", commercialBody)).toContain("400");
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "How much does it cost?" });
    const { model } = await run(triageAnswer({ intent: "question", confidence: 0.9 }), writerAnswer("Hi Jane,\n\nI will check and come back to you on that.\n\nAvery"));
    const system = model.byRole("writer")[0]?.system ?? "";
    expect(system).not.toContain("400");
    expect(system).not.toContain("commercial");
  });

  it("drafts nothing for the deployment's own addresses or unknown senders", async () => {
    const own = await seedReplyContact(db, { email: "sam@acme.example" });
    await seedInbound(db, env.BUCKET, { sender: own.email, contactId: own.id, body: "Can we talk?" });
    await seedInbound(db, env.BUCKET, { sender: "stranger@unknown.example", body: "Can we talk?" });
    const { model } = await run(triageAnswer({ intent: "interested" }), writerAnswer("Hi,\n\nSure, happy to talk about it soon.\n\nAvery"));
    expect(model.byRole("triage")).toHaveLength(2);
    expect(model.byRole("writer")).toHaveLength(0);
  });

  it("retries a failed writer once a day, and drafts later when drafting is turned on", async () => {
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Tell me more about it." });
    const failing = await run(triageAnswer({ intent: "warm" }), new Error("writer unavailable"));
    expect(failing.result.draftFailed).toBe(1);
    const sameDay = await run(triageAnswer({ intent: "warm" }), writerAnswer("Hi Jane,\n\nThanks, glad to share more whenever useful.\n\nAvery"));
    expect(sameDay.model.byRole("writer")).toHaveLength(0);
    const nextDay = await run(triageAnswer({ intent: "warm" }), writerAnswer("Hi Jane,\n\nThanks, glad to share more whenever useful.\n\nAvery"), { now: new Date(REPLY_TEST_NOW.getTime() + 86_400_000) });
    expect(nextDay.result.drafted).toBe(1);
    expect((await draftOf(inbound.id))?.status).toBe("pending_approval");
  });

  it("works with no KV for shown records only by refusing approvals later, never by approving blind", async () => {
    const kv = memoryKv();
    kv.failing = true;
    const contact = await seedReplyContact(db, { email: "jane@globex.example" });
    const inbound = await seedInbound(db, env.BUCKET, { sender: contact.email, contactId: contact.id, body: "Tell me more about it." });
    await run(triageAnswer({ intent: "warm" }), writerAnswer("Hi Jane,\n\nThanks, glad to share more whenever useful.\n\nAvery"), { kv });
    const draft = await draftOf(inbound.id);
    expect(draft?.status).toBe("pending_approval");
    expect(await wasShown(env.KV, draft?.id ?? "", { to: draft?.recipient_email, subject: draft?.subject, body: draft?.body })).toBe(false);
  });
});
