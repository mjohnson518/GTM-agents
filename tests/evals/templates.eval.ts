// GTM-agents: behavior eval for operator templates. Renders every template in the example brain for
// synthetic contacts and scores the result the way a send-time gate would: no unresolved
// placeholders, no em or en dashes, word and subject bounds, a question in a cold intro, at most one
// exclamation mark, and no link except the configured booking URL. A contact missing a variable the
// template needs must be held, never filled with a guess.
//
// The lifecycle templates are also run through the lifecycle follow-up writer itself
// (lifecycle/followup-rules.ts): there is one for every template id the follow-up rules reference,
// each uses only the variables that writer fills, passes the deterministic quality gate as rendered,
// states no figure (so never a price), and only the offer kinds, which stay permanently human, use
// offer words. The writer module runs in the Worker and uses its binding types, so it is loaded by
// path and called through a small local signature; this file then typechecks in Node.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../../packages/core/src/config/define-config.ts";
import { checkClaims } from "../../packages/core/src/quality/claims.ts";
import { SUBJECT_MAX, WORD_BOUNDS, countWords, parseTemplate, renderTemplate, variablesIn } from "../../packages/core/src/templates/index.ts";

const dir = resolve(import.meta.dirname, "../../examples/brains/acme/templates");
const templates = readdirSync(dir)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((file) => parseTemplate(file, readFileSync(join(dir, file), "utf8")));

const BOOKING_URL = "https://acme.example/book";

const contacts = [
  { first_name: "Dana", account_name: "Globex", persona_line: "Platform teams usually feel it first." },
  { first_name: "Sam", account_name: "Initech Systems", persona_line: undefined },
].map((c) => ({ ...c, sender_name: "Avery", booking_url: BOOKING_URL, original_subject: "Flaky builds at " + c.account_name }));

describe("example templates render cleanly for every synthetic contact", () => {
  it("has the three-step sequence and the lifecycle follow-ups", () => {
    const kinds = templates.map((t) => t.meta?.kind);
    expect(kinds.filter((k) => k !== "lifecycle").sort()).toEqual(["breakup", "cold_intro", "follow_up"]);
    expect(kinds.filter((k) => k === "lifecycle").length).toBeGreaterThan(0);
  });

  for (const template of templates) {
    for (const contact of contacts) {
      it(`${template.file} for ${contact.first_name}`, () => {
        const meta = template.meta;
        expect(meta).toBeDefined();
        if (!meta) return;
        const result = renderTemplate(template, contact);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const text = `${result.subject}\n${result.body}`;

        expect(text).not.toMatch(/\{\{|\}\}/);
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(result.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
        const words = countWords(result.body);
        expect(words).toBeGreaterThanOrEqual(WORD_BOUNDS[meta.kind].min);
        expect(words).toBeLessThanOrEqual(WORD_BOUNDS[meta.kind].max);
        expect((text.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
        if (meta.kind === "cold_intro") expect(result.body).toContain("?");
        for (const link of text.match(/https?:\/\/\S+/g) ?? []) expect(link).toBe(BOOKING_URL);
        expect(result.body).toContain(`Hi ${contact.first_name},`);
      });
    }
  }

  it("holds a draft for a contact without a first name instead of guessing a greeting", () => {
    for (const template of templates) {
      const result = renderTemplate(template, { ...contacts[0], first_name: undefined });
      expect(result).toEqual({ ok: false, missing: ["first_name"] });
    }
  });
});

// The lifecycle writer, loaded by path (see the header).
interface QualityResult {
  verdict: "pass" | "hold" | "block";
  findings: Array<{ code: string; detail: string }>;
}
interface LifecycleRules {
  FOLLOWUP_KINDS: readonly string[];
  FOLLOWUP_RULES: Record<string, { actionClass: string; offer: boolean }>;
  defaultTemplateId(kind: string): string;
  followupLinks(config: unknown, appUrl: string | undefined): { domains: string[]; exactUrls: string[] };
  composeFollowup(
    template: { subject: string; body: string },
    contact: { email: string; first_name: string | null; last_name: string | null; account_key: string | null },
    config: unknown,
    links: unknown,
  ): { status: "composed"; subject: string; body: string; quality: QualityResult } | { status: "held"; missing: string[] };
}
const LIFECYCLE_RULES: string = "../../packages/core/src/lifecycle/followup-rules.ts";
const rules = (await import(/* @vite-ignore */ LIFECYCLE_RULES)) as LifecycleRules;

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
const people = [
  { email: "dana@globex.example", first_name: "Dana", last_name: "Ito", account_key: "globex.example" },
  { email: "sam@initech.example", first_name: "Sam", last_name: null, account_key: "initech.example" },
];
/** The only variables the lifecycle writer fills. Anything else would hold every follow-up. */
const WRITER_VARIABLES = new Set(["first_name", "last_name", "sender_name", "booking_url"]);
const lifecycle = new Map(templates.filter((t) => t.meta?.kind === "lifecycle").map((t) => [t.meta?.id ?? "", t]));

describe("lifecycle templates fit the follow-up writer", () => {
  it("exist, approved, for every template id the follow-up rules reference, and for nothing else", () => {
    const ids = rules.FOLLOWUP_KINDS.map((kind) => rules.defaultTemplateId(kind));
    for (const id of ids) {
      expect(lifecycle.has(id), id).toBe(true);
      expect(lifecycle.get(id)?.meta?.status, id).toBe("approved");
    }
    expect([...lifecycle.keys()].sort()).toEqual([...ids].sort());
  });

  for (const kind of rules.FOLLOWUP_KINDS) {
    const id = rules.defaultTemplateId(kind);
    it(`${id} passes the quality gate as the writer renders it, and states no figure`, () => {
      const template = lifecycle.get(id);
      expect(template).toBeDefined();
      if (!template) return;
      for (const name of [...variablesIn(template.subject), ...variablesIn(template.body)]) expect(WRITER_VARIABLES.has(name), `${id} uses {{${name}}}`).toBe(true);
      // No digits: a lifecycle template never quotes a price, a plan size or an invented number.
      expect(`${template.subject}\n${template.body}`).not.toMatch(/\d/);
      const links = rules.followupLinks(config, "https://app.acme.example");
      for (const person of people) {
        const composed = rules.composeFollowup(template, person, config, links);
        expect(composed.status, `${id} for ${person.email}`).toBe("composed");
        if (composed.status !== "composed") continue;
        expect(composed.quality.verdict, `${id}: ${composed.quality.findings.map((f) => f.code).join(", ")}`).toBe("pass");
        expect(composed.body.startsWith(`Hi ${person.first_name},`)).toBe(true);
        for (const link of composed.body.match(/https?:\/\/\S+/g) ?? []) expect(link).toBe(BOOKING_URL);
      }
      const nameless = rules.composeFollowup(template, { email: "ops@globex.example", first_name: null, last_name: null, account_key: "globex.example" }, config, links);
      expect(nameless).toEqual({ status: "held", missing: ["first_name"] });
    });
  }

  it("uses offer words only in the offer kinds, which stay permanently human", () => {
    for (const kind of rules.FOLLOWUP_KINDS) {
      const rule = rules.FOLLOWUP_RULES[kind];
      const template = lifecycle.get(rules.defaultTemplateId(kind));
      if (!rule || !template) throw new Error(`no rule or template for ${kind}`);
      // With only the names as approved sources, the claims check flags any figure, offer word or
      // customer claim the copy makes on its own.
      const own = checkClaims(`${template.subject}\n${template.body}`, ["Acme", "Acme Quarantine", "Avery"]);
      if (rule.offer) {
        expect(rule.actionClass, kind).toBe("offers");
        expect(own.ok, kind).toBe(false);
      } else {
        expect(own, kind).toEqual({ ok: true });
      }
    }
  });
});
