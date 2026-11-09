// GTM-agents: behavior evals for every outbound writer in the registry
// (packages/core/src/autonomy/writers.ts). Each writer's real code produces text for invented
// contacts, and the deterministic scorers grade it: no em or en dash, the content lint passes, no
// figure absent from what the writer was given, and length bounds. The reply drafter is a model
// writer, so a fake model stands in for it here; its prompt contract is checked as well (approved
// material only in the system prompt, the sender's text fenced in the user turn). Each suite also
// proves the scorers catch a bad output, so an eval cannot pass by scoring nothing.
//
// A class can be proposed for promotion only when every writer of it has a suite here. The writer
// modules run inside the Worker and use its binding types, so they are loaded by path at run time
// and called through small local signatures; this file then typechecks in Node like the rest of
// tests/evals. A live tier, which calls a real model for the reply drafter, runs only with
// GTM_EVAL_LIVE=1, an ANTHROPIC_API_KEY and GTM_EVAL_MODEL set, and never in CI.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTBOUND_WRITERS, WRITER_EVAL_FILE, figuresIn, scoreOutboundText } from "../../packages/core/src/autonomy/index.ts";
import { defineConfig } from "../../packages/core/src/config/define-config.ts";
import { createRotation } from "../../packages/core/src/outreach/allocate.ts";
import { WORD_BOUNDS, parseTemplate } from "../../packages/core/src/templates/index.ts";

// Writer modules, loaded by path (see the header).
const MODULES = {
  coldCompose: "../../packages/core/src/outreach/compose.ts",
  sequenceCompose: "../../packages/core/src/sequences/compose.ts",
  replyDraft: "../../packages/core/src/replies/draft.ts",
  gate: "../../packages/core/src/quality/gate.ts",
  claims: "../../packages/core/src/quality/claims.ts",
  convertDrafts: "../../packages/core/src/convert/drafts.ts",
  lifecycleRules: "../../packages/core/src/lifecycle/followup-rules.ts",
  llmGateway: "../../packages/adapters/llm-gateway/index.ts",
  adapterContext: "../../packages/core/src/adapters/context.ts",
} as const;
const load = async <T>(path: string): Promise<T> => (await import(/* @vite-ignore */ path)) as T;

interface QualityResult {
  verdict: "pass" | "hold" | "block";
  findings: Array<{ code: string; detail: string }>;
}
interface Served {
  id: string;
  meta: Record<string, unknown> & { kind: keyof typeof WORD_BOUNDS };
  subject: string;
  body: string;
  sha256: string;
}
type Composed = { status: "composed"; subject: string; body: string; result: QualityResult; template: Served } | { status: "held"; result: QualityResult };
interface ColdCompose {
  composeColdDraft(row: unknown, templates: readonly Served[], rotation: unknown, ctx: unknown): Composed;
  contactValues(row: unknown, ctx: unknown): Record<string, unknown>;
  claimSources(template: Served, values: Record<string, unknown>, ctx: unknown): string[];
}
interface SequenceCompose {
  planSteps(served: readonly Served[], steps: readonly unknown[], ctx: unknown): Map<number, { problem: string | null }>;
  composeStep(row: unknown, plan: unknown, rotation: unknown, ctx: unknown, first: { subject: string; angle: string }): Composed;
}
interface ReplyDraft {
  buildWriterSystem(config: unknown, context: unknown, links: readonly string[]): string;
  buildWriterUserTurn(input: { plan: unknown; intent: string; firstName: string | null; subject: string | null; sender: string }): string;
  planDraft(input: { intent: string; qualification: unknown; assetRequested: boolean; assets: readonly unknown[]; bookingUrl: string | undefined; answers: readonly unknown[] }): { instructions: string[]; allowedUrls: string[] };
  parseDraftOutput(answer: string): string | null;
  replyClassFor(input: { assetRequested: boolean; body: string; assetUrls: readonly string[]; bookingUrl: string | undefined; intent: string; confidence: number; factsAvailable: boolean }): string;
}
interface Gate {
  checkOutboundQuality(input: unknown): QualityResult;
  REPLY_WORD_BOUNDS: { min: number; max: number };
}
interface Claims {
  approvedClaimLines(slice: string): string[];
}
interface ConvertDrafts {
  CONVERT_DRAFT_KINDS: readonly string[];
  draftText(kind: string, ctx: { firstName: string | null; timezone: string | null; meetingStart: string; reason?: "cancelled" | "no_show" }, config: unknown): { subject: string; body: string };
  meetingDay(iso: string, timezone: string | null): string;
}

interface LifecycleRules {
  FOLLOWUP_KINDS: readonly string[];
  defaultTemplateId(kind: string): string;
  followupLinks(config: unknown, appUrl: string | undefined): { domains: string[]; exactUrls: string[] };
  composeFollowup(
    template: { subject: string; body: string },
    contact: { email: string; first_name: string | null; last_name: string | null; account_key: string | null },
    config: unknown,
    links: unknown,
  ): { status: "composed"; subject: string; body: string; quality: QualityResult } | { status: "held"; missing: string[] };
}

const BOOKING_URL = "https://acme.example/book";
const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Detects flaky tests in CI and quarantines them automatically." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    domain: "outreach.acme.example",
    bookingUrl: BOOKING_URL,
  },
});
const noBooking = defineConfig({ ...config, sending: { ...config.sending, bookingUrl: undefined } });
const FACT_LINES = ["setup-time: text: Most teams finish setup in under an hour.; value: under an hour", "read-only-access: text: Acme reads test reports only and never needs access to source code."];
const BRAIN_SLICE = ["GTM BRAIN (version test, operator-approved; task: replies)", "", "### facts (v1)", ...FACT_LINES.map((l) => `- ${l}`)].join("\n");

const templatesDir = resolve(import.meta.dirname, "../../examples/brains/acme/templates");
const served: Served[] = readdirSync(templatesDir)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((file) => parseTemplate(file, readFileSync(join(templatesDir, file), "utf8")))
  .map((t) => ({ id: String(t.meta?.id), meta: t.meta as unknown as Served["meta"], subject: t.subject, body: t.body, sha256: "0".repeat(64) }));

const contacts = [
  { id: "ct-dana", email: "dana@globex.example", first_name: "Dana", last_name: "Ito", job_title: "Platform Lead", account_key: "globex.example", account_name: "Globex", persona: "platform-champion" },
  { id: "ct-sam", email: "sam@initech.example", first_name: "Sam", last_name: "Ruiz", job_title: "VP Engineering", account_key: "initech.example", account_name: "Initech Systems", persona: "economic-buyer" },
].map((c) => ({ ...c, attributes: null, account_attributes: null, segment: null, team_size: null, email_confidence: "high", verification_status: "deliverable" }));

const composeContext = {
  config,
  copyLines: { segment: new Map<string, string>(), team_size: new Map<string, string>(), persona: new Map([["platform-champion", "Platform teams usually feel it first."]]) },
  playbooks: new Map<string, string>(),
  links: { domains: [], exactUrls: [BOOKING_URL] },
  approvedClaims: FACT_LINES,
};

const covered = new Set<string>();
const writer = (id: string, body: () => void) => {
  covered.add(id);
  describe(`writer ${id}`, body);
};

describe("the writer registry", () => {
  it("has a suite in this file for every writer that names it", () => {
    const named = OUTBOUND_WRITERS.filter((w) => w.evalFile === WRITER_EVAL_FILE).map((w) => w.id);
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(covered.has(id), id).toBe(true);
  });

  it("lists only eval files that exist", () => {
    for (const w of OUTBOUND_WRITERS) if (w.evalFile) expect(readFileSync(resolve(import.meta.dirname, "../..", w.evalFile), "utf8").length, w.id).toBeGreaterThan(0);
  });
});

describe("the scorers", () => {
  it("catch a dash, a lint block, a new figure and a length out of bounds", () => {
    const dash = String.fromCharCode(0x2014);
    const result = scoreOutboundText({ subject: "Hello", body: `Hi Dana ${dash} we cut reruns by 40% {{oops}}`, inputs: ["Hi Dana"], words: { min: 20, max: 120 } });
    expect(result.pass).toBe(false);
    expect(result.failures.join("\n")).toMatch(/house_rule_character/);
    expect(result.failures.join("\n")).toMatch(/lint: PLACEHOLDER_LEAK/);
    expect(result.failures.join("\n")).toMatch(/new_number: "40%"/);
    expect(result.failures.join("\n")).toMatch(/length/);
  });

  it("read figures with their suffix and ignore the digits in a link", () => {
    expect(figuresIn("We saw 3x fewer reruns, $2,000 saved, twelve teams. https://acme.example/2026/book")).toEqual(["3x", "2000", "twelve"]);
  });
});

writer("cold-intro", () => {
  it("renders every approved cold intro cleanly for every invented contact", async () => {
    const cold = await load<ColdCompose>(MODULES.coldCompose);
    const intros = served.filter((t) => t.meta.kind === "cold_intro");
    expect(intros.length).toBeGreaterThan(0);
    for (const contact of contacts) {
      const out = cold.composeColdDraft(contact, intros, createRotation(), composeContext);
      expect(out.status, contact.first_name).toBe("composed");
      if (out.status !== "composed") continue;
      expect(out.result.verdict, JSON.stringify(out.result.findings)).toBe("pass");
      const inputs = cold.claimSources(out.template, cold.contactValues(contact, composeContext), composeContext);
      const score = scoreOutboundText({ subject: out.subject, body: out.body, inputs, words: WORD_BOUNDS.cold_intro });
      expect(score.failures, contact.first_name).toEqual([]);
    }
  });

  it("holds a contact with no usable first name instead of guessing", async () => {
    const cold = await load<ColdCompose>(MODULES.coldCompose);
    const out = cold.composeColdDraft({ ...contacts[0], first_name: null }, served.filter((t) => t.meta.kind === "cold_intro"), createRotation(), composeContext);
    expect(out.status).toBe("held");
  });
});

writer("follow-up-steps", () => {
  it("renders every follow-up step cleanly, threaded under the first subject", async () => {
    const seq = await load<SequenceCompose>(MODULES.sequenceCompose);
    const plans = seq.planSteps(served, config.sequences.cold.steps, composeContext);
    expect([...plans.keys()].sort()).toEqual([2, 3]);
    for (const [step, plan] of plans) {
      expect(plan.problem, `step ${step}`).toBeNull();
      for (const contact of contacts) {
        const row = { ...contact, campaign_id: "camp-1", contact_id: contact.id, sequence_step: step - 1, next_send_at: null, warmth: "contacted", employment_status: null, fit_decision: null, lifecycle_state: null };
        const out = seq.composeStep(row, plan, createRotation(), composeContext, { subject: `Flaky builds at ${contact.account_name}`, angle: "none" });
        expect(out.status, `step ${step} for ${contact.first_name}`).toBe("composed");
        if (out.status !== "composed") continue;
        expect(out.subject).toBe(`Re: Flaky builds at ${contact.account_name}`);
        expect(out.result.verdict, JSON.stringify(out.result.findings)).toBe("pass");
        const inputs = [out.template.subject, out.template.body, contact.first_name, contact.account_name, `Flaky builds at ${contact.account_name}`, config.agent.name, BOOKING_URL];
        expect(scoreOutboundText({ subject: out.subject, body: out.body, inputs, words: WORD_BOUNDS[out.template.meta.kind] }).failures).toEqual([]);
      }
    }
  });
});

writer("reply-drafter", () => {
  const SENDER = "Thanks for the note. We rerun builds every day and it hurts. Happy to chat, can you send me a way to book a call?";
  const assets = [{ id: "asset-1", kind: "demo", title: "A two minute walkthrough", url: "https://acme.example/demo" }];
  const bookQualification = { status: "book", gaps: [], roleFit: "keep: platform-champion", icpFit: "fit", problemQuote: "We rerun builds every day", timing: null, meetingRequested: true, proposedTime: null, rule: "They are ready to meet: offer a short call and the booking link." };

  /** A fake writer that follows its instructions: it greets by the CRM name, answers from the facts, and uses only the links it was given. */
  function fakeWriter(system: string, user: string): string {
    const name = /Their first name, from the CRM: ([^.]+)\./.exec(user)?.[1] ?? "there";
    const assetLink = /exactly as written[^:\n]*: (https:\/\/\S+)/.exec(user)?.[1];
    const bookingLink = /^- booking: (https:\/\/\S+)$/m.exec(system)?.[1];
    const giveLink = assetLink ?? (/booking link/.test(user) ? bookingLink : undefined);
    const answer = /Answer their question first/.test(user) ? "Most teams finish setup in under an hour, and Acme reads test reports only." : "Thanks for writing back, glad the rerun problem resonates.";
    return JSON.stringify({ body: [`Hi ${name},`, "", answer, giveLink ? `${assetLink ? "Here it is" : "You can pick a time that suits you here"}: ${giveLink}` : "Happy to set up a short call whenever suits you.", "", "Avery"].join("\n") });
  }

  async function draft(intent: string, qualification: unknown, options: { assetRequested?: boolean; writer?: (system: string, user: string) => string } = {}) {
    const reply = await load<ReplyDraft>(MODULES.replyDraft);
    const gate = await load<Gate>(MODULES.gate);
    const claims = await load<Claims>(MODULES.claims);
    const plan = reply.planDraft({ intent, qualification, assetRequested: options.assetRequested ?? false, assets, bookingUrl: BOOKING_URL, answers: [] });
    const links = [...assets.map((a) => `${a.kind}: ${a.title}: ${a.url}`), `booking: ${BOOKING_URL}`];
    const system = reply.buildWriterSystem(config, { brain: { text: BRAIN_SLICE, included: ["facts"] }, objections: [], assets }, links);
    const user = reply.buildWriterUserTurn({ plan, intent, firstName: "Jane", subject: "Re: Flaky builds at Globex", sender: SENDER });
    const body = reply.parseDraftOutput((options.writer ?? fakeWriter)(system, user));
    const quality = body
      ? gate.checkOutboundQuality({
          kind: "reply",
          subject: "Re: Flaky builds at Globex",
          body,
          recipient: "jane@globex.example",
          contact: { email: "jane@globex.example", firstName: "Jane", accountName: "Globex", accountKey: "globex.example" },
          links: { domains: [], exactUrls: [...plan.allowedUrls, ...assets.map((a) => a.url), BOOKING_URL] },
          claimSources: [...claims.approvedClaimLines(BRAIN_SLICE), config.company.product.description],
        })
      : null;
    const inputs = [system, plan.instructions.join("\n"), "Jane", config.agent.name];
    return { reply, gate, system, user, body, quality, plan, inputs };
  }

  it("keeps the sender's text out of the system prompt and fences it in the user turn", async () => {
    const { system, user } = await draft("interested", bookQualification);
    expect(system).not.toContain("rerun builds every day");
    expect(system).toContain("Most teams finish setup in under an hour");
    expect(user).toContain("rerun builds every day");
    expect(user.indexOf("rerun builds every day")).toBeGreaterThan(user.indexOf("The message you are answering:"));
  });

  it("writes a booking reply that passes the gate and every scorer, filed under reply_send", async () => {
    const { reply, gate, body, quality, inputs } = await draft("interested", bookQualification);
    expect(body).toContain(BOOKING_URL);
    expect(quality?.verdict, JSON.stringify(quality?.findings)).toBe("pass");
    expect(scoreOutboundText({ subject: "Re: Flaky builds at Globex", body: body ?? "", inputs, words: gate.REPLY_WORD_BOUNDS }).failures).toEqual([]);
    expect(reply.replyClassFor({ assetRequested: false, body: body ?? "", assetUrls: assets.map((a) => a.url), bookingUrl: BOOKING_URL, intent: "interested", confidence: 0.9, factsAvailable: true })).toBe("reply_send");
  });

  it("writes a demo-link reply for someone who asked to see the product, filed under reply_demo_link", async () => {
    const { reply, gate, body, quality, inputs } = await draft("interested", bookQualification, { assetRequested: true });
    expect(body).toContain("https://acme.example/demo");
    expect(quality?.verdict).toBe("pass");
    expect(scoreOutboundText({ subject: "Re: Flaky builds at Globex", body: body ?? "", inputs, words: gate.REPLY_WORD_BOUNDS }).failures).toEqual([]);
    expect(reply.replyClassFor({ assetRequested: true, body: body ?? "", assetUrls: assets.map((a) => a.url), bookingUrl: BOOKING_URL, intent: "interested", confidence: 0.9, factsAvailable: true })).toBe("reply_demo_link");
  });

  it("answers a question from the approved facts only", async () => {
    const { gate, body, quality, inputs } = await draft("question", null);
    expect(body).toMatch(/under an hour/);
    expect(quality?.verdict).toBe("pass");
    expect(scoreOutboundText({ subject: "Re: Flaky builds at Globex", body: body ?? "", inputs, words: gate.REPLY_WORD_BOUNDS }).failures).toEqual([]);
  });

  it("catches a writer that invents a figure, adds a link or breaks the house rules", async () => {
    const dash = String.fromCharCode(0x2013);
    const bad = await draft("interested", bookQualification, { writer: () => JSON.stringify({ body: `Hi Jane,\n\nTeams cut reruns by 70% ${dash} see https://elsewhere.example/proof\n\nAvery` }) });
    const score = scoreOutboundText({ subject: "Re: Flaky builds at Globex", body: bad.body ?? "", inputs: bad.inputs, words: bad.gate.REPLY_WORD_BOUNDS });
    expect(score.failures.join("\n")).toMatch(/new_number: "70%"/);
    expect(score.failures.join("\n")).toMatch(/house_rule_character/);
    expect(bad.quality?.verdict).not.toBe("pass");
    expect(bad.quality?.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["LINT_HOUSE_RULE_CHARACTER", "LINK_NOT_ALLOWED", "UNAPPROVED_CLAIM"]));
  });

  it("drops a malformed answer instead of guessing", async () => {
    const { body } = await draft("interested", bookQualification, { writer: () => "Sure! Here is my reply." });
    expect(body).toBeNull();
  });

  const LIVE = process.env.GTM_EVAL_LIVE === "1" && !process.env.CI && Boolean(process.env.ANTHROPIC_API_KEY) && Boolean(process.env.GTM_EVAL_MODEL);
  describe.skipIf(!LIVE)("live tier (a real model; never in CI)", () => {
    it("writes a booking reply that passes the gate and every scorer", { timeout: 60_000 }, async () => {
      const { createAdapter } = await load<{ createAdapter: (ctx: unknown) => { complete: (request: unknown) => Promise<{ text: string }> } }>(MODULES.llmGateway);
      const { createAdapterContext } = await load<{ createAdapterContext: (options: unknown) => unknown }>(MODULES.adapterContext);
      const gateway = createAdapter(createAdapterContext({ name: "llm-gateway", env: process.env }));
      let prompts = { system: "", user: "" };
      await draft("interested", bookQualification, {
        writer: (system, user) => {
          prompts = { system, user };
          return "{}";
        },
      });
      const result = await gateway.complete({ role: "writer", model: process.env.GTM_EVAL_MODEL, system: prompts.system, messages: [{ role: "user", content: prompts.user }], maxTokens: 700, temperature: 0 });
      const live = await draft("interested", bookQualification, { writer: () => result.text });
      expect(live.body).not.toBeNull();
      expect(live.quality?.verdict).not.toBe("block");
      expect(scoreOutboundText({ subject: "Re: Flaky builds at Globex", body: live.body ?? "", inputs: live.inputs, words: live.gate.REPLY_WORD_BOUNDS }).failures).toEqual([]);
    });
  });
});

const meetingWriter = (id: string, kinds: readonly string[]) =>
  writer(id, () => {
    it(`writes ${kinds.join(" and ")} cleanly, with and without a booking URL and a time zone`, async () => {
      const convert = await load<ConvertDrafts>(MODULES.convertDrafts);
      for (const kind of kinds) {
        for (const cfg of [config, noBooking]) {
          for (const ctx of [
            { firstName: "Dana", timezone: "America/New_York", meetingStart: "2026-11-03T15:00:00.000Z" },
            { firstName: null, timezone: null, meetingStart: "2026-11-03T15:00:00.000Z", reason: "no_show" as const },
            { firstName: "Sam", timezone: "Not/AZone", meetingStart: "2026-11-02T09:30:00.000Z", reason: "cancelled" as const },
          ]) {
            const text = convert.draftText(kind, ctx, cfg);
            // The writer's own fixed copy, rendered for a reference meeting on another day, plus this
            // contact's values: anything else in the text came from somewhere it should not.
            const fixed = convert.draftText(kind, { firstName: "Reference", timezone: null, meetingStart: "2026-01-20T12:00:00.000Z", ...(ctx.reason ? { reason: ctx.reason } : {}) }, cfg);
            const inputs = [fixed.subject, fixed.body.replace(convert.meetingDay("2026-01-20T12:00:00.000Z", null), ""), convert.meetingDay(ctx.meetingStart, ctx.timezone), ctx.firstName ?? "", cfg.agent.name, cfg.company.product.name, cfg.sending.bookingUrl ?? ""];
            expect(scoreOutboundText({ subject: text.subject, body: text.body, inputs, words: { min: 15, max: 140 } }).failures, `${kind} ${ctx.firstName}`).toEqual([]);
            for (const link of text.body.match(/https?:\/\/\S+/g) ?? []) expect(link).toBe(BOOKING_URL);
          }
        }
      }
    });
  });

meetingWriter("meeting-recap", ["recap"]);
meetingWriter("meeting-rebook", ["rebook"]);
meetingWriter("post-demo-follow-ups", ["step2", "step3"]);

// Lifecycle follow-ups: the writer only fills the operator's approved template with the contact's
// own name, the agent's name and the booking URL. These templates are invented for the eval.
const LIFECYCLE_TEMPLATES: Record<string, { subject: string; body: string }> = {
  first_use: { subject: "Getting started with Acme Quarantine", body: "Hi {{first_name}},\n\nThanks for signing up for Acme Quarantine. The quickest way to see it work is to connect one CI pipeline and let it watch a few runs.\n\nIf anything gets in the way, reply here and I will help.\n\n{{sender_name}}" },
  usefulness: { subject: "Was it useful?", body: "Hi {{first_name}},\n\nI saw your team has started using Acme Quarantine. Was it useful so far, and is there anything that got in the way?\n\nA one-line reply is plenty.\n\n{{sender_name}}" },
  win_back: { subject: "Picking things back up", body: "Hi {{first_name}},\n\nIt has been a while since you canceled. If flaky tests are slowing your team down again, I would be glad to help you pick things back up.\n\nIf a short call would help, you can pick a time here: {{booking_url}}\n\n{{sender_name}}" },
};

writer("lifecycle-follow-ups", () => {
  it("fills approved lifecycle templates cleanly, and holds rather than guess a missing name", async () => {
    const rules = await load<LifecycleRules>(MODULES.lifecycleRules);
    const links = rules.followupLinks(config, "https://app.acme.example");
    for (const [kind, tpl] of Object.entries(LIFECYCLE_TEMPLATES)) {
      expect(rules.FOLLOWUP_KINDS, kind).toContain(kind);
      expect(rules.defaultTemplateId(kind)).toBe(`lifecycle-${kind.replace(/_/g, "-")}`);
      for (const contact of contacts) {
        const composed = rules.composeFollowup(tpl, { email: contact.email, first_name: contact.first_name, last_name: contact.last_name, account_key: contact.account_key }, config, links);
        expect(composed.status, `${kind} ${contact.id}`).toBe("composed");
        if (composed.status !== "composed") continue;
        expect(composed.quality.verdict, `${kind} ${contact.id}: ${composed.quality.findings.map((f) => f.code).join(", ")}`).toBe("pass");
        const inputs = [tpl.subject, tpl.body, contact.first_name, contact.last_name, config.agent.name, config.company.product.name, BOOKING_URL];
        expect(scoreOutboundText({ subject: composed.subject, body: composed.body, inputs, words: WORD_BOUNDS.lifecycle }).failures, `${kind} ${contact.id}`).toEqual([]);
        for (const link of composed.body.match(/https?:\/\/\S+/g) ?? []) expect(link).toBe(BOOKING_URL);
      }
      const nameless = rules.composeFollowup(tpl, { email: "ops@globex.example", first_name: "ops2", last_name: null, account_key: "globex.example" }, config, links);
      expect(nameless).toEqual({ status: "held", missing: ["first_name"] });
    }
  });

  it("is caught by the scorers when its output is bad", async () => {
    const rules = await load<LifecycleRules>(MODULES.lifecycleRules);
    const bad = rules.composeFollowup({ subject: "Big news", body: "Hi {{first_name}},\n\nTeams save 40% of CI time with us \u2014 upgrade today at https://deals.example/now.\n\n{{sender_name}}" }, { email: "dana@globex.example", first_name: "Dana", last_name: null, account_key: "globex.example" }, config, rules.followupLinks(config, undefined));
    expect(bad.status).toBe("composed");
    if (bad.status !== "composed") return;
    expect(bad.quality.verdict).not.toBe("pass");
    expect(scoreOutboundText({ subject: bad.subject, body: bad.body, inputs: ["Big news"], words: WORD_BOUNDS.lifecycle }).failures.length).toBeGreaterThan(0);
  });
});
